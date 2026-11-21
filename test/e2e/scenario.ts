// Scenario contract and the per-run omp launcher for the hermetic end-to-end suite.

import { join } from "node:path";
import { resolveOmpBin, stripNodeModulesBins } from "../../scripts/omp-bin.ts";
import { type Ctx, listeningSockets, type RunResult } from "./check.ts";
import type { Checks } from "./check.ts";
import type { Script, ToolCallSpec } from "./mock-llm/server.ts";

export const REPO = join(import.meta.dir, "..", "..");
export const PROVIDER = join(import.meta.dir, "mock-llm", "provider.ts");

export interface RunSpec {
	prompt: string;
	/** Replaces the default plugin loading args (`--no-extensions -e <repo>`). */
	pluginArgs?: string[];
	args?: string[];
	env?: Record<string, string | undefined>;
	script?: (c: Ctx) => Script;
	/** Polled every 20 ms while omp runs; true → SIGKILL (crash simulation). */
	killWhen?: (c: Ctx) => boolean;
	/** Runs before this omp run starts (e.g. delete a transcript between runs). */
	before?: (c: Ctx) => void;
	cwd?: (c: Ctx) => string;
}

export interface Scenario {
	id: string;
	title: string;
	script: (c: Ctx) => Script;
	setup?: (c: Ctx) => void | Promise<void>;
	runs: RunSpec[];
	check: (c: Ctx, k: Checks) => void | Promise<void>;
	maxMs?: number;
	/** Removes OMP_SWARM_DIR from the environment (ephemeral or artifacts dirs). */
	noSwarmDirEnv?: boolean;
}

export function tool(name: string, args: Record<string, unknown> = {}): ToolCallSpec {
	return { name, args };
}

export async function runOmp(c: Ctx, run: RunSpec, noSwarmDirEnv: boolean): Promise<RunResult> {
	const plugin = run.pluginArgs ?? ["--no-extensions", "-e", REPO];
	const ompBin = resolveOmpBin();
	const cmd = [
		ompBin,
		"-p",
		run.prompt,
		"--model",
		"mock/coord",
		"--thinking",
		"high",
		...plugin,
		"-e",
		PROVIDER,
		"--session-dir",
		c.sessions,
		"--max-time",
		"120",
		...(run.args ?? []),
	];
	const env: Record<string, string | undefined> = {
		...process.env,
		PATH: stripNodeModulesBins(process.env.PATH),
		PI_CODING_AGENT_DIR: c.agent,
		MOCK_PORT: String(c.mock.port),
		OMP_SWARM_DIR: noSwarmDirEnv ? undefined : c.swarm,
		NO_COLOR: "1",
		...run.env,
	};
	for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
	const t0 = performance.now();
	const proc = Bun.spawn(cmd, { cwd: run.cwd?.(c) ?? c.repo, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	let listeners = 0;
	let killed = false;
	const sampler = setInterval(() => {
		listeners = Math.max(listeners, listeningSockets(proc.pid));
		if (!killed && run.killWhen?.(c)) {
			killed = true;
			proc.kill("SIGKILL");
		}
	}, 20);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	clearInterval(sampler);
	return { code, stdout, stderr, ms: performance.now() - t0, listeners };
}
