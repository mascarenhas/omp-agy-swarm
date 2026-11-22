import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Checks, roster } from "./check.ts";

export interface PaidCtx {
	T: string;
	swarm: string;
	repo: string;
	trace: string;
	stdout: string;
	stderr: string;
	code: number | null;
	scoutOverride?: string;
}

type Identity = { id: string; generation: number; parentId?: string };
export type Job = { id: string; ownerId?: string; agentId?: string; type: string; status: string; startTime: number; endTime?: number };
type RecordBody =
	| { kind: "root"; swarm?: string; sessionFile?: string; agentDir: string; agentDb: string; terminalSessionsDir: string }
	| ({ kind: "ref"; change: string; status: string; attached: boolean; sessionFile: string | null; model?: string; effort?: string } & Identity)
	| ({ kind: "jobs"; jobs: Job[]; wakeSources?: { jobs: readonly string[]; agents: readonly string[]; queued: boolean } } & Identity)
	| { kind: "life"; id: string; status: string; agent: string }
	| { kind: "progress"; id: string; status: string; agent: string; tool?: string; intent?: string; model?: string; effort?: string }
	| { kind: "event"; id: string; source: "session" | "task"; event: string; awaiting?: boolean; callId?: string; tool?: string; timeoutSeconds?: number; isError?: boolean; text?: string; customType?: string; swarmArgs?: { action?: unknown; name?: unknown; n?: unknown; tasks?: number; fork?: unknown; channels?: number } }
	| { kind: "response"; id: string; text: string }
	| { kind: "usage"; id: string; source: "session" | "task"; model: string; cost?: number; tokens: number; timestamp: number }
	| { kind: "stop"; pending: readonly string[] }
	| { kind: "harness"; action: string; id?: string; text?: string };
export type TraceBody = RecordBody;
export type Trace = RecordBody & { at: number };
export type Frame<K extends Trace["kind"]> = Extract<Trace, { kind: K }>;

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type?: string; text?: string }) => part?.type === "text" ? part.text ?? "" : "").join("\n");
}

// Appenders write a full line at a time. A concurrent read may see an incomplete tail;
// never interpret it as evidence, but fail on malformed *committed* lines.
export function jsonl<T>(path: string): T[] {
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
	return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line) as T);
}

export function evidence(c: PaidCtx): Trace[] {
	return jsonl(c.trace);
}

export interface Usage {
	cost?: { total?: number };
	totalTokens?: number;
	input?: number;
	output?: number;
}

export interface Entry {
	type?: string;
	purpose?: string;
	model?: string;
	thinkingLevel?: string | null;
	usage?: Usage;
	message?: { role?: string; provider?: string; model?: string; content?: unknown; usage?: Usage; toolCallId?: string };
}

export function entries(c: PaidCtx, name: string): Entry[] {
	const file = roster(c)[name]?.session_file;
	return file ? jsonl(join(c.swarm, "sessions", basename(file))) : [];
}

export function usageTokens(u: Usage | undefined): number {
	return u?.totalTokens || (u?.input ?? 0) + (u?.output ?? 0);
}

/** Returned stall wakes, checked against the task workers' state at that trace position. */
function stallWakes(trace: Trace[], workers: ReadonlyMap<string, Entry[]>) {
	const stalls: { at: number; pending: string[] }[] = [];
	for (const [index, row] of trace.entries()) {
		if (row.kind !== "event" || row.id !== "Main" || row.source !== "session" ||
			row.tool !== "swarm_wait" || row.event !== "tool_execution_end" || !/"woke"\s*:\s*"stall"/.test(row.text ?? "")) continue;
		const prior = trace.slice(0, index);
		const pending: string[] = [];
		for (const [id, journal] of workers) {
			const ref = prior.findLast((r): r is Frame<"ref"> => r.kind === "ref" && r.id === id);
			if (ref?.change === "removed" || ref?.status === "aborted") continue;
			const snapshot = prior.findLast((r): r is Frame<"jobs"> => r.kind === "jobs" && r.id === id && (!ref || r.generation === ref.generation));
			const job = snapshot?.jobs.find(j => j.ownerId === id && j.status === "running" && j.startTime <= row.at);
			if (job) pending.push(`${id}: pending job ${job.id}`);
			if (snapshot?.wakeSources) pending.push(`${id}: native wake sources`);
			const loop = prior.findLast((r): r is Frame<"event"> => r.kind === "event" && r.id === id && r.source === "session" &&
				["agent_start", "agent_pause", "agent_end"].includes(r.event));
			if (loop?.event === "agent_pause" && loop.awaiting) pending.push(`${id}: awaiting background work`);
			const wait = prior.findLast((r): r is Frame<"event"> => r.kind === "event" && r.id === id && r.source === "session" &&
				r.tool === "swarm_wait" && (r.event === "tool_execution_start" || r.event === "tool_execution_end"));
			const progress = prior.findLast((r): r is Frame<"progress"> => r.kind === "progress" && r.id === id);
			const parked = wait?.event === "tool_execution_start" && progress?.tool === "swarm_wait" && progress.intent === "waiting on board";
			if (parked) {
				// Older receipts omit timeoutSeconds; the matching assistant tool
				// call in the journal still distinguishes timed from untimed waits.
				const calls = journal.flatMap(entry => entry.message?.role === "assistant" && Array.isArray(entry.message.content)
					? entry.message.content as { type?: string; id?: string; arguments?: { timeout_seconds?: unknown } }[] : []);
				const timeout = wait.timeoutSeconds ?? calls.find(call => call.type === "toolCall" && call.id === wait.callId)?.arguments?.timeout_seconds;
				if (typeof timeout === "number" && timeout > 0) pending.push(`${id}: armed timed wait`);
			} else if (loop ? loop.event !== "agent_end" : ref?.status === "running") {
				pending.push(`${id}: open turn`);
			}
		}
		stalls.push({ at: row.at, pending });
	}
	return stalls;
}

export function checkStallWakes(k: Checks, trace: Trace[], workers: ReadonlyMap<string, Entry[]>, count: number | undefined): void {
	const stalls = stallWakes(trace, workers);
	k.eq(stalls.length, count, "stall count matches observer receipts");
	for (const { at, pending } of stalls)
		k.ok(!pending.length, `coordinator woke:stall at ${new Date(at).toISOString()} with pending worker work (${pending.join(", ")})`);
}

/**
 * Read own-session bills only. A live assistant stream survives `/discard`;
 * its `discarded-turn` journal replacement is not a second request. The
 * stream supplies assistant bills and the journal supplies new auxiliary
 * calls. Never read usage from embedded tool/child results.
 */
export function directBill(rows: Entry[], assistants: Iterable<{ cost?: number; tokens: number }>): { cost: number; unpriced: number } {
	let cost = 0;
	let unpriced = 0;
	const add = (price: number | undefined, tokens: number): void => {
		if (typeof price === "number" && Number.isFinite(price) && price > 0) cost += price;
		else if (tokens > 0) unpriced++;
	};
	for (const { cost: price, tokens } of assistants) add(price, tokens);
	for (const row of rows) {
		if (row.type === "model_usage" && row.purpose !== "discarded-turn" && row.usage)
			add(row.usage.cost?.total, usageTokens(row.usage));
	}
	return { cost, unpriced };
}
