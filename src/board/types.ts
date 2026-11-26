// Board, roster and page shapes. PURE: no imports beyond these declarations.

export type Role = "coordinator" | "worker" | "narrator" | "monitor";
export type ControlOp = "create" | "archive" | "subscribe" | "unsubscribe";
export type StoredSet = string[] | null;

export interface Control {
	op: ControlOp;
	channel: string;
	topic?: string;
	members?: string[];
	prev?: Record<string, StoredSet>;
	next?: Record<string, StoredSet>;
}

/** One abandoned piece of work, recorded by `finish{abandon:true}` (runtime-owned metadata). */
export interface AbandonedItem {
	name: string;
	was: string;
	unread?: number[];
	notices?: number;
}

/** Structured, runtime-owned metadata on a `finish` post. A plain `post_message` never carries it. */
export interface FinishMeta {
	abandon: boolean;
	abandoned: AbandonedItem[];
}

/** One `board.jsonl` line (Antigravity-compatible plus `ts` and `finish`). */
export interface BoardRecord {
	seq: number;
	agent: string;
	text: string;
	time: string;
	ts?: number;
	channel?: string;
	control?: Control;
	finish?: FinishMeta;
}

export interface RingSets {
	/** Members (other than the author, not killed at the post) the post calls on. */
	readonly mentions: ReadonlySet<string>;
	/** Members (other than the author, not killed at the post) that can see the post. */
	readonly sees: ReadonlySet<string>;
}

/** An in-memory board message: the record plus ring sets fixed at the post. */
export interface BoardMessage extends BoardRecord {
	ts: number;
	ring: RingSets;
}

export interface ChannelRecord {
	name: string;
	topic: string;
	created_by: string;
	archived: boolean;
}

export type WorkspaceMode = "inherit" | "share" | "branch";
export type WorkspaceState = "active" | "removed" | "retained";

export interface WorkspaceRecord {
	mode: WorkspaceMode;
	path: string;
	root?: string;
	repo?: string;
	common?: string;
	branch?: string;
	base?: string;
	state?: WorkspaceState;
	retained_reason?: string;
	cleanup?: string;
}

export type FailureKind = "error" | "quota" | "cost" | "lost" | "workspace_missing" | "model_unavailable" | "start";

export interface FailureRecord {
	kind: FailureKind;
	text: string;
	at: string;
	at_seq: number;
	count: number;
}

export type WakeMode = "working" | "mentions" | "anything";

export interface PendingDeliveryRecord {
	id: string;
	kind: string;
	through: number;
}

export interface MemberStats {
	steps: number;
	/** The member's own model requests. Rosters written before scout_tokens existed also counted scouts here. */
	tokens: number;
	cost: number;
	/** Model requests of the member's native scouts. */
	scout_tokens?: number;
	scout_cost?: number;
}

/** A `members.json` member entry. Paths are never read back from here except `workspace` (verified). */
export interface MemberRecord {
	role: Role;
	conversation_id: string;
	/** Native registry id, independent of conversation_id; absent in older v1 rosters. */
	agent_id?: string;
	gen?: number;
	model: string;
	effort: string;
	added_by: string;
	added_at?: string;
	fork?: string;
	brief_seq?: number;
	brief_presented?: boolean;
	task?: string;
	channels: StoredSet;
	session_file: string | null;
	workspace: WorkspaceRecord;
	wake_mode: WakeMode;
	wait_since: number;
	wait_until?: number | null;
	last_park?: { mode: WakeMode; since: number; until: number | null } | null;
	last_read_seq: number;
	/** Receipted mid-turn posts above the contiguous read cursor. */
	addressed_read_seqs?: number[];
	wake_floor?: number;
	last_nudged_seq: number;
	last_park_blocked_seq: number;
	pending_delivery: PendingDeliveryRecord | null;
	killed: boolean;
	killed_at?: string | null;
	failure?: FailureRecord | null;
	stats?: MemberStats;
	added_seq?: number;
	killed_seq?: number;
}

/** Optional worker scout overrides; absent effort lets the swarm default fill a missing selector suffix. */
export interface ScoutOverride {
	model?: string;
	effort?: string;
}

export interface RosterFile {
	version: 1;
	id: string;
	title: string;
	created_at: string;
	board_head: number;
	channels: ChannelRecord[];
	scout?: ScoutOverride;
	spend_unknown?: string;
	members: Record<string, MemberRecord>;
}

/** A post as tools and wake text present it. */
export interface PageMessage {
	seq: number;
	agent: string;
	time: string;
	ts: number;
	text: string;
	channel?: string;
	control?: Control;
	for_you?: boolean;
}

export interface Page {
	since: number;
	messages: BoardMessage[];
	more: boolean;
	next_since: number;
}

export interface PageOptions {
	limit: number;
	maxBytes: number;
	/** `undefined` = own view; `"*"` = every channel; a name = that channel. */
	channel?: string;
	addressedOnly?: boolean;
	exclude?: ReadonlySet<number>;
	excludeQueued?: readonly number[];
}
