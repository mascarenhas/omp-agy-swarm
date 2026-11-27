// The read model both UIs consume, and the SwarmView projection (§10.1). PURE: board types and
// node builtins only. UIs never touch the runtime's objects and never move a cursor.

import type { BoardMessage, ChannelRecord, Role } from "../board/types.ts";
import { LIMITS } from "../env.ts";

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
	/** The member's own requests; its native scouts are counted in scoutTokens/scoutCost. */
	tokens: number;
	cost: number;
	scoutTokens: number;
	scoutCost: number;
	killed: boolean;
	conversationId: string;
	sessionFile?: string;
	/** Actual native registry id, only while this worker is attached. */
	liveAgentId?: string;
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
	/** Requested continuation is unavailable; items are a replacement tail, not an adjacent page. */
	cursor_reset?: true;
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
	completion(absoluteTime?: { hour12?: boolean }): string;
	outcome(): Outcome | null;
	spend(): { tokens: number; cost: number; ceiling: number | null; unknown?: string };
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
	id?: string;
	title: string;
	rows: ThreadRow[];
}

export interface ReelFrame {
	kind: "image" | "markdown";
	seq: number;
	caption: string;
	path?: string;
	markdown?: string;
	agent?: string;
}

export interface SwarmView {
	key: string;
	counts: { working: number; waiting: number; stopped: number; failed: number };
	goal: string;
	threads: Thread[];
	attention: AttentionItem[];
	reel: ReelFrame[];
	stateLine: string;
	empty: boolean;
}

const SHOT_LINE_RE = /^\s*(?:[-*]\s*)?screenshot:\s*`?(\/[^\s`|]+\.(?:png|jpe?g|webp))`?\s*(?:\|\s*(.+?))?\s*$/i;
const PROGRESS_LINE_RE = /^\s*(?:[-*]\s*)?progress:\s*(.*)$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp)$/i;

function firstLine(s: string, max = 120): string {
	const line = s.split("\n").find(l => l.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function plainCaption(s: string, max = 90): string {
	const cleaned = s
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.replace(/^(?:>\s*|(?:[-*+]|\d+\.)\s+)/, "")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/(^|[^\w*])\*([^*]+)\*(?=[^\w*]|$)/g, "$1$2")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function clampMarkdown(s: string): string {
	const trimmed = s.trim();
	return trimmed.length > LIMITS.progressFrameChars ? `${trimmed.slice(0, LIMITS.progressFrameChars - 1)}…` : trimmed;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Normalizes view.json reel.frames entries (image screenshots and markdown progress updates). */
export function normalizeReelFrames(raw: unknown, cap = 40): ReelFrame[] {
	if (!Array.isArray(raw)) return [];
	const out: ReelFrame[] = [];
	for (const entry of raw) {
		if (out.length >= cap) break;
		if (!entry || typeof entry !== "object") continue;
		const f = entry as Record<string, unknown>;
		const seq = Number(f.seq) || 0;
		const agent = str(f.agent) || undefined;
		const isMarkdown = f.kind === "markdown" || typeof f.markdown === "string";
		if (isMarkdown) {
			const rawMd = typeof f.markdown === "string" ? f.markdown : typeof f.text === "string" ? f.text : "";
			if (!rawMd.trim()) continue;
			const markdown = clampMarkdown(rawMd);
			const first = markdown.split("\n").find(l => l.trim() && !FENCE_RE.test(l)) ?? markdown;
			const caption = plainCaption(str(f.caption) || first, 90);
			out.push({ kind: "markdown", seq, caption, markdown, ...(agent ? { agent } : {}) });
			continue;
		}
		const path = str(f.path);
		if (
			(f.kind === undefined || f.kind === "image") &&
			path.length > 0 &&
			path.length <= 4096 &&
			path.startsWith("/") &&
			!/[%\0\\]/.test(path) &&
			!path.split("/").some(seg => seg === "." || seg === "..") &&
			IMAGE_EXT_RE.test(path)
		) {
			out.push({ kind: "image", path, seq, caption: str(f.caption).slice(0, 90), ...(agent ? { agent } : {}) });
		}
	}
	return out;
}

/** Screenshots and markdown progress updates flagged by workers or the coordinator on the board. */
export function postedFrames(messages: readonly BoardMessage[], members: readonly MemberView[], cap: number = LIMITS.postedFrames): ReelFrame[] {
	const roles = new Map(members.map(m => [m.name, m.role]));
	const briefSeqs = new Set(members.map(m => m.briefSeq).filter(s => s > 0));
	const out = new Map<string, ReelFrame>();
	for (const m of messages) {
		const role = roles.get(m.agent);
		if (!role || (role !== "worker" && role !== "coordinator") || m.control || briefSeqs.has(m.seq)) continue;
		const lines = m.text.split(/\r?\n/);
		let fenceChar = "";
		let fenceLen = 0;
		let activeProgress: { head: string; body: string[] } | null = null;
		let mdIndex = 0;
		const flushProgress = (): void => {
			if (!activeProgress) return;
			const head = activeProgress.head.trim();
			const body = activeProgress.body.join("\n").trim();
			activeProgress = null;
			if (!head && !body) return;
			const markdown = clampMarkdown(body || head);
			const captionSource = head || (body.split("\n").find(l => l.trim() && !FENCE_RE.test(l)) ?? body);
			out.set(`md:${m.seq}:${mdIndex++}`, {
				kind: "markdown",
				seq: m.seq,
				caption: plainCaption(captionSource, 90),
				markdown,
				agent: m.agent,
			});
		};
		for (const line of lines) {
			const fence = FENCE_RE.exec(line);
			if (fence) {
				const marker = fence[1]!;
				if (!fenceChar) {
					fenceChar = marker[0]!;
					fenceLen = marker.length;
				} else if (marker[0] === fenceChar && marker.length >= fenceLen && line.trim() === marker) {
					fenceChar = "";
					fenceLen = 0;
				}
				if (activeProgress) activeProgress.body.push(line);
				continue;
			}
			if (fenceChar) {
				if (activeProgress) activeProgress.body.push(line);
				continue;
			}
			const shot = SHOT_LINE_RE.exec(line);
			if (shot) {
				flushProgress();
				const path = shot[1] ?? "";
				const key = `img:${path}`;
				out.delete(key);
				out.set(key, {
					kind: "image",
					path,
					seq: m.seq,
					caption: String(shot[2] ?? "").trim().slice(0, 80),
					agent: m.agent,
				});
				continue;
			}
			const prog = PROGRESS_LINE_RE.exec(line);
			if (prog) {
				flushProgress();
				activeProgress = { head: prog[1] ?? "", body: [] };
				continue;
			}
			if (activeProgress) activeProgress.body.push(line);
		}
		flushProgress();
	}
	return [...out.values()].slice(-cap);
}

const relativeMemo = new WeakMap<SwarmReadModel, SwarmView>();
const absoluteMemo = new WeakMap<SwarmReadModel, SwarmView>();

export function project(model: SwarmReadModel, files = model.files(), absoluteTime?: { hour12?: boolean }): SwarmView {
	const key = `${model.version}|${files.key}|${absoluteTime ? `absolute:${absoluteTime.hour12}` : "relative"}`;
	const memo = absoluteTime ? absoluteMemo : relativeMemo;
	const cached = memo.get(model);
	if (cached?.key === key) return cached;
	const members = model.members();
	const messages = model.messages();
	const counts = countMembers(members);
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
			threads.push({ id: str(tr.id), title: str(tr.title) || "Thread", rows });
		}
	} else if (Array.isArray(plan.threads)) {
		// plan.json (swarm_pane): threads list member names; tasks maps a name to its piece.
		const tasks = asRecord(plan.tasks) ?? {};
		for (const t of list(plan.threads).slice(0, 20)) {
			const tr = asRecord(t);
			if (!tr) continue;
			const rows: ThreadRow[] = [];
			for (const name of list(tr.tasks).slice(0, 40)) if (typeof name === "string") rows.push(rowFor(name, str(tasks[name])));
			threads.push({ id: str(tr.id), title: str(tr.title) || "Thread", rows });
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
	const viewReel = normalizeReelFrames((view.reel as { frames?: unknown } | undefined)?.frames);
	const reel: SwarmView["reel"] = viewReel.length ? viewReel : postedFrames(messages, members);
	const outcome = model.outcome();
	let stateLine: string;
	if (outcome?.value === "incomplete") stateLine = `incomplete: ${outcome.reason}`;
	else if (outcome) stateLine = outcome.value.replace(/_/g, " ");
	else if (restored) stateLine = `restored: ${restored.stopped} stopped, ${restored.owed} owed`;
	else stateLine = model.completion(absoluteTime);
	const empty = members.every(m => m.role === "coordinator") && messages.length === 0;
	const projected = { key, counts, goal: goal || "(no goal yet)", threads, attention, reel, stateLine, empty };
	memo.set(model, projected);
	return projected;
}

/** `N tokens · $X`, plus the member's native scouts when they spent anything. */
export function spendText(m: Pick<MemberView, "tokens" | "cost" | "scoutTokens" | "scoutCost">): string {
	const own = `${m.tokens} tokens · $${m.cost.toFixed(4)}`;
	return m.scoutTokens || m.scoutCost ? `${own} · scouts ${m.scoutTokens} tokens · $${m.scoutCost.toFixed(4)}` : own;
}

export function countMembers(members: readonly MemberView[]): SwarmView["counts"] {
	const counts = { working: 0, waiting: 0, stopped: 0, failed: 0 };
	for (const m of members) {
		if (m.role === "coordinator" || m.killed) continue;
		if (m.failure) counts.failed++;
		if (m.state === "working") counts.working++;
		else if (m.state === "waiting") counts.waiting++;
		else if (m.state === "stopped") counts.stopped++;
	}
	return counts;
}
