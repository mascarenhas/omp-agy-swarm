// Shared checks for the hermetic end-to-end scenarios (§12.3).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LoggedRequest, MockLlm } from "./mock-llm/server.ts";

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	ms: number;
	/** Listening TCP sockets observed in the omp process while it ran. */
	listeners: number;
}

export interface Ctx {
	id: string;
	T: string;
	repo: string;
	swarm: string;
	agent: string;
	sessions: string;
	mock: MockLlm;
	runs: RunResult[];
}

/** On-disk evidence shared by deterministic and paid runs. */
type SwarmFiles = Pick<Ctx, "swarm">;

export class Checks {
	readonly failures: string[] = [];
	ok(cond: unknown, what: string): void {
		if (!cond) this.failures.push(what);
	}
	eq(actual: unknown, expected: unknown, what: string): void {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a !== e) this.failures.push(`${what}: expected ${e}, got ${a}`);
	}
}

export function readJson<T = Record<string, unknown>>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export interface Metrics {
	outcome: { value: string; reason: string } | null;
	members: Record<string, { model: string; effort: string; state: string; failures: number; nudges: number; wakes: number; killed: boolean; tokens: number; cost: number }>;
	spend: { tokens: number; cost: number; ceiling?: number | null; unknown?: string };
	coordinator?: { gate_refusals?: number; stall_wakes?: number; tokens?: number; cost?: number };
}

export function metrics(c: SwarmFiles): Metrics | undefined {
	return readJson<Metrics>(join(c.swarm, "metrics.json"));
}

export interface RosterMember {
	role: string;
	model: string;
	effort: string;
	conversation_id: string;
	agent_id?: string;
	gen?: number;
	session_file: string | null;
	killed: boolean;
	killed_at?: string | null;
	killed_seq?: number;
	last_park?: { until: number | null } | null;
	failure?: { kind: string } | null;
	last_read_seq: number;
	workspace: { mode: string; path: string; root?: string; branch?: string; state?: string; retained_reason?: string };
}

export function roster(c: SwarmFiles): Record<string, RosterMember> {
	return readJson<{ members: Record<string, RosterMember> }>(join(c.swarm, "members.json"))?.members ?? {};
}

export interface BoardLine {
	seq: number;
	agent: string;
	text: string;
	ts?: number;
	finish?: { abandon: boolean; abandoned: { name: string; was: string }[] };
	channel?: string;
	control?: unknown;
}

export function board(c: SwarmFiles): BoardLine[] {
	const p = join(c.swarm, "board.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l) as BoardLine);
}

/** Requests the coordinator or a worker sent, by mock model id. */
export function requests(c: Ctx, model: string): LoggedRequest[] {
	return c.mock.requests(model);
}

/** Hash of every file under dir (relative path + content), or "absent". */
export function treeHash(dir: string): string {
	if (!existsSync(dir)) return "absent";
	const h = createHash("sha256");
	const walk = (d: string): void => {
		for (const e of readdirSync(d).sort()) {
			const p = join(d, e);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else h.update(`${p.slice(dir.length)}\0`).update(readFileSync(p));
		}
	};
	walk(dir);
	return h.digest("hex");
}

/** Listening TCP sockets owned by pid (Linux /proc): inode match between fds and /proc/net/tcp*. */
export function listeningSockets(pid: number): number {
	try {
		const inodes = new Set<string>();
		for (const fd of readdirSync(`/proc/${pid}/fd`)) {
			try {
				const l = readlinkSync(`/proc/${pid}/fd/${fd}`);
				const m = /^socket:\[(\d+)\]$/.exec(l);
				if (m?.[1]) inodes.add(m[1]);
			} catch {}
		}
		let n = 0;
		for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
			if (!existsSync(f)) continue;
			for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
				const cols = line.trim().split(/\s+/);
				if (cols[3] === "0A" && cols[9] && inodes.has(cols[9])) n++;
			}
		}
		return n;
	} catch {
		return 0;
	}
}
