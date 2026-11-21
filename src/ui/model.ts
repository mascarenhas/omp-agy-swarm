// The read model both UIs consume, and the SwarmView projection (§10.1). PURE: board types and
// node builtins only. UIs never touch the runtime's objects and never move a cursor.

import type { BoardMessage, ChannelRecord, Role } from "../board/types.ts";

export interface MemberView {
	name: string;
	role: Role;
	state: "waiting" | "working" | "stopped" | "killed";
	detail: string;
	model: string;
	effort: string;
	addedBy: string;
	channels: string[];
	defaultChannel: string;
	workspace: { mode: string; path: string; branch?: string; state?: string; reason?: string; cleanup?: string };
	wakeMode: string;
	lastReadSeq: number;
	unread: number;
	owed: number[];
	posts: number;
	lastPostSeq?: number;
	lastPostTs?: number;
	steps: number;
	activity: string;
	activityKind: string;
	failure?: { kind: string; text: string };
	tokens: number;
	cost: number;
	killed: boolean;
	conversationId: string;
	sessionFile?: string;
	briefSeq: number;
	task: string;
	lastEventAt: number;
}

export interface AttentionItem {
	kind: string;
	member?: string;
	seq?: number;
	text: string;
	detail?: string;
	severity?: string;
}

export interface ViewFiles {
	key: string;
	plan: Record<string, unknown> | null;
	view: Record<string, unknown> | null;
	viewHtml: string | null;
	planError?: string;
	viewError?: string;
	htmlError?: string;
	/** view.json text as last read (Raw tab), capped. */
	viewRaw: string;
}

export interface TranscriptItem {
	/** `${entryId}#${block}` */
	id: string;
	entryId: string;
	block: number;
	kind: "user" | "wake" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system";
	text: string;
	truncated?: boolean;
	tool?: string;
	ok?: boolean;
	model?: string;
	ts?: number;
}

export interface TranscriptPage {
	items: TranscriptItem[];
	first?: string;
	last?: string;
	more_before: boolean;
	more_after: boolean;
	epoch: string;
}

export interface TranscriptPageOptions {
	before?: string;
	after?: string;
	limit?: number;
	/** Without a cursor: the first page of the branch instead of the last. */
	head?: boolean;
}

export interface TranscriptSource {
	page(opts: TranscriptPageOptions): TranscriptPage;
}

export interface Outcome {
	value: string;
	reason: string;
}

export interface SwarmReadModel {
	readonly version: number;
	readonly sid: string;
	readonly title: string;
	readonly mode: "interactive" | "headless";
	readonly head: number;
	readonly swarmDir: string;
	messages(): readonly BoardMessage[];
	members(): readonly MemberView[];
	channels(): readonly ChannelRecord[];
	attention(): readonly AttentionItem[];
	completion(): string;
	outcome(): Outcome | null;
	files(): ViewFiles;
	transcript(name: string): TranscriptSource | undefined;
	onChange(cb: () => void): () => void;
	/** Restored-after-restart summary, while members are stopped. */
	restored(): { stopped: number; owed: number } | null;
	stalled(): boolean;
	/** The coordinator's acknowledged cursor (Board "new" divider). */
	coordinatorCursor(): number;
	/** Display addressees of a post (names it calls on, @all, channels). */
	addressees(msg: BoardMessage): { mentions: string[]; all: boolean; channels: string[] };
	/** The last flushed members.json text (web Raw tab; never re-serialized per poll). */
	rawRoster(): string;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ThreadRow {
	owner: string;
	state: string;
	title: string;
	result: string;
	resultSeq?: number;
}

export interface Thread {
	title: string;
	rows: ThreadRow[];
}

export interface SwarmView {
	key: string;
	counts: { working: number; waiting: number; stopped: number; failed: number };
	goal: string;
	threads: Thread[];
	attention: AttentionItem[];
	reel: { caption: string; path: string; seq: number }[];
	stateLine: string;
	empty: boolean;
}

const SHOT_RE = /^\s*(?:[-*]\s*)?screenshot:\s*`?(\/[^\s`|]+\.(?:png|jpe?g|webp))`?\s*(?:\|\s*(.+?))?\s*$/gim;

function firstLine(s: string, max = 120): string {
	const line = s.split("\n").find(l => l.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Screenshots task workers flagged on the board (same regex and cap as upstream). */
export function postedFrames(messages: readonly BoardMessage[], members: readonly MemberView[], cap = 24): { path: string; seq: number; caption: string }[] {
	const roles = new Map(members.map(m => [m.name, m.role]));
	const out = new Map<string, { path: string; seq: number; caption: string }>();
	for (const m of messages) {
		const role = roles.get(m.agent);
		if (!role || role !== "worker" || m.control) continue;
		for (const g of m.text.matchAll(SHOT_RE)) {
			const path = g[1] ?? "";
			out.delete(path);
			out.set(path, { path, seq: m.seq, caption: String(g[2] ?? "").slice(0, 80) });
		}
	}
	return [...out.values()].slice(-cap);
}

let memoKey = "";
let memoView: SwarmView | undefined;

export function project(model: SwarmReadModel): SwarmView {
	const files = model.files();
	const key = `${model.sid}|${model.version}|${files.key}`;
	if (memoView && memoKey === key) return memoView;
	const members = model.members();
	const messages = model.messages();
	const counts = { working: 0, waiting: 0, stopped: 0, failed: 0 };
	for (const m of members) {
		if (m.role === "coordinator" || m.killed) continue;
		if (m.failure) counts.failed++;
		if (m.state === "working") counts.working++;
		else if (m.state === "waiting") counts.waiting++;
		else if (m.state === "stopped") counts.stopped++;
	}
	const view = files.view ?? {};
	const plan = files.plan ?? {};
	const goalObj = (view.goal ?? plan.goal) as unknown;
	const goal =
		goalObj && typeof goalObj === "object"
			? str((goalObj as Record<string, unknown>).title) || str((goalObj as Record<string, unknown>).line)
			: str(goalObj) || model.title;
	const lastPost = new Map<string, BoardMessage>();
	for (const msg of messages) if (!msg.control) lastPost.set(msg.agent, msg);
	const byName = new Map(members.map(m => [m.name, m]));
	const rowFor = (owner: string, title: string): ThreadRow => {
		const m = byName.get(owner);
		const lp = lastPost.get(owner);
		const brief = m?.briefSeq ? messages[m.briefSeq - 1]?.text.replace(/^@\S+\s*/, "") ?? "" : "";
		return {
			owner,
			state: m ? (m.failure ? "failed" : m.state) : "?",
			title: firstLine(title || m?.task || brief, 80),
			result: lp ? firstLine(lp.text.replace(/^(@[\w#-]+[\s,:]*)+/, ""), 100) : "",
			resultSeq: lp?.seq,
		};
	};
	const threads: Thread[] = [];
	const asRecord = (v: unknown): Record<string, unknown> | undefined =>
		v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
	if (Array.isArray(view.threads)) {
		// view.json: threads list workstream ids; workstreams carry owners, title, note.
		const ws = new Map<string, Record<string, unknown>>();
		for (const w of list(view.workstreams)) {
			const r = asRecord(w);
			if (r && typeof r.id === "string") ws.set(r.id, r);
		}
		for (const t of list(view.threads).slice(0, 20)) {
			const tr = asRecord(t);
			if (!tr) continue;
			const rows: ThreadRow[] = [];
			for (const id of list(tr.workstreams).slice(0, 40)) {
				const w = typeof id === "string" ? ws.get(id) : undefined;
				const owner = w ? str(list(w.owners)[0]) : "";
				if (owner) rows.push(rowFor(owner, str(w?.title) || str(w?.note)));
			}
			threads.push({ title: str(tr.title) || "Thread", rows });
		}
	} else if (Array.isArray(plan.threads)) {
		// plan.json (swarm_pane): threads list member names; tasks maps a name to its piece.
		const tasks = asRecord(plan.tasks) ?? {};
		for (const t of list(plan.threads).slice(0, 20)) {
			const tr = asRecord(t);
			if (!tr) continue;
			const rows: ThreadRow[] = [];
			for (const name of list(tr.tasks).slice(0, 40)) if (typeof name === "string") rows.push(rowFor(name, str(tasks[name])));
			threads.push({ title: str(tr.title) || "Thread", rows });
		}
	}
	if (!threads.length) {
		const rows = members.filter(m => m.role === "worker" && !m.killed).map(m => rowFor(m.name, ""));
		if (rows.length) threads.push({ title: "Work", rows });
	}
	const attention: AttentionItem[] = [...model.attention()];
	for (const m of members) {
		if (m.role !== "worker" || m.killed) continue;
		const lp = lastPost.get(m.name);
		if (lp && /^\s*(?:@[\w#-]+[\s,:]*)*\[blocked\]/i.test(lp.text)) attention.push({ kind: "blocked", member: m.name, seq: lp.seq, text: `${m.name} is blocked (#${lp.seq})` });
	}
	const cursor = model.coordinatorCursor();
	for (const msg of messages) {
		if (msg.seq <= cursor || msg.control) continue;
		const author = byName.get(msg.agent);
		if (!author || author.role !== "worker") continue;
		const a = model.addressees(msg);
		if (!a.mentions.length && !a.all && !a.channels.length) attention.push({ kind: "unaddressed", member: msg.agent, seq: msg.seq, text: `#${msg.seq} result addressed to nobody` });
	}
	const restored = model.restored();
	if (restored && restored.owed > 0) attention.push({ kind: "owed", text: `${restored.owed} stopped members have unread posts (swarm revive)` });
	const narratorAttention = Array.isArray(view.attention) ? (view.attention as unknown[]) : [];
	for (const a of narratorAttention.slice(0, 20)) {
		if (!a || typeof a !== "object") continue;
		const ar = a as Record<string, unknown>;
		attention.push({ kind: str(ar.kind) || "note", severity: str(ar.severity), text: str(ar.title) || str(ar.text) || "(attention)" });
	}
	const reelFrames = (view.reel as { frames?: unknown } | undefined)?.frames;
	const reel: SwarmView["reel"] = Array.isArray(reelFrames)
		? reelFrames
				.filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string")
				.slice(0, 40)
				.map(f => ({ path: str(f.path), seq: Number(f.seq) || 0, caption: str(f.caption).slice(0, 90) }))
		: postedFrames(messages, members);
	const outcome = model.outcome();
	let stateLine: string;
	if (outcome?.value === "incomplete") stateLine = `incomplete: ${outcome.reason}`;
	else if (outcome) stateLine = outcome.value.replace(/_/g, " ");
	else if (restored) stateLine = `restored: ${restored.stopped} stopped, ${restored.owed} owed`;
	else stateLine = model.completion();
	const empty = members.filter(m => m.role !== "coordinator").length === 0 && messages.length === 0;
	memoKey = key;
	memoView = { key, counts, goal: goal || "(no goal yet)", threads, attention, reel, stateLine, empty };
	return memoView;
}
