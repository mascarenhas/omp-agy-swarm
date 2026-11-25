// A real omp TUI in a pseudo-terminal (H22) against the scripted mock provider.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { encodeTspJson, parseTspApc, TspChunkReader, type TspHelloReply } from "@oh-my-pi/pi-tui/native/apc";
import { TSP_APC_ID, TSP_KINDS, TSP_VERSION, type TspClose, type TspEvent, type TspFrame, type TspKind, type TspNode, type TspOpen } from "@oh-my-pi/pi-wire";
import { resolveOmpBin, stripNodeModulesBins } from "../../scripts/omp-bin.ts";
import { listeningSockets } from "../e2e/check.ts";
import { MockLlm, type Script } from "../e2e/mock-llm/server.ts";
import { REPO } from "./harness.ts";

const PROVIDER = join(REPO, "test", "e2e", "mock-llm", "provider.ts");
const TSP_PREFIX = `\x1b_${TSP_APC_ID};`;
const TSP_OR_QUERY = new RegExp(`${TSP_PREFIX}|\\x1b\\[(?:0?c|6n)`, "g");

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control stripping
const ANSI = /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][^\u001b]*\u001b\\|\u001b[=>()][0-9A-Za-z]?/g;

interface NativeTestSession {
	/** Using an id first seeds and resumes an on-disk session through a path alias. */
	id?: string;
	kinds?: readonly TspKind[];
	apc?: number;
}

interface PeerNode {
	id: string;
	k: TspKind;
	p?: Record<string, unknown>;
	c: PeerNode[];
}

/** Replay 19.2's actual wire IDs and layer hoists. Debug `doc` has only key-based region arrays. */
class PeerDocument {
	readonly root: PeerNode;
	readonly #nodes = new Map<string, PeerNode>();
	readonly #parents = new Map<string, PeerNode>();

	constructor(id: string) {
		this.root = this.#index({ id, k: "col" });
	}

	#index(node: TspNode): PeerNode {
		const copy: PeerNode = { id: node.id, k: node.k, ...(node.p && { p: { ...node.p } }), c: [] };
		this.#nodes.set(node.id, copy);
		for (const child of node.c ?? []) {
			copy.c.push(this.#index(child));
			this.#parents.set(child.id, copy);
		}
		return copy;
	}

	#detach(id: string): PeerNode | undefined {
		const node = this.#nodes.get(id);
		const parent = this.#parents.get(id);
		if (!node || !parent) return node;
		parent.c.splice(parent.c.indexOf(node), 1);
		this.#parents.delete(id);
		return node;
	}

	#drop(node: PeerNode): void {
		for (const child of node.c) this.#drop(child);
		this.#nodes.delete(node.id);
		this.#parents.delete(node.id);
	}

	remove(id: string): void {
		const node = this.#detach(id);
		if (node) this.#drop(node);
	}

	frame({ ops }: TspFrame): void {
		for (const op of ops) {
			switch (op[0]) {
				case "add":
				case "move": {
					const [, id, parentId, before] = op;
					const parent = this.#nodes.get(parentId);
					if (!parent) throw new Error(`Unknown native parent: ${parentId}`);
					const child = op[0] === "add" ? this.#index(op[4]) : this.#detach(id);
					if (!child) throw new Error(`Unknown native child: ${id}`);
					const at = before === null ? parent.c.length : parent.c.findIndex(n => n.id === before);
					if (at < 0) throw new Error(`Unknown native sibling: ${before}`);
					parent.c.splice(at, 0, child);
					this.#parents.set(id, parent);
					break;
				}
				case "del":
					this.remove(op[1]);
					break;
				case "set":
				case "text":
				case "splice": {
					const node = this.#nodes.get(op[1]);
					if (!node) throw new Error(`Unknown native update target: ${op[1]}`);
					const props = node.p ??= {};
					const text = typeof props.text === "string" ? props.text : "";
					if (op[0] === "text") props.text = op[2] === "append" ? text + op[3] : op[3];
					else if (op[0] === "splice") props.text = text.slice(0, op[2]) + op[4] + text.slice(op[2] + op[3]);
					else for (const [key, value] of Object.entries(op[2])) {
						if (value === null) delete props[key];
						else props[key] = value;
					}
					break;
				}
			}
		}
	}
}

function countRows(node: TspNode): number {
	let count = Number(node.k === "rows");
	for (const child of node.c ?? []) count += countRows(child);
	return count;
}

/** Terminal-side TSP simulation, before any ANSI interpretation or stripping. */
export class NativePeer {
	readonly opens: TspOpen[] = [];
	readonly closes: TspClose[] = [];
	readonly lastAck = new Map<string, number>();
	readonly #hello: string;
	readonly #decoder = new TextDecoder();
	readonly #chunks = new TspChunkReader();
	readonly #docs = new Map<string, PeerDocument>();
	readonly #open = new Set<string>();
	#carry = "";

	constructor(options: NativeTestSession, cols: number) {
		const hello: TspHelloReply = { r: "hello", v: TSP_VERSION, term: "test", kinds: options.kinds ?? TSP_KINDS,
			features: ["tray", "edit", "undo", "send", "scroll"], cols, apc: options.apc ?? 1_048_576, dark: true, credits: 8 };
		this.#hello = encodeTspJson("r", hello);
	}

	document(): TspNode | undefined {
		const id = [...this.#open].at(-1);
		return id ? this.#docs.get(id)?.root as TspNode | undefined : undefined;
	}

	read(data: Uint8Array, reply: (s: string) => void): void {
		const stream = this.#carry + this.#decoder.decode(data, { stream: true });
		const tokens = new RegExp(TSP_OR_QUERY);
		const keep = TSP_PREFIX.length - 1;
		this.#carry = stream.slice(-keep);
		for (let token = tokens.exec(stream); token; token = tokens.exec(stream)) {
			if (token[0] !== TSP_PREFIX) {
				reply(token[0] === "\x1b[6n" ? "\x1b[1;1R" : "\x1b[?62;22c");
				this.#carry = stream.slice(Math.max(tokens.lastIndex, stream.length - keep));
				continue;
			}
			const end = stream.indexOf("\x1b\\", tokens.lastIndex);
			if (end < 0) {
				this.#carry = stream.slice(token.index);
				return;
			}
			const chunk = parseTspApc(stream.slice(token.index, end + 2));
			tokens.lastIndex = end + 2;
			this.#carry = stream.slice(Math.max(tokens.lastIndex, stream.length - keep));
			const packet = chunk && this.#chunks.feed(chunk);
			if (!packet) continue;
			const { verb, body } = packet;
			if (verb === "q") {
				const query = JSON.parse(body) as { q: string };
				if (query.q === "hello") reply(this.#hello);
			} else if (verb === "f") {
				const frame = JSON.parse(body) as TspFrame;
				this.#docs.get(frame.sf)?.frame(frame);
				reply(encodeTspJson("e", { ev: "ack", sf: frame.sf, s: frame.s }));
				this.lastAck.set(frame.sf, frame.s);
			} else if (verb === "o") {
				const open = JSON.parse(body) as TspOpen;
				this.opens.push(open);
				if (!open.adopt || !this.#docs.has(open.id)) this.#docs.set(open.id, new PeerDocument(open.id));
				this.#open.add(open.id);
			} else if (verb === "x") {
				const close = JSON.parse(body) as TspClose;
				this.closes.push(close);
				this.#open.delete(close.id);
				if (!close.keep) this.#docs.delete(close.id);
				else {
					this.#docs.get(close.id)?.remove("dock");
					this.#docs.get(close.id)?.remove("layer");
				}
			}
		}
	}
}

interface NativeWireDocument {
	doc: TspNode;
	rows: number;
}

/** An opt-in real launch uses the caller's paths/args/env and never starts a mock. */
interface ExplicitLaunch {
	root: string;
	cwd: string;
	argv: string[];
	env: NodeJS.ProcessEnv;
}

export class PtyOmp {
	readonly root: string;
	readonly swarm: string;
	readonly #mock: MockLlm | undefined;
	readonly resumeFile: string | undefined;
	readonly debugSocket: string | undefined;
	readonly native: NativePeer | undefined;
	readonly proc: ReturnType<typeof Bun.spawn>;
	#raw = Buffer.alloc(0);
	#mark = 0;

	constructor(script: Script, cols?: number, rows?: number, env?: Record<string, string>, persist?: boolean | NativeTestSession);
	constructor(launch: ExplicitLaunch, cols?: number, rows?: number);
	constructor(script: Script | ExplicitLaunch, cols = 80, rows = 24, env: Record<string, string> = {}, persist: boolean | NativeTestSession = false) {
		const launch = "argv" in script && Array.isArray(script.argv) ? script as ExplicitLaunch : undefined;
		this.root = launch?.root ?? mkdtempSync(join(tmpdir(), "omp-swarm-pty-"));
		const work = launch?.cwd ?? join(this.root, "work");
		if (!launch) {
			mkdirSync(work);
			execFileSync("git", ["-C", work, "init", "-q"]);
		}
		const agent = join(this.root, "agent");
		if (!launch) {
			mkdirSync(agent);
			// No first-run wizard, splash or update check in the isolated agent dir; fast retries.
			writeFileSync(
				join(agent, "config.yml"),
				"startup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nretry:\n  maxRetries: 1\n  baseDelayMs: 20\n",
			);
		}
		this.swarm = join(this.root, "swarm");
		const home = join(this.root, "home");
		if (!launch) mkdirSync(home);
		const native = typeof persist === "object" ? persist : undefined;
		const cliArgs: string[] = persist === true || native?.id ? [] : ["--no-session"];
		if (native) {
			this.native = new NativePeer(native, cols);
			this.debugSocket = join(this.root, "tui.sock");
		}
		if (native?.id) {
			const real = join(this.root, "real-sessions");
			const alias = join(this.root, "session-alias");
			mkdirSync(real);
			symlinkSync(real, alias, "dir");
			const timestamp = new Date().toISOString();
			this.resumeFile = join(alias, `${timestamp.replace(/[:.]/g, "-")}_${native.id}.jsonl`);
			writeFileSync(this.resumeFile, [
				{ type: "session", version: 3, id: native.id, timestamp, cwd: work },
				{ type: "message", id: "01", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Seeded resumed Main transcript" }], timestamp: Date.now() } },
			].map(entry => JSON.stringify(entry)).join("\n") + "\n");
			cliArgs.push("--session", this.resumeFile, "--session-dir", alias);
		}
		const childEnv: Record<string, string | undefined> = launch ? { ...launch.env, TERM: "xterm-256color", TERM_PROGRAM: "" } : {
			...process.env,
			PATH: stripNodeModulesBins(process.env.PATH),
			TERM: "xterm-256color",
			MOCK_PORT: "",
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: ".omp",
			OMP_PROFILE: "",
			PI_PROFILE: "",
			HOME: home,
			XDG_CONFIG_HOME: join(home, "config"),
			XDG_DATA_HOME: join(home, "data"),
			XDG_STATE_HOME: join(home, "state"),
			XDG_CACHE_HOME: join(home, "cache"),
			OMP_SWARM_DIR: this.swarm,
			...env,
		};
		if (persist === true || native?.id) delete childEnv.OMP_SWARM_DIR;
		if (!launch) {
			delete childEnv.TMUX;
			delete childEnv.TMUX_PANE;
			delete childEnv.PI_TUI_NATIVE;
			childEnv.TERM_PROGRAM = "";
			delete childEnv.OMP_TUI_DEBUG;
		}
		if (native) {
			childEnv.PI_TUI_NATIVE = "1";
			childEnv.OMP_TUI_DEBUG = this.debugSocket;
		}
		if (!launch) {
			this.#mock = new MockLlm(script as Script, join(this.root, "mock.jsonl"));
			childEnv.MOCK_PORT = String(this.#mock.start());
		}
		this.proc = Bun.spawn(
			launch?.argv ?? [resolveOmpBin(), "--model", "mock/coord", "--thinking", "low", ...cliArgs, "--no-extensions", "--no-title", "-e", REPO, "-e", PROVIDER],
			{
				cwd: work,
				env: childEnv,
				terminal: {
					cols,
					rows,
					data: (term, data) => {
						this.#raw = Buffer.concat([this.#raw, Buffer.from(data)]);
						if (this.native) {
							this.native.read(data, s => term.write(s));
							return;
						}
						const s = Buffer.from(data).toString("latin1");
						// Minimal answers to terminal queries (device attributes, cursor position).
						if (s.includes("\x1b[c") || s.includes("\x1b[0c")) term.write("\x1b[?62;22c");
						if (s.includes("\x1b[6n")) term.write("\x1b[1;1R");
					},
				},
			},
		);
	}

	debug(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.debugSocket) throw new Error("TUI debug socket was not enabled");
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		const socket = connect(this.debugSocket);
		let pending = "";
		socket.setEncoding("utf8");
		socket.on("error", reject);
		socket.on("end", () => reject(new Error("TUI debug socket closed without a reply")));
		socket.setTimeout(2000, () => socket.destroy(new Error("TUI debug reply timed out")));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", data => {
			pending += data;
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			socket.destroy();
			try { resolve(JSON.parse(pending.slice(0, newline)) as Record<string, unknown>); } catch (err) { reject(err); }
		});
		return promise;
	}

	async waitForNative(pred: (doc: TspNode | undefined, rows: number | undefined) => boolean, what: string, ms = 15_000): Promise<NativeWireDocument> {
		const peer = this.native;
		if (!peer) throw new Error("The PTY does not have a native peer");
		const end = Date.now() + ms;
		while (Date.now() < end && this.proc.exitCode === null) {
			const doc = peer.document();
			if (doc) {
				const rows = countRows(doc);
				if (pred(doc, rows)) return { doc: structuredClone(doc), rows };
			}
			await Bun.sleep(25);
		}
		throw new Error(`timed out waiting for ${what} on the native surface (exit ${this.proc.exitCode})`);
	}

	nativeEvent(event: TspEvent): void {
		if (!this.native) throw new Error("The PTY does not have a native peer");
		this.write(encodeTspJson("e", event));
	}

	get mock(): MockLlm {
		if (!this.#mock) throw new Error("explicit PTY launches do not have a mock provider");
		return this.#mock;
	}

	get raw(): string {
		return this.#raw.toString("utf8");
	}

	/** Plain text (ANSI stripped) of everything since the last mark. */
	since(): string {
		return this.#raw.subarray(this.#mark).toString("utf8").replace(ANSI, "");
	}

	rawSince(): string {
		return this.#raw.subarray(this.#mark).toString("utf8");
	}

	mark(): void {
		this.#mark = this.#raw.length;
	}

	write(s: string): void {
		this.proc.terminal?.write(s);
	}

	/** Types like a person (one key at a time) so the editor sees keystrokes, not a paste. */
	async type(s: string): Promise<void> {
		for (const ch of s) {
			this.write(ch);
			await Bun.sleep(15); // real keystroke pacing: the TUI distinguishes typing from a paste
		}
	}

	resize(cols: number, rows: number): void {
		this.proc.terminal?.resize(cols, rows);
	}

	listeners(): number {
		return listeningSockets(this.proc.pid);
	}

	/** Polls until `pred` holds on the output since the mark. */
	async waitFor(pred: (text: string, raw: string) => boolean, ms = 15_000, what = "output"): Promise<void> {
		const end = Date.now() + ms;
		while (!pred(this.since(), this.rawSince())) {
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}; tail: ${JSON.stringify(this.since().slice(-600))}`);
			await Bun.sleep(25);
		}
	}

	async close(): Promise<void> {
		try {
			this.proc.kill("SIGTERM");
		} catch {}
		await Promise.race([this.proc.exited, Bun.sleep(3000)]);
		try {
			this.proc.kill("SIGKILL");
		} catch {}
		this.proc.terminal?.close();
		if (this.#mock) {
			this.#mock.stop();
			if (process.env.PTY_KEEP) writeFileSync(join(this.root, "raw.txt"), this.#raw);
			else rmSync(this.root, { recursive: true, force: true });
		}
	}
}
