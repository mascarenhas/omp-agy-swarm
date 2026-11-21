// A real omp TUI in a pseudo-terminal (H22) against the scripted mock provider.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOmpBin, stripNodeModulesBins } from "../../scripts/omp-bin.ts";
import { listeningSockets } from "../e2e/check.ts";
import { MockLlm, type Script } from "../e2e/mock-llm/server.ts";
import { REPO } from "./harness.ts";

const PROVIDER = join(REPO, "test", "e2e", "mock-llm", "provider.ts");

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control stripping
const ANSI = /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][^\u001b]*\u001b\\|\u001b[=>()][0-9A-Za-z]?/g;

export class PtyOmp {
	readonly root: string;
	readonly swarm: string;
	readonly mock: MockLlm;
	readonly proc: ReturnType<typeof Bun.spawn>;
	#raw = Buffer.alloc(0);
	#mark = 0;

	constructor(script: Script, cols = 80, rows = 24, env: Record<string, string> = {}) {
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
		this.mock = new MockLlm(script, join(this.root, "mock.jsonl"));
		const port = this.mock.start();
		this.proc = Bun.spawn(
			[resolveOmpBin(), "--model", "mock/coord", "--thinking", "low", "--no-session", "--no-extensions", "--no-title", "-e", REPO, "-e", PROVIDER],
			{
				cwd: work,
				env: {
					...process.env,
					PATH: stripNodeModulesBins(process.env.PATH),
					TERM: "xterm-256color",
					MOCK_PORT: String(port),
					PI_CODING_AGENT_DIR: agent,
					OMP_SWARM_DIR: this.swarm,
					...env,
				},
				terminal: {
					cols,
					rows,
					data: (term, data) => {
						this.#raw = Buffer.concat([this.#raw, Buffer.from(data)]);
						const s = Buffer.from(data).toString("latin1");
						// Minimal answers to terminal queries (device attributes, cursor position).
						if (s.includes("\x1b[c") || s.includes("\x1b[0c")) term.write("\x1b[?62;22c");
						if (s.includes("\x1b[6n")) term.write("\x1b[1;1R");
					},
				},
			},
		);
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
