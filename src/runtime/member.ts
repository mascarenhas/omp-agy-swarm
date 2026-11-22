// Member: persisted record fields plus live state (phase, generation, operation, waiter,
// delivery, cycle, activity tracker). Mutation happens in the runtime modules.

import type {
	FailureRecord,
	MemberRecord,
	MemberStats,
	Role,
	StoredSet,
	WakeMode,
	WorkspaceRecord,
} from "../board/types.ts";
import type { DisposeResult } from "./workspace.ts";
import { ActivityTracker } from "./activity.ts";
import type { PendingSwitch, WorkerSession } from "./ports.ts";

export type Phase = "stopped" | "starting" | "working" | "parked" | "resuming" | "switching" | "idle" | "killed";
export type OpKind = "start" | "revive" | "switch" | "kill";

/** One asynchronous lifecycle step; at most one per member (§3.4). */
export interface Op {
	readonly kind: OpKind;
	readonly gen: number;
	cancelled: boolean;
	disposal?: Promise<void>;
	readonly abort: AbortController;
}

/** Canonical wait outcomes (SW-14); the elision table lives in tools/ops.ts. */
export type ClaimReason =
	| "post"
	| "timeout"
	| "notice"
	| "stall"
	| "incomplete"
	| "switch"
	| "interrupted"
	| "aborted"
	| "killed"
	| "closing";

export interface Waiter {
	readonly id: string;
	readonly mode: WakeMode;
	readonly startedAt: number;
	readonly deadline: number | undefined;
	readonly timeoutSeconds: number | undefined;
	timer: Timer | undefined;
	signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
	claimed: boolean;
	resolve(reason: ClaimReason): void;
	/** Extra payload attached by the claimer (stall details, trigger seq). */
	extra?: Record<string, unknown>;
}

export type DeliveryKind = "prompt" | "aside" | "tool" | "gate";

export interface Delivery {
	readonly id: string;
	readonly gen: number;
	readonly kind: DeliveryKind;
	status: "admitted" | "dispatched";
	since: number;
	through: number;
	noticeIds: number[];
	reminderKeys: ReminderKey[];
	text?: string;
	toolCallId?: string;
	/** The page carried posts (starts a cycle on acknowledgement). */
	carriesPosts: boolean;
	/** The delivery carried the startup brief. */
	carriesBrief: boolean;
	direct: boolean;
	cause: CycleCause;
	runIdAtDispatch: number;
	dispatchedAt: number;
	nudge: boolean;
	receiptTimer?: Timer;
}

export type CycleCause = "brief" | "post" | "timeout" | "notice" | "resume" | "nudge" | "stall";

export interface Cycle {
	cause: CycleCause;
	direct: boolean;
	posted: boolean;
	nudged: boolean;
}

export interface Notice {
	id: number;
	kind: string;
	text: string;
	at: number;
}

export type ReminderKey = "compacted" | "resume" | "restored" | "switched";

export interface LiveStats extends MemberStats {
	runs: number;
	posts: number;
	wakes: number;
	nudges: number;
	failures: number;
}

let deliverySeq = 0;
export function nextDeliveryId(): string {
	return `d-${++deliverySeq}`;
}

export function roleDefaultMode(role: Role): WakeMode {
	return role === "narrator" ? "anything" : "mentions";
}

export class Member {
	readonly name: string;
	readonly role: Role;
	conversationId = "";
	agentId = "";
	gen = 1;
	model = "";
	effort = "";
	addedBy = "";
	addedAt = "";
	fork = "";
	task = "";
	brief = "";
	briefSeq = 0;
	briefPresented = false;
	channels: StoredSet = null;
	sessionFile: string | null = null;
	workspace: WorkspaceRecord;
	wakeMode: WakeMode;
	waitSince = 0;
	waitUntil: number | null = null;
	lastPark: MemberRecord["last_park"] = null;
	lastReadSeq = 0;
	/** Posts at or below this seq were explicitly abandoned and never wake the member again. */
	wakeFloor = 0;
	lastNudgedSeq = 0;
	lastParkBlockedSeq = 0;
	killed = false;
	killedAt: string | null = null;
	failure: FailureRecord | null = null;
	/** Head at reservation: posts at or below it predate the member. */
	addedSeq = 0;
	killedSeq: number | undefined;

	// live state
	phase: Phase;
	op: Op | undefined;
	waiter: Waiter | undefined;
	delivery: Delivery | undefined;
	session: WorkerSession | undefined;
	unsubscribe: (() => void) | undefined;
	cycle: Cycle | undefined;
	notices: Notice[] = [];
	droppedNotices = 0;
	reminders: Partial<Record<ReminderKey, string>> = {};
	pendingSwitch: PendingSwitch | undefined;
	retryToken = false;
	/** Earliest time (epoch ms) an automatic redelivery may be admitted. */
	notBefore = 0;
	redeliveryAttempts = 0;
	redeliveryExhausted = false;
	/** `through` of the newest dispatched delivery (failure retry eligibility). */
	lastDeliveredThrough = 0;
	/** Settles when the current start/revive operation's continuation has finished. */
	opSettled: Promise<unknown> | undefined;
	reconcileTimer: Timer | undefined;
	runId = 0;
	settledRun = 0;
	/** The session's cost-cap refusal when the current run started (a newer one ends the run as a cost failure). */
	costRefusalSeen: unknown;
	nudgePending = false;
	stuckNotified = false;
	lastFailureNoticeAt = 0;
	/** Set when an exec-approved action in this binding started or revived the member (SW-09). */
	authorized = false;
	/** Coordinator was told this stopped member has owed posts (once per episode). */
	reviveNoticeSent = false;
	/** The member's session finished stopping after a kill (workspace removal is allowed). */
	stoppedCleanly = false;
	killPromise: Promise<DisposeResult | null> | undefined;
	/** Last detached generation's stop result; only pending disposal delays explicit revival. */
	drain: { promise: Promise<void>; pending: boolean } | undefined;
	readonly tracker = new ActivityTracker();
	stats: LiveStats = { steps: 0, tokens: 0, cost: 0, runs: 0, posts: 0, wakes: 0, nudges: 0, failures: 0 };
	/** Model/effort the runtime expects the session to run (out-of-band change detection). */
	expectedModel = "";
	expectedEffort = "";

	constructor(name: string, role: Role, workspace: WorkspaceRecord, phase: Phase) {
		this.name = name;
		this.role = role;
		this.workspace = workspace;
		this.wakeMode = roleDefaultMode(role);
		this.phase = phase;
	}

	get isTask(): boolean {
		return this.role === "worker" && !this.killed;
	}

	get isRoleWorker(): boolean {
		return this.role === "narrator" || this.role === "monitor";
	}

	/** Reported state (§6.1). */
	get state(): "waiting" | "working" | "stopped" | "killed" {
		switch (this.phase) {
			case "killed":
				return "killed";
			case "stopped":
				return "stopped";
			case "parked":
			case "idle":
				return "waiting";
			default:
				return "working";
		}
	}

	get detail(): string {
		switch (this.phase) {
			case "parked":
				return "in swarm_wait";
			case "starting":
				return this.op?.kind === "revive" ? "reviving" : this.op ? "starting" : "wake arriving";
			case "switching":
				return "switching model";
			case "resuming":
				return "waking";
			case "idle":
				return this.failure ? `failed (${this.failure.kind})` : "idle";
			case "stopped":
				return this.failure ? `stopped (${this.failure.kind})` : "stopped";
			default:
				return this.phase;
		}
	}

	toRecord(): MemberRecord {
		const r: MemberRecord = {
			role: this.role,
			conversation_id: this.conversationId,
			model: this.model,
			effort: this.effort,
			added_by: this.addedBy,
			channels: this.channels,
			session_file: this.sessionFile,
			workspace: this.workspace,
			wake_mode: this.wakeMode,
			wait_since: this.waitSince,
			last_read_seq: this.lastReadSeq,
			last_nudged_seq: this.lastNudgedSeq,
			last_park_blocked_seq: this.lastParkBlockedSeq,
			pending_delivery:
				this.delivery && this.delivery.status === "dispatched"
					? { id: this.delivery.id, kind: this.delivery.kind, through: this.delivery.through }
					: null,
			killed: this.killed,
		};
		if (this.role !== "coordinator") {
			r.agent_id = this.agentId;
			r.gen = this.gen;
			r.added_at = this.addedAt;
			r.fork = this.fork;
			r.brief_seq = this.briefSeq;
			r.brief_presented = this.briefPresented;
			if (this.task) r.task = this.task;
			r.wait_until = this.waitUntil;
			r.last_park = this.lastPark;
			r.killed_at = this.killedAt;
			r.failure = this.failure;
			r.stats = { steps: this.stats.steps, tokens: this.stats.tokens, cost: this.stats.cost };
		}
		if (this.wakeFloor > 0) r.wake_floor = this.wakeFloor;
		if (this.addedSeq > 0) r.added_seq = this.addedSeq;
		if (this.killedSeq !== undefined) r.killed_seq = this.killedSeq;
		return r;
	}
}

export function preferredAgentId(name: string): string {
	return `swarm~${name}`;
}

/** Fields restored from a roster record (on attach). */
export function memberFromRecord(name: string, rec: MemberRecord): Member {
	const role: Role = rec.role === "coordinator" || rec.role === "narrator" || rec.role === "monitor" ? rec.role : "worker";
	const m = new Member(name, role, rec.workspace ?? { mode: "inherit", path: "" }, rec.killed ? "killed" : "stopped");
	m.conversationId = typeof rec.conversation_id === "string" ? rec.conversation_id : "";
	m.agentId = typeof rec.agent_id === "string" && rec.agent_id ? rec.agent_id : preferredAgentId(name);
	// A loaded roster holds no live worker from the previous lease.
	m.stoppedCleanly = m.killed;
	m.gen = Number(rec.gen) || 1;
	m.model = rec.model ?? "";
	m.effort = rec.effort ?? "";
	m.addedBy = rec.added_by ?? "";
	m.addedAt = rec.added_at ?? "";
	m.fork = rec.fork ?? "";
	m.task = rec.task ?? "";
	m.briefSeq = Number(rec.brief_seq) || 0;
	m.briefPresented = rec.brief_presented === true;
	m.channels = Array.isArray(rec.channels) ? rec.channels : null;
	m.sessionFile = typeof rec.session_file === "string" ? rec.session_file : null;
	m.lastReadSeq = Number(rec.last_read_seq) || 0;
	m.wakeFloor = Number(rec.wake_floor) || 0;
	m.lastNudgedSeq = Number(rec.last_nudged_seq) || 0;
	m.lastParkBlockedSeq = Number(rec.last_park_blocked_seq) || 0;
	m.killed = rec.killed === true;
	m.killedAt = rec.killed_at ?? null;
	m.failure = rec.failure ?? null;
	m.addedSeq = Number(rec.added_seq) || 0;
	m.killedSeq = rec.killed ? (Number(rec.killed_seq) || Number.MAX_SAFE_INTEGER) : undefined;
	if (rec.wake_mode === "mentions" || rec.wake_mode === "anything") {
		m.lastPark = { mode: rec.wake_mode, since: Number(rec.wait_since) || 0, until: rec.wait_until ?? null };
	} else m.lastPark = rec.last_park ?? null;
	if (rec.stats) {
		m.stats.steps = Number(rec.stats.steps) || 0;
		m.stats.tokens = Number(rec.stats.tokens) || 0;
		m.stats.cost = Number(rec.stats.cost) || 0;
	}
	return m;
}
