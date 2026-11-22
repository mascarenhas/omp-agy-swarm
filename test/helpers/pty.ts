// A real omp TUI in a pseudo-terminal (H22) against the scripted mock provider.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { encodeTspJson, TSP_PREFIX } from "@oh-my-pi/pi-tui/native/encode";
import { TSP_KINDS, TSP_VERSION } from "@oh-my-pi/pi-wire";
import { resolveOmpBin, stripNodeModulesBins } from "../../scripts/omp-bin.ts";
import { listeningSockets } from "../e2e/check.ts";
import { MockLlm, type Script } from "../e2e/mock-llm/server.ts";
import { REPO } from "./harness.ts";

const PROVIDER = join(REPO, "test", "e2e", "mock-llm", "provider.ts");

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control stripping
const ANSI = /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][^\u001b]*\u001b\\|\u001b[=>()][0-9A-Za-z]?/g;

interface ResumedNativeSession {
	id: string;
}

export class PtyOmp {
	readonly root: string;
	readonly swarm: string;
	readonly mock: MockLlm;
	readonly resumeFile: string | undefined;
	readonly debugSocket: string | undefined;
	readonly proc: ReturnType<typeof Bun.spawn>;
	#raw = Buffer.alloc(0);
	#mark = 0;

	constructor(script: Script, cols = 80, rows = 24, env: Record<string, string> = {}, persist: boolean | ResumedNativeSession = false) {
		this.root = mkdtempSync(join(tmpdir(), "omp-swarm-pty-"));
		const work = join(this.root, "work");
		mkdirSync(work);
		execFileSync("git", ["-C", work, "init", "-q"]);
		const agent = join(this.root, "agent");
		mkdirSync(agent);
		// No first-run wizard, splash or update check in the isolated agent dir; fast retries.
		writeFileSync(
			join(agent, "config.yml"),
			"startup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nretry:\n  maxRetries: 1\n  baseDelayMs: 20\n",
		);
		this.swarm = join(this.root, "swarm");
		const home = join(this.root, "home");
		mkdirSync(home);
		const native = typeof persist === "object";
		const cliArgs: string[] = persist ? [] : ["--no-session"];
		if (native) {
			const real = join(this.root, "real-sessions");
			const alias = join(this.root, "session-alias");
			mkdirSync(real);
			symlinkSync(real, alias, "dir");
			const timestamp = new Date().toISOString();
			this.resumeFile = join(alias, `${timestamp.replace(/[:.]/g, "-")}_${persist.id}.jsonl`);
			this.debugSocket = join(this.root, "tui.sock");
			writeFileSync(this.resumeFile, [
				{ type: "session", version: 3, id: persist.id, timestamp, cwd: work },
				{ type: "message", id: "01", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Seeded resumed Main transcript" }], timestamp: Date.now() } },
			].map(entry => JSON.stringify(entry)).join("\n") + "\n");
			cliArgs.push("--session", this.resumeFile, "--session-dir", alias);
		}
		const childEnv: Record<string, string | undefined> = {
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
		if (persist) delete childEnv.OMP_SWARM_DIR;
		if (native) {
			childEnv.TERM_PROGRAM = "tern";
			childEnv.OMP_TUI_DEBUG = this.debugSocket;
		}
		this.mock = new MockLlm(script, join(this.root, "mock.jsonl"));
		const port = this.mock.start();
		childEnv.MOCK_PORT = String(port);
		let tspCarry = "";
		const hello = encodeTspJson("r", { r: "hello", v: TSP_VERSION, term: "tern", kinds: TSP_KINDS, features: ["tray"], cols, dark: true, credits: 64 });
		this.proc = Bun.spawn(
			[resolveOmpBin(), "--model", "mock/coord", "--thinking", "low", ...cliArgs, "--no-extensions", "--no-title", "-e", REPO, "-e", PROVIDER],
			{
				cwd: work,
				env: childEnv,
				terminal: {
					cols,
					rows,
					data: (term, data) => {
						this.#raw = Buffer.concat([this.#raw, Buffer.from(data)]);
						const s = Buffer.from(data).toString("latin1");
						// Minimal answers to terminal queries (device attributes, cursor position).
						if (s.includes("\x1b[c") || s.includes("\x1b[0c")) term.write("\x1b[?62;22c");
						if (s.includes("\x1b[6n")) term.write("\x1b[1;1R");
						if (!native) return;
						tspCarry += s;
						for (;;) {
							const start = tspCarry.indexOf(TSP_PREFIX);
							if (start < 0) {
								tspCarry = tspCarry.slice(1 - TSP_PREFIX.length);
								break;
							}
							const end = tspCarry.indexOf("\x1b\\", start + TSP_PREFIX.length);
							if (end < 0) {
								tspCarry = tspCarry.slice(start);
								break;
							}
							const body = tspCarry.slice(start + TSP_PREFIX.length, end);
							tspCarry = tspCarry.slice(end + 2);
							if (body.startsWith("q;") && body.includes('"q":"hello"')) term.write(hello);
							else if (body.startsWith("f;")) {
								// The program's debug mirror supplies the document. The
								// simulated terminal just acknowledges complete frames.
								const json = body.indexOf("{");
								if (json < 0) continue;
								try {
									const { sf, s: seq } = JSON.parse(body.slice(json)) as { sf?: string; s?: number };
									if (sf && seq !== undefined) term.write(encodeTspJson("e", { ev: "ack", sf, s: seq }));
								} catch { /* chunked frame: the pinned host has a bounded credit fallback */ }
							}
						}
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

	async waitForNative(pred: (doc: unknown) => boolean, what: string, ms = 15_000): Promise<void> {
		const socket = this.debugSocket;
		if (!socket) throw new Error("TUI debug socket was not enabled");
		await this.waitFor(() => existsSync(socket), ms, "TUI debug socket");
		const end = Date.now() + ms;
		let doc: unknown;
		do {
			doc = (await this.debug({ op: "doc" })).doc;
			if (pred(doc)) return;
			await Bun.sleep(25);
		} while (Date.now() < end && this.proc.exitCode === null);
		throw new Error(`timed out waiting for ${what}; document tail: ${JSON.stringify(doc)?.slice(-3000)}`);
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
		this.mock.stop();
		if (process.env.PTY_KEEP) writeFileSync(join(this.root, "raw.txt"), this.#raw);
		else rmSync(this.root, { recursive: true, force: true });
	}
}
