import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { roster } from "./check.ts";

export interface PaidCtx {
	T: string;
	swarm: string;
	repo: string;
	trace: string;
	stdout: string;
	stderr: string;
	code: number | null;
	profiles?: string;
	profilesBefore?: string;
}

type Identity = { id: string; generation: number; parentId?: string };
export type Job = { id: string; ownerId?: string; agentId?: string; type: string; status: string; startTime: number; endTime?: number };
type RecordBody =
	| { kind: "root"; swarm?: string; sessionFile?: string }
	| ({ kind: "ref"; change: string; status: string; attached: boolean; sessionFile: string | null; model?: string; effort?: string } & Identity)
	| ({ kind: "jobs"; jobs: Job[] } & Identity)
	| { kind: "life"; id: string; status: string; agent: string }
	| { kind: "progress"; id: string; status: string; agent: string; tool?: string; intent?: string; model?: string; effort?: string }
	| { kind: "event"; id: string; source: "session" | "task"; event: string; awaiting?: boolean; callId?: string; tool?: string; isError?: boolean; text?: string; customType?: string; swarmArgs?: { action?: unknown; name?: unknown; n?: unknown; tasks?: unknown; fork?: unknown } }
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
	thinkingLevel?: string | null;
	usage?: Usage;
	message?: { role?: string; provider?: string; model?: string; content?: unknown; usage?: Usage };
}

export function entries(c: PaidCtx, name: string): Entry[] {
	const file = roster(c)[name]?.session_file;
	return file ? jsonl(join(c.swarm, "sessions", basename(file))) : [];
}

export function usageTokens(u: Usage | undefined): number {
	return u?.totalTokens || (u?.input ?? 0) + (u?.output ?? 0);
}

/** Own-session billing only: never add embedded task-result usage to a child's direct bill. */
export function directBill(rows: Entry[]): { cost: number; unpriced: number } {
	let cost = 0;
	let unpriced = 0;
	for (const row of rows) {
		const usage = row.type === "model_usage" ? row.usage : row.message?.role === "assistant" ? row.message.usage : undefined;
		const price = usage?.cost?.total;
		if (typeof price === "number" && Number.isFinite(price) && price > 0) cost += price;
		else if (usageTokens(usage) > 0) unpriced++;
	}
	return { cost, unpriced };
}
