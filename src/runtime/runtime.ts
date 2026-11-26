// SwarmRuntime: one per coordinator session id. Members, operations, the wake engine, notices,
// version/changedSince, persistence, metrics and lifecycle (add, kill, revive, finish, channels).

import { basename, join } from "node:path";
import { Board, type BoardMember, boardTime } from "../board/board.ts";
import { effectiveChannels, MAIN } from "../board/channels.ts";
import { type LoadResult, type StoreOptions, StorageError, SwarmStore } from "../board/store.ts";
import type {
	AbandonedItem,
	BoardMessage,
	ChannelRecord,
	Control,
	FinishMeta,
	Role,
	RosterFile,
	ScoutOverride,
	StoredSet,
	WorkspaceMode,
	WorkspaceRecord,
} from "../board/types.ts";
import { LIMITS, raceTimeout, type SwarmEnv, TIMING } from "../env.ts";
import { messageText } from "./activity.ts";
import { acknowledge, handoffPrompt, reconcile, release, settleToolDelivery, wakePendingFor } from "./delivery.ts";
import { completionCurrent, completionLabel, decide, declareIncomplete, evaluateQuiescence, liveTaskWork, liveWorkReason, owed, recordGateCompletion } from "./gate.ts";
import { type Member, memberFromRecord, Member as MemberClass, type Op, type OpKind, preferredAgentId, roleDefaultMode } from "./member.ts";
import { applyCoordinatorSwitch, QuotaCache } from "./models.ts";
import {
	type CoordinatorPort,
	type CreateWorkerOptions,
	type HostMessage,
	modelKey,
	type ModelInfo,
	type PendingSwitch,
	type RequestUsage,
	type SpendRefusal,
	type SessionFactory,
	type ThinkingCaps,
	type UsageKind,
	type WorkerSession,
	WorkerStartupUnstopped,
} from "./ports.ts";
import { compactedReminder, deliveryIdOf, onWorkerEvent } from "./settle.ts";
import { claim, standsByAtTurnEnd, turnEndModel } from "./waits.ts";
import { addWorktree, cwdInside, type DisposeResult, discardFreshWorktree, disposeWorkspace, type GitRunner, type PreparedGroup, prepareGroup, verifyWorktree } from "./workspace.ts";
import { restoredReminder, roleBlock, skillBody, workerContract } from "./prompts.ts";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { describeBase } from "./workspace.ts";
import { DEFAULT_WORKER_TOOLS, HARD_EXCLUDED_TOOLS, hasKey, NARRATOR_TOOLS } from "../env.ts";

export interface Outcome {
	value: "complete" | "complete_with_abandonment" | "quiescent_no_done" | "incomplete" | "coordinator_failed" | "aborted";
	reason: string;
	at: string;
	terminal: boolean;
}

export interface RuntimeDeps {
	makeFactory(sid: string): SessionFactory;
	caps: ThinkingCaps;
	makeMemberTools(rt: SwarmRuntime, m: Member, gen: number): unknown[];
	packageDir: string;
	defaultsDir: string;
	env: SwarmEnv;
	git: GitRunner;
	log(line: string): void;
	storeOptions?: StoreOptions;
}

export interface CommitOptions {
	channel?: string;
	control?: Control;
	finish?: FinishMeta;
}

export interface CommitResult {
	msg: BoardMessage;
	woke: string[];
	stopped: string[];
}

export interface ReserveSpec {
	name: string;
	task?: string;
}

export interface AddGroup {
	role: Role;
	brief: string;
	model: ModelInfo | undefined;
	effort: string | undefined;
	workspace: WorkspaceMode;
	channels: string[] | undefined;
	fork?: { source: string; file: string };
}

export interface AddOutcome {
	added: Member[];
	errors: { name: string; error: string }[];
	notes: string[];
}

export interface ReviveSkip {
	name: string;
	reason: string;
}

const MEMBER_TOOLS_BY_ROLE: Record<Role, readonly string[]> = {
	coordinator: [],
	worker: ["swarm", "post_message", "read_board", "swarm_wait"],
	narrator: ["read_board", "swarm_wait"],
	monitor: ["read_board", "swarm_wait", "post_message"],
};

class OpCancelled extends Error {}

function tokenCount(n: number | undefined): number {
	return n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;
}

export class SwarmRuntime {
	readonly sid: string;
	readonly dir: string;
	readonly ephemeral: boolean;
	readonly store: SwarmStore;
	readonly board: Board;
	readonly members = new Map<string, Member>();
	readonly coordinator: Member;
	readonly env: SwarmEnv;
	readonly deps: RuntimeDeps;
	readonly factory: SessionFactory;
	binding: CoordinatorPort;
	/** Ready URL from the UI's live board, if one is running. */
	webBoardLink?: () => string | undefined;
	title = "";
	scoutOverride: ScoutOverride | undefined;
	createdAt = new Date().toISOString();
	version = 0;
	/** Bumped when the coordinator's conversation is cleared; part of its transcript cursor epoch. */
	epoch = 0;
	outcome: Outcome | null = null;
	readonly gate = { refusals: 0, waiting: false };
	readonly stall = { timer: undefined as Timer | undefined, counts: new Map<string, number>(), interactiveStalled: false };
	readonly metrics = { gate_refusals: 0, stall_wakes: 0 };
	closing = false;
	finishing = false;
	recovered = false;
	repairs: string[] = [];
	coordinatorSwitch: PendingSwitch | undefined;
	coordinatorSwitchSeq = 0;
	readonly quota = new QuotaCache();
	readonly startedMono = performance.now();
	lastProgressMono = performance.now();
	readonly #listeners = new Set<() => void>();
	readonly #versionWaiters = new Set<() => void>();
	#flushTimer: Timer | undefined;
	#metricsTimer: Timer | undefined;
	#activityTimer: Timer | undefined;
	#keepAlive: Timer | undefined;
	#quiescenceQueued = false;
	#rootShutdownHadLiveWork = false;
	#mainAwaiting = false;
	#printWakeReleased = false;
	#noticeSeq = 0;
	#spendNotified = false;
	#lateUsage = false;
	/** Why the spend is unknown under a ceiling (a priced-less message used tokens); fails closed. */
	spendUnknown: string | undefined;
	#rosterText = "";
	readonly retained: { name: string; path: string; reason: string; cleanup: string }[] = [];

	private constructor(binding: CoordinatorPort, deps: RuntimeDeps, store: SwarmStore, ephemeral: boolean) {
		this.binding = binding;
		this.deps = deps;
		this.env = deps.env;
		this.sid = binding.sessionId;
		this.store = store;
		this.dir = store.dir;
		this.ephemeral = ephemeral;
		this.board = new Board({ boardMembers: () => this.#boardMembers() });
		this.factory = deps.makeFactory(this.sid);
		this.coordinator = new MemberClass("coordinator", "coordinator", { mode: "inherit", path: binding.cwd }, "idle");
		// The first swarm tool can create the runtime after the coordinator's agent_start.
		if (!binding.headless && binding.isStreaming()) {
			this.coordinator.phase = "working";
			this.coordinator.runId = 1;
			this.coordinator.stats.runs = 1;
		}
		this.coordinator.conversationId = this.sid;
		this.coordinator.authorized = true;
		this.members.set("coordinator", this.coordinator);
	}

	/** Opens (creating or loading) the swarm of the binding's session in `dir`. Throws LeaseError/CorruptBoardError. */
	static open(binding: CoordinatorPort, deps: RuntimeDeps, dir: string, ephemeral: boolean): SwarmRuntime {
		const { store, loaded } = SwarmStore.open(dir, binding.sessionId, deps.storeOptions);
		const rt = new SwarmRuntime(binding, deps, store, ephemeral);
		try {
			rt.#load(loaded);
		} catch (err) {
			store.close();
			throw err;
		}
		// A self switch the coordinator asked for before the swarm existed is now the runtime's.
		if (binding.pendingSelfSwitch) {
			rt.coordinatorSwitch = binding.pendingSelfSwitch;
			binding.pendingSelfSwitch = undefined;
		}
		rt.#printWakeReleased = binding.headless && completionCurrent(rt);
		rt.factory.setPrintWake(binding.headless && !rt.#printWakeReleased);
		rt.factory.observeCoordinatorUsage?.((bill, kind) => rt.#recordMeasuredUsage(rt.coordinator, bill.usage, bill.provider, bill.model, kind));
		return rt;
	}

	*#boardMembers(): Iterable<BoardMember> {
		for (const m of this.members.values())
			yield { name: m.name, role: m.role, addedSeq: m.addedSeq, killedSeq: m.killedSeq };
	}

	#load(loaded: LoadResult): void {
		this.refreshCoordinator();
		const roster = loaded.roster;
		this.repairs = loaded.repairs;
		if (!roster) {
			this.board.load(loaded.records);
			this.flushStructural();
			return;
		}
		this.title = roster.title;
		this.scoutOverride = roster.scout;
		this.spendUnknown = roster.spend_unknown;
		this.createdAt = roster.created_at;
		for (const [name, rec] of Object.entries(roster.members)) {
			if (!rec || typeof rec !== "object") continue;
			if (name === "coordinator") {
				this.coordinator.restoreReadState(rec);
				this.coordinator.lastNudgedSeq = Number(rec.last_nudged_seq) || 0;
				this.coordinator.restoreStats(rec);
				continue;
			}
			const m = memberFromRecord(name, rec);
			this.members.set(name, m);
			this.board.seedStoredSet(name, m.channels);
		}
		this.board.seedStoredSet("coordinator", null);
		this.board.load(loaded.records);
		const head = this.board.head;
		let clamped = false;
		for (const m of this.members.values()) {
			m.channels = this.board.storedSet(m.name);
			if (m.lastReadSeq > head) {
				m.lastReadSeq = head;
				clamped = true;
			}
			m.pruneAddressedRead(head);
			if (m.role === "coordinator") continue;
			if (!m.killed) {
				m.phase = "stopped";
				m.wakeMode = roleDefaultMode(m.role);
				if (!m.conversationId && !m.failure)
					m.failure = { kind: "start", text: "the process ended before this member's session existed", at: new Date().toISOString(), at_seq: head, count: 1 };
			}
		}
		if (clamped || loaded.repairs.length) this.recovered = true;
		const stopped = [...this.members.values()].filter(m => m.phase === "stopped");
		if (stopped.length) {
			const owedNames = stopped.filter(m => wakePendingFor(this, m).length > 0).map(m => m.name);
			this.coordinator.reminders.restored = restoredReminder(this.title || "untitled", stopped.length, owedNames);
		}
		for (const r of loaded.repairs) this.coordinatorNotice("storage", `board repaired on load: ${r}`);
		this.flushStructural();
	}

	// -------------------------------------------------------------------------
	// Binding, versions, listeners
	// -------------------------------------------------------------------------

	rebind(binding: CoordinatorPort): void {
		this.binding = binding;
		this.factory.setPrintWake(binding.headless && !this.closing && !this.#printWakeReleased);
		this.refreshCoordinator();
	}

	refreshCoordinator(): void {
		const c = this.coordinator;
		c.model = modelKey(this.binding.model());
		c.effort = this.binding.thinkingLevel() ?? "";
		c.workspace = { mode: "inherit", path: this.binding.cwd };
	}

	changed(): void {
		if (this.#printWakeReleased && !this.closing && !completionCurrent(this)) {
			this.#printWakeReleased = false;
			this.factory.setPrintWake(this.binding.headless);
		}
		this.version++;
		for (const cb of this.#listeners) {
			try {
				cb();
			} catch {}
		}
		const waiters = [...this.#versionWaiters];
		this.#versionWaiters.clear();
		for (const w of waiters) w();
		if (!this.#quiescenceQueued && !this.closing) {
			this.#quiescenceQueued = true;
			queueMicrotask(() => {
				this.#quiescenceQueued = false;
				if (!this.closing) evaluateQuiescence(this);
			});
		}
		this.keepAlive();
	}

	/** Activity-only changes (steps, activity line, spend) are coalesced to at most 4 per second. */
	changedActivity(): void {
		if (this.#activityTimer || this.closing) return;
		this.#activityTimer = setTimeout(() => {
			this.#activityTimer = undefined;
			this.changed();
		}, 250);
		this.#activityTimer.unref?.();
	}

	onChange(cb: () => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	/**
	 * Resolves when `version` differs from `v`, the deadline passes, or the signal aborts. The
	 * listener, timer and abort hook are registered synchronously and removed on every exit path.
	 */
	changedSince(v: number, deadline: number, signal?: AbortSignal): Promise<void> {
		if (this.version !== v || signal?.aborted || Date.now() >= deadline) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const done = (): void => {
			clearTimeout(timer);
			this.#versionWaiters.delete(done);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
		this.#versionWaiters.add(done);
		signal?.addEventListener("abort", done, { once: true });
		return promise;
	}

	log(line: string): void {
		this.deps.log(line);
	}

	// -------------------------------------------------------------------------
	// Persistence and metrics
	// -------------------------------------------------------------------------

	rosterSnapshot(): RosterFile {
		const members: RosterFile["members"] = {};
		for (const m of this.members.values()) members[m.name] = m.toRecord();
		return {
			version: 1,
			id: this.sid,
			title: this.title,
			created_at: this.createdAt,
			board_head: this.board.head,
			channels: [...this.board.channels()],
			...(this.scoutOverride ? { scout: this.scoutOverride } : {}),
			...(this.spendUnknown ? { spend_unknown: this.spendUnknown } : {}),
			members,
		};
	}

	/** Immediate checkpoint for structural changes (also fsyncs the journal). */
	flushStructural(): void {
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#writeRoster(true);
	}

	/** Coalesced checkpoint for cursor/state changes (≤ 250 ms lag; a lagging cursor only replays). */
	scheduleFlush(): void {
		if (this.#flushTimer || this.closing) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			this.#writeRoster(false);
		}, TIMING.flushDebounceMs);
	}

	#writeRoster(structural: boolean, snapshot?: RosterFile): void {
		try {
			const snap = snapshot ?? this.rosterSnapshot();
			this.store.writeRoster(snap, structural);
			this.#rosterText = JSON.stringify(snap, null, 1);
		} catch (err) {
			this.log(`omp-agy-swarm: roster checkpoint failed: ${(err as Error).message}`);
		}
	}

	/** The last flushed roster text (web Raw tab; never re-serialized per poll). */
	get rosterText(): string {
		return this.#rosterText;
	}

	/** Every request the swarm paid for, the members' native scouts included (the ceiling's measure). */
	totalSpend(): { tokens: number; cost: number } {
		let tokens = 0;
		let cost = 0;
		for (const m of this.members.values()) {
			tokens += m.stats.tokens + m.stats.scoutTokens;
			cost += m.stats.cost + m.stats.scoutCost;
		}
		return { tokens, cost };
	}

	/** The swarm's live spend as status and metrics.json report it (SW-13). */
	spendView(): { tokens: number; cost: number; ceiling: number | null; unknown?: string } {
		const s = this.totalSpend();
		return {
			tokens: s.tokens,
			cost: Number(s.cost.toFixed(6)),
			ceiling: this.env.maxCostUsd || null,
			...(this.spendUnknown !== undefined ? { unknown: this.spendUnknown } : {}),
		};
	}

	spendExceeded(): boolean {
		if (this.env.maxCostUsd <= 0) return false;
		return this.spendUnknown !== undefined || this.totalSpend().cost >= this.env.maxCostUsd;
	}

	/** Main can still report; this limits worker requests and native subagent admission. */
	spendRefusal(): SpendRefusal | undefined {
		const cap = this.env.maxCostUsd;
		if (cap <= 0) return;
		const spent = this.totalSpend().cost;
		if (!this.spendUnknown && spent < cap) return;
		const why = this.spendUnknown ? `unknown spend (${this.spendUnknown})` : `measured spend $${spent.toFixed(6)}`;
		return { spent, cap, message: `Swarm spend ceiling $${cap}: ${why}; no new worker model requests or subagents are admitted.` };
	}

	/**
	 * Live spend accounting on every completed assistant message (SW-13). Under a ceiling, a
	 * message that used tokens without a usable price makes the spend unknown, which fails closed
	 * exactly like reaching the ceiling.
	 */
	recordUsage(m: Member, msg: HostMessage): void {
		if (msg.usage) this.#recordMeasuredUsage(m, msg.usage, msg.provider, msg.model);
	}

	#recordMeasuredUsage(m: Member, usage: RequestUsage, provider?: string, model?: string, kind: UsageKind = "own"): void {
		const tokens = tokenCount(usage.totalTokens)
			|| tokenCount(usage.input) + tokenCount(usage.output) + tokenCount(usage.cacheRead) + tokenCount(usage.cacheWrite);
		const price = usage.cost?.total;
		const priced = typeof price === "number" && Number.isFinite(price) && price > 0;
		if (!tokens && !priced) return;
		if (kind === "scout") {
			m.stats.scoutTokens += tokens;
			if (priced) m.stats.scoutCost += price;
		} else {
			m.stats.tokens += tokens;
			if (priced) m.stats.cost += price;
		}
		if (this.env.maxCostUsd > 0 && tokens > 0 && !priced && this.spendUnknown === undefined)
			this.spendUnknown = `${m.name}'s ${provider ?? "?"}/${model ?? "?"} reported ${tokens} tokens without a price`;
		if (this.closing) {
			this.#lateUsage = true;
			return;
		}
		if (this.binding.mode === "tui") this.changedActivity();
		this.scheduleFlush();
		this.writeMetricsSoon();
		if (this.spendExceeded() && !this.#spendNotified) {
			this.#spendNotified = true;
			const total = this.totalSpend().cost.toFixed(4);
			const why =
				this.spendUnknown !== undefined
					? `swarm spend is unknown (${this.spendUnknown}; ceiling $${this.env.maxCostUsd})`
					: `swarm spend reached $${total} (ceiling $${this.env.maxCostUsd})`;
			this.coordinatorNotice("cost", `${why}; no new work is admitted. Requests already in flight may add to it.`);
			if (this.binding.headless)
				declareIncomplete(this, this.spendUnknown !== undefined ? `spend unknown under the $${this.env.maxCostUsd} ceiling` : `spend ceiling $${this.env.maxCostUsd} reached ($${total})`);
		}
	}

	metricsObject(): Record<string, unknown> {
		const members: Record<string, unknown> = {};
		let coordinator: Record<string, unknown> = {};
		for (const m of this.members.values()) {
			const row = {
				role: m.role,
				model: m.model,
				effort: m.effort,
				state: m.state,
				runs: m.stats.runs,
				steps: m.stats.steps,
				tokens: m.stats.tokens,
				cost: Number(m.stats.cost.toFixed(6)),
				scout_tokens: m.stats.scoutTokens,
				scout_cost: Number(m.stats.scoutCost.toFixed(6)),
				posts: this.board.postsBy(m.name).length,
				wakes: m.stats.wakes,
				nudges: m.stats.nudges,
				failures: m.stats.failures,
				killed: m.killed,
			};
			if (m.role === "coordinator")
				coordinator = { ...row, gate_refusals: this.metrics.gate_refusals, stall_wakes: this.metrics.stall_wakes };
			else members[m.name] = row;
		}
		return {
			sid: this.sid,
			title: this.title,
			mode: this.binding.headless ? "headless" : "interactive",
			started_at: this.createdAt,
			ended_at: this.closing ? new Date().toISOString() : null,
			outcome: this.outcome ? { value: this.outcome.value, reason: this.outcome.reason, at: this.outcome.at } : null,
			head: this.board.head,
			spend: this.spendView(),
			members,
			coordinator,
			retained_workspaces: this.retained,
			recovered: this.recovered,
		};
	}

	writeMetrics(): void {
		clearTimeout(this.#metricsTimer);
		this.#metricsTimer = undefined;
		try {
			const path = join(this.dir, "metrics.json");
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(this.metricsObject(), null, 1)}\n`, { mode: 0o600 });
			renameSync(tmp, path);
		} catch (err) {
			this.log(`omp-agy-swarm: metrics write failed: ${(err as Error).message}`);
		}
	}

	writeMetricsSoon(): void {
		if (this.#metricsTimer || this.closing) return;
		this.#metricsTimer = setTimeout(() => this.writeMetrics(), TIMING.metricsDebounceMs);
		this.#metricsTimer.unref?.();
	}

	// -------------------------------------------------------------------------
	// Keep-alive, progress budgets, stuck detection
	// -------------------------------------------------------------------------

	/** One ref'd interval while any waiter, operation or gate wait exists (§6.2). */
	keepAlive(): void {
		const needed =
			!this.closing &&
			(this.gate.waiting || [...this.members.values()].some(m => !!m.waiter || !!m.op || m.awaiting || m.phase === "working" || m.phase === "starting"));
		if (needed && !this.#keepAlive) this.#keepAlive = setInterval(() => this.#tick(), TIMING.keepAliveMs);
		else if (!needed && this.#keepAlive) {
			clearInterval(this.#keepAlive);
			this.#keepAlive = undefined;
		}
	}

	#tick(): void {
		if (this.closing) return;
		const now = Date.now();
		for (const m of this.members.values()) {
			if (m.role !== "worker" || m.killed) continue;
			const waiter = m.waiter;
			if (waiter && m.session?.wakeSources?.queued) claim(this, m, waiter.id, "job");
			if (m.phase !== "working" || m.stuckNotified) continue;
			if (m.tracker.lastEventAt && now - m.tracker.lastEventAt > TIMING.stuckMs) {
				m.stuckNotified = true;
				this.noticeToCoordinator(m, "stuck", `${m.name} has shown no activity for ${Math.round(TIMING.stuckMs / 60_000)} minutes while working.`);
			}
		}
		if (!this.binding.headless || this.outcome?.terminal) return;
		const c = this.coordinator;
		if ((c.phase === "parked" || this.gate.waiting) && this.noProgressExceeded())
			declareIncomplete(this, `no progress for ${this.env.noProgressSeconds} s`);
		else if (this.deadlineExceeded()) declareIncomplete(this, `run deadline of ${this.env.deadlineSeconds} s passed`);
	}

	progress(): void {
		this.lastProgressMono = performance.now();
		this.gate.refusals = 0;
	}

	noProgressExceeded(): boolean {
		return this.env.noProgressSeconds > 0 && performance.now() - this.lastProgressMono > this.env.noProgressSeconds * 1000;
	}

	/** Monotonic wall-clock run deadline (headless; bounds spend even when "progress" repeats). */
	deadlineExceeded(): boolean {
		return this.env.deadlineSeconds > 0 && performance.now() - this.startedMono > this.env.deadlineSeconds * 1000;
	}

	// -------------------------------------------------------------------------
	// Operations (§3.4)
	// -------------------------------------------------------------------------

	/** Starts an operation; start/revive/kill mint the new generation together with installing the op. */
	beginOp(m: Member, kind: OpKind): Op {
		if (m.op) {
			m.op.cancelled = true;
			m.op.abort.abort();
		}
		const gen = kind === "switch" ? m.gen : ++m.gen;
		const op: Op = { kind, gen, cancelled: false, abort: new AbortController() };
		m.op = op;
		this.keepAlive();
		return op;
	}

	opValid(m: Member, op: Op, ended = false): boolean {
		return !this.closing && !m.killed && m.gen === op.gen && !op.cancelled && (ended || m.op === op);
	}

	#cancelOp(m: Member): void {
		if (!m.op) return;
		m.op.cancelled = true;
		m.op.abort.abort();
		m.op = undefined;
	}

	/**
	 * Detaches a worker whose abandoned run did not stop: a new generation (no op is installed)
	 * makes its tools refuse and its events be ignored, the session is disposed in the
	 * background, and the member is left stopped (revivable from its transcript).
	 */
	#detachForAbandon(m: Member, session: WorkerSession, timedOut: boolean): Promise<void> {
		if (m.session !== session) return Promise.resolve();
		this.#detachMember(m, "aborted");
		m.phase = "stopped";
		if (timedOut)
			m.failure = { kind: "error", text: "did not stop when finish abandoned its work", at: new Date().toISOString(), at_seq: this.board.head, count: (m.failure?.count ?? 0) + 1 };
		const disposal = session.dispose();
		this.#trackDrain(m, disposal);
		this.flushStructural();
		this.changed();
		return disposal;
	}

	// -------------------------------------------------------------------------
	// Notices
	// -------------------------------------------------------------------------

	queueNotice(target: Member, kind: string, text: string): void {
		if (target.killed || this.closing) return;
		target.notices.push({ id: ++this.#noticeSeq, kind, text: text.slice(0, LIMITS.noticeChars), at: Date.now() });
		while (target.notices.length > LIMITS.noticeQueue) {
			target.notices.shift();
			target.droppedNotices++;
		}
		if (target.waiter) claim(this, target, target.waiter.id, "notice");
		else reconcile(this, target);
		this.changed();
	}

	coordinatorNotice(kind: string, text: string): void {
		this.queueNotice(this.coordinator, kind, text);
	}

	/** A notice about `subject` for the coordinator and, when it is a live worker, its adder. */
	noticeToCoordinator(subject: Member, kind: string, text: string): void {
		this.coordinatorNotice(kind, text);
		const adder = this.members.get(subject.addedBy);
		if (adder && adder.role === "worker" && !adder.killed && adder.phase !== "stopped") this.queueNotice(adder, kind, text);
	}

	// -------------------------------------------------------------------------
	// Posts and the wake engine (§5.3, §6.4)
	// -------------------------------------------------------------------------

	/** Synchronous: durable append first, then memory, ring sets and the wake engine. */
	commitPost(author: Member, text: string, opts: CommitOptions = {}): CommitResult | { error: string } {
		if (this.closing) return { error: "the swarm is shutting down; nothing was posted" };
		if (author.killed || (this.finishing && author.role !== "coordinator")) return { error: "the member is stopping; nothing was posted" };
		const now = Date.now();
		const record = {
			seq: this.board.head + 1,
			agent: author.name,
			text,
			time: boardTime(now),
			ts: now,
			...(opts.channel && opts.channel !== MAIN ? { channel: opts.channel } : {}),
			...(opts.control ? { control: opts.control } : {}),
			...(opts.finish ? { finish: opts.finish } : {}),
		};
		try {
			this.store.appendRecord(record);
		} catch (err) {
			const msg = err instanceof StorageError ? err.message : String(err);
			this.coordinatorNotice("storage", `board storage failed: ${msg}`);
			this.changed();
			return { error: `board storage failed: ${msg}; nothing was posted` };
		}
		const posted = this.board.append(record);
		if (!posted.control) {
			author.stats.posts++;
			if (author.cycle) author.cycle.posted = true;
			if (!author.isRoleWorker) this.progress();
		}
		const { woke, stopped } = posted.control ? { woke: [], stopped: [] } : this.#wakeEngine(posted);
		this.scheduleFlush();
		this.changed();
		return { msg: posted, woke, stopped };
	}

	#wakeEngine(p: BoardMessage): { woke: string[]; stopped: string[] } {
		const woke: string[] = [];
		const stopped: string[] = [];
		for (const m of this.members.values()) {
			if (m.name === p.agent || m.killed || m.phase === "starting" || m.op) continue;
			if (m.role === "worker" && this.finishing) continue;
			const rings = (mode: string): boolean => (mode === "mentions" ? p.ring.mentions.has(m.name) : p.ring.sees.has(m.name));
			if (m.phase === "parked" && m.waiter) {
				if (rings(m.waiter.mode)) {
					m.lastNudgedSeq = p.seq;
					if (claim(this, m, m.waiter.id, "post", { trigger: p.seq })) woke.push(m.name);
				}
			} else if (m.phase === "idle") {
				if (rings(roleDefaultMode(m.role))) {
					m.lastNudgedSeq = p.seq;
					if (m.failure) m.retryToken = true;
					m.redeliveryExhausted = false;
					reconcile(this, m);
					if (m.delivery) woke.push(m.name);
				}
			} else if (m.phase === "working" && rings("mentions")) {
				m.redeliveryExhausted = false;
				const previous = m.delivery;
				reconcile(this, m);
				if (!previous && m.delivery) woke.push(m.name);
			} else if (m.phase === "stopped") {
				if (rings(roleDefaultMode(m.role))) {
					// SW-09: a post never starts an unattended agent; revival needs swarm{action:"revive"} (exec).
					stopped.push(m.name);
					if (!m.reviveNoticeSent) {
						m.reviveNoticeSent = true;
						this.coordinatorNotice(
							"revive_needed",
							`${m.name} is stopped and has unread posts addressed to it (#${p.seq}); swarm{action:"revive", name:"${m.name}"} starts it again.`,
						);
					}
				}
			}
		}
		return { woke, stopped };
	}

	// -------------------------------------------------------------------------
	// Member lookups
	// -------------------------------------------------------------------------

	/** An exact member name wins over a numbered-group prefix. */
	expand(name: string): Member[] {
		const exact = this.members.get(name);
		if (exact) return [exact];
		const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`);
		return [...this.members.values()].filter(m => re.test(m.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	}

	workersOf(role: Role): Member[] {
		return [...this.members.values()].filter(m => m.role === role && !m.killed);
	}

	nonKilledCount(): number {
		let n = 0;
		for (const m of this.members.values()) if (m.role !== "coordinator" && !m.killed) n++;
		return n;
	}

	defaultChannel(m: Member): string {
		const set = m.channels;
		const first = Array.isArray(set) ? set.find(c => c !== "*" && c !== MAIN) : undefined;
		return first ?? MAIN;
	}

	/** Normalized effective channels: ["main", …] or ["all"]. */
	channelsView(m: Member): string[] {
		const eff = effectiveChannels(m.role, m.channels, m.name);
		if (eff.includes("*")) return ["all"];
		return [MAIN, ...eff.filter(c => c !== MAIN)];
	}

	callerCwd(caller: Member): string {
		return caller.role === "coordinator" ? this.binding.cwd : caller.workspace.path;
	}

	// -------------------------------------------------------------------------
	// add (§3.5 with SW-01/02)
	// -------------------------------------------------------------------------

	/** Step A4: synchronous reservation of every expanded name before the first await. */
	reserve(caller: Member, specs: readonly ReserveSpec[], group: AddGroup): Member[] {
		const head = this.board.head;
		const out: Member[] = [];
		for (const spec of specs) {
			const m = new MemberClass(spec.name, group.role, { mode: group.workspace, path: "" }, "starting");
			m.gen = 1;
			m.op = { kind: "start", gen: 1, cancelled: false, abort: new AbortController() };
			m.addedBy = caller.name;
			m.addedAt = new Date().toISOString();
			m.addedSeq = head;
			m.lastReadSeq = head;
			m.brief = group.brief;
			m.task = spec.task ?? "";
			m.fork = group.fork?.source ?? "";
			m.channels = group.channels ?? null;
			m.model = modelKey(group.model);
			m.effort = group.effort ?? "";
			m.agentId = preferredAgentId(spec.name);
			m.authorized = true;
			this.members.set(spec.name, m);
			this.board.seedStoredSet(spec.name, m.channels);
			out.push(m);
		}
		this.flushStructural();
		this.changed();
		return out;
	}

	/** Steps B and C: workspace, session, brief, prompt handoff (≤ 4 in parallel). */
	async startReserved(caller: Member, members: Member[], group: AddGroup): Promise<AddOutcome> {
		const outcome: AddOutcome = { added: [], errors: [], notes: [] };
		// The group's shared preparation (one snapshot) is cancelled only when every member it
		// serves is cancelled (shutdown cancels them all); one sibling's kill never fails the rest.
		const groupAbort = new AbortController();
		const onMemberAbort = (): void => {
			if (members.every(x => !x.op || x.op.cancelled || x.killed)) groupAbort.abort();
		};
		const signals = members.map(m => m.op?.abort.signal).filter((s): s is AbortSignal => !!s);
		for (const s of signals) s.addEventListener("abort", onMemberAbort);
		let prepared: Promise<PreparedGroup> | undefined;
		const prepare = (): Promise<PreparedGroup> => {
			if (!prepared) {
				const mode = group.workspace === "share" ? "share" : "branch";
				prepared = prepareGroup(this.deps.git, mode, this.callerCwd(caller), this.dir, this.sid, this.env.shareMaxMb, groupAbort.signal);
				prepared.then(g => outcome.notes.push(...g.notes)).catch(() => {});
			}
			return prepared;
		};
		const queue = [...members];
		const worker = async (): Promise<void> => {
			for (let m = queue.shift(); m; m = queue.shift()) {
				const task = this.#startOne(caller, m, group, prepare, outcome.notes);
				m.opSettled = task;
				const r = await task;
				if (r === true) outcome.added.push(m);
				else if (typeof r === "string") outcome.errors.push({ name: m.name, error: r });
				else if (r && r.note) outcome.notes.push(r.note);
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(LIMITS.addParallel, members.length) }, worker));
		} finally {
			for (const s of signals) s.removeEventListener("abort", onMemberAbort);
		}
		return outcome;
	}

	async #startOne(
		caller: Member,
		m: Member,
		group: AddGroup,
		prepare: () => Promise<PreparedGroup>,
		notes: string[],
	): Promise<true | string | { note: string } | null> {
		const op = m.op;
		if (!op) return null;
		let ws: WorkspaceRecord | undefined;
		let session: WorkerSession | undefined;
		const check = (): void => {
			if (!this.opValid(m, op)) throw new OpCancelled();
		};
		try {
			if (group.role === "narrator") ws = { mode: "inherit", path: this.dir };
			else if (group.workspace === "inherit") ws = { mode: "inherit", path: this.callerCwd(caller) };
			else {
				const g = await prepare();
				check();
				const r = await addWorktree(this.deps.git, g, this.dir, this.sid, m.name, op.abort.signal);
				ws = r.ws;
				// Recorded before the next check: a kill that cancelled us disposes this worktree.
				m.workspace = ws;
				notes.push(...r.notes);
				check();
			}
			m.workspace = ws;
			const model = group.model;
			const toolNames = this.toolNamesFor(m.role);
			const contract = this.#appendPrompt(m, ws, model);
			session = await this.factory.create({
				name: m.name,
				role: m.role === "narrator" || m.role === "monitor" ? m.role : "worker",
				agentId: m.agentId,
				brief: m.task || m.brief,
				signal: op.abort.signal,
				...this.#hostHooks(m, op.gen),
				cwd: ws.path,
				sessionsDir: join(this.dir, "sessions"),
				model,
				effort: group.effort,
				// Scout settings are snapshotted for this generation, not hot-switched.
				scoutOverride: this.scoutOverride,
				checkSwarmSpend: this.env.maxCostUsd > 0 ? () => this.spendRefusal() : undefined,
				onOwnedUsage: (bill, kind) => this.#recordMeasuredUsage(m, bill.usage, bill.provider, bill.model, kind),
				toolNames,
				customTools: this.deps.makeMemberTools(this, m, op.gen),
				appendSystemPrompt: contract,
				mode: group.fork ? { kind: "fork", sourceFile: group.fork.file } : { kind: "new" },
				enableLsp: m.role === "worker",
			});
			check();
			this.#attachSession(m, session, op.gen);
			const brief = `@${m.name} ${group.brief}${m.task ? `\n\nYour slice: ${m.task}` : ""}`;
			const channel = Array.isArray(m.channels) ? m.channels.find(c => c !== "*") : undefined;
			const r = this.commitPost(caller, brief, { channel });
			if ("error" in r) throw new Error(r.error);
			m.briefSeq = r.msg.seq;
			this.flushStructural();
			handoffPrompt(this, m);
			return true;
		} catch (err) {
			const cancelled = err instanceof OpCancelled || !this.opValid(m, op);
			if (err instanceof WorkerStartupUnstopped) op.disposal = err.disposal;
			if (session && !m.session) {
				op.disposal = session.dispose();
				await settleWithin(op.disposal, TIMING.killStopMs);
			}
			if (cancelled) {
				if (m.killed || this.closing || m.gen !== op.gen) return null;
				if (op.cancelled && m.phase !== "killed") {
					if (op.disposal) this.#trackDrain(m, op.disposal);
					m.phase = "stopped";
					m.failure = { kind: "start", text: "abandoned before its session started", at: new Date().toISOString(), at_seq: this.board.head, count: 1 };
					this.flushStructural();
					this.changed();
				}
				return null;
			}
			// Construction failed: free the name and slot; remove a worktree nobody used.
			if (m.session) {
				const live = m.session;
				this.#detachMember(m, "closing");
				op.disposal = live.dispose();
				if (await settleWithin(op.disposal, TIMING.killStopMs)) op.disposal = undefined;
				if (m.killed || this.closing) return null;
			}
			if (op.disposal) {
				m.op = undefined;
				m.phase = "stopped";
				m.failure = { kind: "start", text: "session construction failed and did not stop in time", at: new Date().toISOString(), at_seq: this.board.head, count: 1 };
				this.#trackDrain(m, op.disposal);
				this.flushStructural();
				this.changed();
				return m.failure.text;
			}
			if (ws && ws.mode !== "inherit") await discardFreshWorktree(this.deps.git, ws).catch(() => {});
			this.members.delete(m.name);
			this.flushStructural();
			this.changed();
			return err instanceof Error ? err.message : String(err);
		}
	}

	toolNamesFor(role: Role): string[] {
		const active = new Set(this.binding.activeTools());
		let builtins: readonly string[];
		if (role === "worker") builtins = this.env.workerTools ?? DEFAULT_WORKER_TOOLS;
		else if (role === "narrator") builtins = NARRATOR_TOOLS;
		else builtins = [];
		const allowed = builtins.filter(t => !hasKey(HARD_EXCLUDED_TOOLS, t) && active.has(t));
		return [...new Set([...allowed, ...MEMBER_TOOLS_BY_ROLE[role]])];
	}

	#appendPrompt(m: Member, ws: WorkspaceRecord, model: ModelInfo | undefined): string {
		const contract = workerContract({
			name: m.name,
			addedBy: m.addedBy,
			workspace: ws,
			cwd: ws.path,
			baseDesc: describeBase(ws),
			swarmDir: this.dir,
			backgroundJobs: m.role === "worker",
			turnEndStandby: turnEndModel(model),
		});
		if (m.role !== "narrator" && m.role !== "monitor") return contract;
		let body = "";
		try {
			body = skillBody(readFileSync(join(this.deps.packageDir, "skills", `swarm_${m.role}`, "SKILL.md"), "utf8"));
		} catch {}
		return `${contract}\n${roleBlock(m.role, this.dir, this.deps.defaultsDir, body)}`;
	}

	#attachSession(m: Member, session: WorkerSession, gen: number): void {
		m.agentId = session.agentId;
		m.session = session;
		m.conversationId = session.sessionId;
		m.sessionFile = session.sessionFile ? basename(session.sessionFile) : null;
		m.model = modelKey(session.model) || m.model;
		m.effort = session.thinkingLevel ?? "";
		m.expectedModel = m.model;
		m.expectedEffort = m.effort;
		m.stoppedCleanly = false;
		m.drain = undefined;
		m.unsubscribe = session.subscribe(ev => onWorkerEvent(this, m, gen, ev));
		this.flushStructural();
	}

	// -------------------------------------------------------------------------
	// kill (§6.10 with SW-06)
	// -------------------------------------------------------------------------

	kill(m: Member, opts: { discardIgnored: boolean; keepWorkspace: boolean }): Promise<DisposeResult | null> {
		if (m.killPromise) return m.killPromise;
		const session = m.session;
		const pending = m.opSettled;
		const op = m.op;
		const drain = m.drain?.promise;
		return this.#startKill(m, opts, m.killed ? undefined : async () => {
			await Promise.all([session?.stop(), pending, drain]);
			await op?.disposal;
		});
	}

	#hostHooks(m: Member, gen: number): Pick<CreateWorkerOptions, "onHostKill" | "onHostDispose" | "onHostRelease"> {
		const current = (): boolean => !this.closing && !m.killed && m.gen === gen && this.members.get(m.name) === m;
		const release = Promise.withResolvers<() => Promise<void>>();
		return {
			onHostKill: identity => {
				if (!current()) return;
				m.agentId = identity.agentId;
				m.conversationId = identity.sessionId;
				m.sessionFile = identity.sessionFile ? basename(identity.sessionFile) : m.sessionFile;
				const pending = m.opSettled;
				const op = m.op;
				const stopped = release.promise.then(async confirmIdle => {
					await pending;
					await op?.disposal;
					await confirmIdle();
				});
				void this.#startKill(m, { discardIgnored: false, keepWorkspace: false }, () => stopped)
					.catch(err => this.log(`omp-agy-swarm: ${m.name}: native stop cleanup: ${String(err)}`));
				this.coordinatorNotice("worker_stopped", `${m.name} was stopped in omp and permanently killed in the swarm.`);
			},
			onHostDispose: (identity, rootClosing, closed) => {
				if (!current()) return;
				if (rootClosing && !this.#rootShutdownHadLiveWork) this.#rootShutdownHadLiveWork = liveTaskWork(this).includes(m);
				m.agentId = identity.agentId;
				m.conversationId = identity.sessionId;
				m.sessionFile = identity.sessionFile ? basename(identity.sessionFile) : m.sessionFile;
				if (m.phase === "parked") m.lastPark = { mode: m.wakeMode, since: m.waitSince, until: m.waitUntil };
				const pending = m.opSettled;
				this.#trackDrain(m, closed.finally(async () => { await pending; }));
				this.#detachMember(m, "closing");
				m.phase = "stopped";
				this.flushStructural();
				this.changed();
			},
			onHostRelease: release.resolve,
		};
	}

	#trackDrain(m: Member, promise: Promise<void>): void {
		const drain = { promise, pending: true };
		m.drain = drain;
		void promise.then(() => {
			if (m.drain === drain) m.drain = undefined;
		}, () => { drain.pending = false; });
	}

	#detachMember(m: Member, reason: "closing" | "killed" | "aborted"): void {
		m.gen++;
		m.awaiting = false;
		m.runSawError = false;
		this.#cancelOp(m);
		m.unsubscribe?.();
		m.unsubscribe = undefined;
		if (m.delivery) clearTimeout(m.delivery.receiptTimer);
		m.delivery = undefined;
		m.pendingSwitch = undefined;
		m.nudgePending = false;
		clearTimeout(m.reconcileTimer);
		m.reconcileTimer = undefined;
		if (m.waiter) claim(this, m, m.waiter.id, reason);
		m.session = undefined;
	}

	#startKill(m: Member, opts: { discardIgnored: boolean; keepWorkspace: boolean }, stop?: () => Promise<void>): Promise<DisposeResult | null> {
		const result = Promise.withResolvers<DisposeResult | null>();
		m.killPromise = result.promise; // Install before notifying listeners or cancelling a pending create.
		let stopped: Promise<boolean> | undefined;
		if (stop) {
			m.killed = true;
			m.killedAt = new Date().toISOString();
			m.killedSeq = this.board.head;
			m.notices = [];
			this.#detachMember(m, "killed");
			m.phase = "killed";
			this.flushStructural();
			const confirmed = stop().then(() => { m.stoppedCleanly = true; });
			stopped = settleWithin(confirmed, TIMING.killStopMs);
			this.changed();
		}
		Promise.resolve().then(async () => {
			await stopped;
			if (this.closing) return null;
			const res = await this.#disposeWs(m, opts);
			if (!this.closing) this.#reevaluateRetainedForDependents();
			return res;
		}).then(
			value => { m.killPromise = undefined; result.resolve(value); },
			err => { m.killPromise = undefined; result.reject(err); },
		);
		return result.promise;
	}

	#dependentsOf(m: Member): string[] {
		const root = m.workspace.root;
		if (!root) return [];
		return [...this.members.values()]
			.filter(o => o !== m && !o.killed && o.workspace.mode === "inherit" && o.workspace.path && cwdInside(o.workspace.path, root))
			.map(o => o.name);
	}

	async #disposeWs(m: Member, opts: { discardIgnored: boolean; keepWorkspace: boolean }): Promise<DisposeResult | null> {
		const res = await disposeWorkspace(this.deps.git, m.workspace, {
			sid: this.sid,
			name: m.name,
			discardIgnored: opts.discardIgnored,
			keepWorkspace: opts.keepWorkspace,
			dependents: this.#dependentsOf(m),
			stoppedCleanly: m.stoppedCleanly,
		});
		if (!res) return null;
		if (this.closing) return res;
		m.workspace.state = res.state;
		const idx = this.retained.findIndex(r => r.name === m.name);
		if (idx >= 0) this.retained.splice(idx, 1);
		if (res.state === "retained") {
			m.workspace.retained_reason = res.reason;
			m.workspace.cleanup = res.cleanup;
			this.retained.push({ name: m.name, path: res.path ?? "", reason: res.reason ?? "", cleanup: res.cleanup ?? "" });
			this.coordinatorNotice("workspace_retained", `${m.name}'s workspace ${res.path} was kept: ${res.reason}`);
		} else {
			delete m.workspace.retained_reason;
			delete m.workspace.cleanup;
		}
		this.flushStructural();
		this.writeMetrics();
		this.changed();
		return res;
	}

	#reevaluateRetainedForDependents(): void {
		for (const o of this.members.values()) {
			if (!o.killed || o.workspace.state !== "retained" || !o.workspace.retained_reason?.startsWith("in use by")) continue;
			if (this.#dependentsOf(o).length === 0) void this.#disposeWs(o, { discardIgnored: false, keepWorkspace: false });
		}
	}

	// -------------------------------------------------------------------------
	// revive (§6.9 with SW-01 and SW-09)
	// -------------------------------------------------------------------------

	/** Explicit, exec-approved revival. Returns a skip reason, or undefined when it started. */
	revive(m: Member): string | undefined {
		if (this.closing) return "the swarm is shutting down";
		if (this.finishing) return "finish is in progress";
		if (m.killed) return "killed";
		if (m.op) return m.op.kind === "revive" ? "already reviving" : `busy (${m.op.kind})`;
		if (m.phase !== "stopped") return `not stopped (${m.state})`;
		if (m.drain?.pending) return "the previous session has not finished closing";
		if (m.failure?.kind === "lost") return `lost: ${m.failure.text}`;
		if (m.failure?.kind === "start" || !m.conversationId || !m.sessionFile) return "never started: kill it and add a replacement";
		if (this.spendExceeded()) return "the spend ceiling was reached";
		const op = this.beginOp(m, "revive");
		m.phase = "starting";
		m.authorized = true;
		m.reviveNoticeSent = false;
		this.changed();
		m.opSettled = this.#runRevive(m, op);
		return undefined;
	}

	async #runRevive(m: Member, op: Op): Promise<void> {
		const fail = (kind: "lost" | "workspace_missing" | "model_unavailable" | "error", text: string): void => {
			if (!this.opValid(m, op)) return;
			m.op = undefined;
			m.phase = "stopped";
			m.failure = { kind, text: text.slice(0, LIMITS.failureTextChars), at: new Date().toISOString(), at_seq: this.board.head, count: (m.failure?.count ?? 0) + 1 };
			this.flushStructural();
			this.coordinatorNotice("revive_failed", `${m.name} could not be revived (${kind}): ${text}`);
			this.changed();
		};
		const file = join(this.dir, "sessions", basename(m.sessionFile ?? ""));
		if (!(await verifyWorktree(this.deps.git, m.workspace))) return fail("workspace_missing", `workspace ${m.workspace.path} is missing or not the recorded worktree`);
		if (!this.opValid(m, op)) return;
		const model = this.binding.models().find(x => modelKey(x) === m.model);
		if (m.model && !model) return fail("model_unavailable", `${m.model} is not available; set another with swarm{action:"model", name:"${m.name}", model:"…"}`);
		let session: WorkerSession;
		try {
			const toolNames = this.toolNamesFor(m.role);
			session = await this.factory.create({
				name: m.name,
				role: m.role === "narrator" || m.role === "monitor" ? m.role : "worker",
				agentId: m.agentId,
				brief: m.task || m.brief,
				signal: op.abort.signal,
				...this.#hostHooks(m, op.gen),
				cwd: m.workspace.path,
				sessionsDir: join(this.dir, "sessions"),
				model,
				effort: m.effort || undefined,
				scoutOverride: this.scoutOverride,
				checkSwarmSpend: this.env.maxCostUsd > 0 ? () => this.spendRefusal() : undefined,
				onOwnedUsage: (bill, kind) => this.#recordMeasuredUsage(m, bill.usage, bill.provider, bill.model, kind),
				toolNames,
				customTools: this.deps.makeMemberTools(this, m, op.gen),
				appendSystemPrompt: this.#appendPrompt(m, m.workspace, model),
				mode: { kind: "revive", file, conversationId: m.conversationId },
				enableLsp: m.role === "worker",
			});
		} catch (err) {
			if (err instanceof WorkerStartupUnstopped) {
				op.disposal = err.disposal;
				if (this.opValid(m, op)) this.#trackDrain(m, op.disposal);
				return fail("error", err.message);
			}
			const text = err instanceof Error ? err.message : String(err);
			const lost = /ENOENT|no such file|missing|does not match|conversation/i.test(text);
			return fail(lost ? "lost" : "error", lost ? `transcript missing or mismatched: ${text}` : text);
		}
		if (!this.opValid(m, op)) {
			op.disposal = session.dispose();
			if (!m.killed && !this.closing && m.gen === op.gen) this.#trackDrain(m, op.disposal);
			await settleWithin(op.disposal, TIMING.killStopMs);
			return;
		}
		this.#attachSession(m, session, op.gen);
		m.failure = null;
		m.retryToken = false;
		m.redeliveryExhausted = false;
		m.redeliveryAttempts = 0;
		m.notBefore = 0;
		const endsTurn = standsByAtTurnEnd(this, m);
		if (m.role === "worker") {
			m.reminders.resume = `You are live again. Background jobs from the previous session are not resumed (including native scouts); check their outputs before restarting work. For standby, ${endsTurn ? "end your turn" : "call untimed swarm_wait{}"}.`;
		} else if (m.briefPresented) {
			// The monitor's waits are timed, so they keep parking.
			m.reminders.resume = `You are live again. Unless the posts below need action, ${endsTurn && m.role === "narrator" ? "end your turn" : "call swarm_wait again"}.`;
		}
		this.flushStructural();
		handoffPrompt(this, m);
	}

	// -------------------------------------------------------------------------
	// finish (§7.2 with SW-03 and SW-14)
	// -------------------------------------------------------------------------

	async finish(summary: string, abandon: boolean): Promise<{ seq: number; abandoned: AbandonedItem[] } | { error: string }> {
		if (!abandon) {
			const live = liveTaskWork(this);
			const o = owed(this);
			if (live.length || o.posts.length || o.notices) {
				const parts: string[] = [];
				if (live.length) parts.push(live.map(m => liveWorkReason(m, true)).join(" "));
				if (o.posts.length || o.notices) {
					const unread = [o.posts.length ? `posts ${o.posts.map(s => `#${s}`).join(", ")}` : "", o.notices ? `${o.notices} notices` : ""].filter(Boolean);
					parts.push(`Read unread ${unread.join(" and ")} before retrying.`);
				}
				return { error: `Cannot finish: ${parts.join(" ")}` };
			}
			const r = this.commitPost(this.coordinator, `[done] ${summary}`);
			if ("error" in r) return r;
			return { seq: r.msg.seq, abandoned: [] };
		}
		this.finishing = true;
		const abandoned: AbandonedItem[] = [];
		const deadlineAt = Date.now() + TIMING.killStopMs;
		const disposals: Promise<boolean>[] = [];
		const stops: { m: Member; session: WorkerSession; item: AbandonedItem; settled: Promise<boolean> }[] = [];
		try {
			for (const m of this.members.values()) {
				if (m.role !== "worker" || m.killed) continue;
				const unread = wakePendingFor(this, m).map(p => p.seq);
				const notices = m.notices.length;
				const session = m.session;
				const asyncWork = m.awaiting || !!session?.hasBackgroundWork;
				let was: string;
				if (m.op) was = m.op.kind === "start" ? "starting" : m.op.kind === "revive" ? "reviving" : "switching";
				else if (m.phase === "stopped") was = "stopped";
				else if (m.phase === "parked") was = m.waiter?.deadline !== undefined ? "waiting with a timeout" : asyncWork ? "in swarm_wait with background work" : "";
				else if (asyncWork) was = m.hostWorking || m.phase === "working" ? "working with pending background work" : "waiting on background work";
				else if (m.phase === "idle") was = m.delivery || m.reconcileTimer ? "about to be woken" : m.nudgePending ? "owed a nudge" : "";
				else was = "working";
				if (!was && unread.length === 0 && notices === 0) continue;
				const item: AbandonedItem = { name: m.name, was: was || "waiting", ...(unread.length ? { unread } : {}), ...(notices ? { notices } : {}) };
				abandoned.push(item);
				const queuedAside = m.delivery?.status === "dispatched" && m.delivery.addressedSeqs !== undefined;
				if (session && (asyncWork || queuedAside)) {
					m.notices = [];
					item.was += queuedAside ? "; session detached to stop a queued wake" : "; session detached to stop background work";
					disposals.push(settleWithin(this.#detachForAbandon(m, session, false), Math.max(0, deadlineAt - Date.now())).then(settled => {
						if (!settled) item.was += "; stop not confirmed";
						return settled;
					}));
					continue;
				}
				// Cancelled operations never post: start, revive and switch re-check their op before
				// every board or session step, so they are not awaited (construction may hang).
				if (m.op) this.#cancelOp(m);
				if (m.phase === "starting" && !m.session) {
					m.phase = "stopped";
					m.failure = { kind: "start", text: "abandoned by finish before its session started", at: new Date().toISOString(), at_seq: this.board.head, count: 1 };
				}
				const d = m.delivery;
				const sendInFlight = d?.status === "dispatched";
				if (d) {
					clearTimeout(d.receiptTimer);
					m.delivery = undefined;
				}
				clearTimeout(m.reconcileTimer);
				m.reconcileTimer = undefined;
				m.nudgePending = false;
				m.notices = [];
				if (m.waiter && m.waiter.deadline !== undefined) claim(this, m, m.waiter.id, "aborted");
				const running = m.phase === "working" || m.phase === "resuming" || m.phase === "starting" || m.phase === "switching";
				if (session && (running || sendInFlight || session.isStreaming)) {
					// Stopped means idle: abort, then wait for the run to settle, bounded.
					stops.push({ m, session, item, settled: settleWithin(session.abort().then(() => session.waitForIdle()), Math.max(0, deadlineAt - Date.now())) });
				}
			}
			const results = await Promise.all(stops.map(s => s.settled));
			for (const [i, s] of stops.entries()) {
				const stopped = results[i] && !s.session.isStreaming;
				if (stopped && !s.session.hasBackgroundWork) continue;
				disposals.push(settleWithin(this.#detachForAbandon(s.m, s.session, !stopped), Math.max(0, deadlineAt - Date.now())));
				s.item.was += stopped ? "; late background work, session detached" : "; did not stop, detached";
			}
			await Promise.all(disposals);
			const c = this.coordinator;
			const o = owed(this);
			if (o.posts.length || o.notices) abandoned.push({ name: "coordinator", was: "unread", ...(o.posts.length ? { unread: o.posts } : {}), ...(o.notices ? { notices: o.notices } : {}) });
			c.notices = [];
			const list = abandoned
				.map(a => `${a.name} (${[a.was, a.unread?.length ? `unread ${a.unread.map(s => `#${s}`).join(", ")}` : "", a.notices ? `${a.notices} notices` : ""].filter(Boolean).join("; ")})`)
				.join(", ");
			let text = `[done] ${summary}`;
			if (abandoned.length) text += `\n[abandoned] ${list}`;
			if (text.length > LIMITS.postChars) text = `${text.slice(0, LIMITS.postChars - 1)}…`;
			const r = this.commitPost(c, text, { finish: { abandon: true, abandoned } });
			if ("error" in r) return r;
			for (const m of this.members.values()) {
				if (m.role === "worker" && !m.killed) {
					m.wakeFloor = Math.max(m.wakeFloor, r.msg.seq);
					m.pruneAddressedRead();
					if (m.phase !== "stopped" && !m.op && !m.waiter) m.phase = m.hostWorking ? "working" : "idle";
				}
			}
			c.wakeFloor = Math.max(c.wakeFloor, r.msg.seq);
			c.pruneAddressedRead();
			this.flushStructural();
			return { seq: r.msg.seq, abandoned };
		} finally {
			this.finishing = false;
			this.changed();
		}
	}

	// -------------------------------------------------------------------------
	// Channels and title
	// -------------------------------------------------------------------------

	createChannel(by: Member, name: string, topic: string): CommitResult | { error: string } {
		return this.commitPost(by, `created #${name}${topic ? `: ${topic}` : ""}`, { control: { op: "create", channel: name, topic } });
	}

	archiveChannel(by: Member, name: string): CommitResult | { error: string } {
		return this.commitPost(by, `archived #${name}`, { control: { op: "archive", channel: name } });
	}

	subscribe(by: Member, op: "subscribe" | "unsubscribe", channel: string, targets: Member[]): CommitResult | { error: string } {
		const prev: Record<string, StoredSet> = {};
		const next: Record<string, StoredSet> = {};
		for (const m of targets) {
			const cur = this.board.storedSet(m.name);
			prev[m.name] = cur;
			const base = cur ?? (effectiveChannels(m.role, null, m.name).includes("*") ? ["*"] : []);
			const set = new Set(base);
			if (op === "subscribe") set.add(channel);
			else set.delete(channel);
			next[m.name] = [...set];
		}
		const names = targets.map(m => m.name);
		const text = `${op === "subscribe" ? "subscribed" : "unsubscribed"} ${names.join(", ")} ${op === "subscribe" ? "to" : "from"} #${channel}`;
		const r = this.commitPost(by, text, { control: { op, channel, members: names, prev, next } });
		if (!("error" in r)) for (const m of targets) m.channels = this.board.storedSet(m.name);
		this.flushStructural();
		return r;
	}

	setTitle(title: string): void {
		this.title = title;
		this.flushStructural();
		this.changed();
	}

	setScoutOverride(override: ScoutOverride | undefined): void {
		this.scoutOverride = override;
		this.flushStructural();
		this.changed();
	}

	channelList(): (ChannelRecord & { subscribers: string[] })[] {
		return this.board.channels().map(c => ({
			...c,
			subscribers: [...this.members.values()]
				.filter(m => !m.killed && effectiveChannels(m.role, m.channels, m.name).some(s => s === c.name || s === "*"))
				.map(m => m.name),
		}));
	}

	// -------------------------------------------------------------------------
	// Main-session events (coordinator)
	// -------------------------------------------------------------------------

	onMainAgentStart(): void {
		this.#mainAwaiting = false;
		const c = this.coordinator;
		if (c.runId === c.settledRun) c.runSawError = false;
		c.runId++;
		c.stats.runs++;
		c.awaiting = false;
		if (c.phase !== "parked" && c.phase !== "resuming" && c.phase !== "switching") c.phase = "working";
		this.changed();
		reconcile(this, c);
	}

	onMainTurnStart(): void {
		this.refreshCoordinator();
	}

	onMainMessageEnd(msg: HostMessage): void {
		const c = this.coordinator;
		if (msg.role === "assistant") {
			if (!this.binding.headless && msg.stopReason === "error") c.runSawError = true;
			c.tracker.onAssistant(msg);
			this.recordUsage(c, msg);
			return;
		}
		if (msg.role !== "custom") return;
		const d = c.delivery;
		if (!d || d.status !== "dispatched") return;
		if (msg.customType === "swarm-wake" && d.kind === "aside" && deliveryIdOf(msg) === d.id) acknowledge(this, c, d);
		else if (msg.customType === "session-stop-continuation" && d.kind === "gate") {
			// 19.0.1 queues the block reason verbatim as the continuation's content.
			const text = typeof msg.content === "string" ? msg.content : messageText(msg);
			if (d.text !== undefined && text === d.text) acknowledge(this, c, d);
		}
	}

	onMainAutoRetryEnd(success: boolean): void {
		const c = this.coordinator;
		if (!success || this.binding.headless || !c.runSawError) return;
		c.runSawError = false;
		reconcile(this, c);
	}

	onMainToolEnd(toolCallId: string, isError: boolean): void {
		settleToolDelivery(this, this.coordinator, toolCallId, isError);
	}

	onMainStopHook(): void {
		this.#mainAwaiting = false;
	}

	onMainAgentEnd(ev: { willContinue?: boolean; awaitingAsyncWork?: boolean; mayResume?: boolean }): void {
		if (ev.willContinue) {
			this.#mainAwaiting = this.binding.headless && ev.awaitingAsyncWork === true;
			if (!this.binding.headless && ev.awaitingAsyncWork && this.coordinator.phase === "working") {
				const c = this.coordinator;
				c.awaiting = true;
				c.phase = "idle";
				this.changed();
				this.#resumeCoordinator(c);
			}
			return;
		}
		const endedWithoutResult = this.#mainAwaiting;
		this.#mainAwaiting = false;
		const c = this.coordinator;
		c.awaiting = false;
		if (c.runId > c.settledRun || endedWithoutResult) {
			c.settledRun = c.runId;
			c.tracker.onRunEnd();
			if (c.delivery) release(this, c, "the run ended before the wake was received");
			if (c.phase !== "parked" && c.phase !== "switching") c.phase = "idle";
			c.redeliveryExhausted = false;
			this.changed();
		} else if (!this.binding.headless) return;
		if (this.binding.headless) {
			if (endedWithoutResult && ev.mayResume && !this.closing && !this.outcome?.terminal) {
				if (decide(this) === "ALLOW") recordGateCompletion(this);
				else if (this.deadlineExceeded()) declareIncomplete(this, `run deadline of ${this.env.deadlineSeconds} s passed`);
				else this.binding.sendWake({
					customType: "swarm-gate-reminder",
					content: "[swarm] Your native background work ended without waking you. Call swarm_wait{} to continue supervising the swarm, then finish when the work is done.",
					display: false, details: {},
				});
			}
			if (completionCurrent(this)) {
				this.#printWakeReleased = true;
				this.factory.setPrintWake(false);
			}
			return;
		}
		this.#resumeCoordinator(c);
	}

	#resumeCoordinator(c: Member): void {
		if (c.phase === "switching") return;
		if (this.coordinatorSwitch) {
			c.phase = "switching";
			void applyCoordinatorSwitch(this).then(
				res => { if (res && res.state !== "ok") this.coordinatorNotice("external_change", res.text.replace(/^\[swarm\] /, "")); },
				err => this.coordinatorNotice("external_change", `Your model switch failed: ${err instanceof Error ? err.message : String(err)}`),
			).finally(() => {
				if (c.phase === "switching") c.phase = this.binding.isStreaming() ? "working" : "idle";
				this.changed();
				if (this.coordinatorSwitch && c.phase === "idle") return this.#resumeCoordinator(c);
				reconcile(this, c);
			});
			return;
		}
		reconcile(this, c);
	}

	onMainCompact(): void {
		this.coordinator.reminders.compacted = compactedReminder(this.coordinator);
		this.changed();
	}

	/** A new transcript can supersede a failed run without emitting its final agent_end. */
	onMainTranscriptReset(): void {
		this.coordinator.runSawError = false;
	}

	/** session_clear keeps the session id (19.0.1): retain the runtime, invalidate the delivery/UI epoch. */
	onSessionClear(): void {
		const c = this.coordinator;
		this.epoch++;
		this.onMainTranscriptReset();
		if (c.delivery) release(this, c, "the conversation was cleared");
		if (c.waiter) claim(this, c, c.waiter.id, "closing");
		c.reminders.restored = "Your conversation was cleared; the swarm continues. read_board{since:0} catches you up.";
		this.changed();
	}

	// -------------------------------------------------------------------------
	// Status
	// -------------------------------------------------------------------------

	memberStatus(m: Member): Record<string, unknown> {
		const posts = this.board.postsBy(m.name);
		const lastSeq = posts[posts.length - 1];
		const row: Record<string, unknown> = {
			name: m.name,
			agent_id: m.agentId,
			role: m.role,
			state: m.state,
			detail: m.detail,
			model: m.model,
			effort: m.effort,
			added_by: m.addedBy,
			channels: this.channelsView(m),
			default_channel: this.defaultChannel(m),
			workspace: describeWorkspace(m.workspace),
			wake_mode: m.phase === "parked" ? m.wakeMode : roleDefaultMode(m.role),
			last_read_seq: m.lastReadSeq,
			unread: this.board.uiUnread(m.name, m.role, m.lastReadSeq, m.addressedRead),
			owed: m.killed ? [] : wakePendingFor(this, m).map(p => p.seq),
			steps: m.stats.steps,
			activity: m.tracker.activity,
		};
		if (lastSeq !== undefined) {
			row.last_post_seq = lastSeq;
			row.last_post_ts = this.board.messages[lastSeq - 1]?.ts;
		}
		if (m.failure) row.error = `${m.failure.kind}: ${m.failure.text}`;
		if (m.stats.tokens) row.tokens = m.stats.tokens;
		if (m.stats.cost) row.cost = Number(m.stats.cost.toFixed(6));
		if (m.workspace.state === "retained") row.workspace_retained = m.workspace.retained_reason;
		return row;
	}

	attention(): { kind: string; member?: string; seq?: number; text: string; detail?: string }[] {
		const out: { kind: string; member?: string; seq?: number; text: string; detail?: string }[] = [];
		for (const m of this.members.values()) {
			if (m.killed || m.role === "coordinator") continue;
			if (m.failure) out.push({ kind: m.failure.kind, member: m.name, text: `${m.name}: last turn failed (${m.failure.kind})`, detail: m.failure.text });
			else if (m.stuckNotified) out.push({ kind: "stuck", member: m.name, text: `${m.name}: no activity for 10 minutes` });
		}
		for (const r of this.retained) out.push({ kind: "workspace_retained", member: r.name, text: `${r.name}: workspace kept`, detail: r.reason });
		if (this.store.readOnly) out.push({ kind: "storage", text: "board is read-only", detail: this.store.readOnly });
		if (this.outcome?.value === "incomplete") out.push({ kind: "incomplete", text: `run incomplete: ${this.outcome.reason}` });
		return out;
	}

	completion(): string {
		return completionLabel(this);
	}

	// -------------------------------------------------------------------------
	// Shutdown (§6.11, 2 s budget)
	// -------------------------------------------------------------------------

	async shutdown(): Promise<void> {
		if (this.closing) return;
		if (!this.outcome && (this.#rootShutdownHadLiveWork || liveTaskWork(this).length)) {
			this.outcome = { value: "aborted", reason: "shutdown with live work", at: new Date().toISOString(), terminal: true };
		}
		this.closing = true;
		this.factory.setPrintWake(false);
		const deadlineAt = Date.now() + TIMING.shutdownDisposeMs;
		clearTimeout(this.#flushTimer);
		clearTimeout(this.#metricsTimer);
		clearTimeout(this.#activityTimer);
		clearTimeout(this.stall.timer);
		clearInterval(this.#keepAlive);
		this.#keepAlive = undefined;
		// Checkpoint first, so parks and states are recorded as they were (last_park on reload).
		const roster = this.rosterSnapshot();
		this.#writeRoster(true, roster);
		this.writeMetrics();
		const disposals: Promise<void>[] = [];
		for (const m of this.members.values()) {
			this.#cancelOp(m);
			m.awaiting = false;
			if (m.waiter) claim(this, m, m.waiter.id, "closing");
			clearTimeout(m.reconcileTimer);
			const d = m.delivery;
			if (d) clearTimeout(d.receiptTimer);
			m.unsubscribe?.();
			m.unsubscribe = undefined;
			const session = m.session;
			m.session = undefined;
			if (session) disposals.push(session.dispose());
			else if (m.drain?.pending) disposals.push(m.drain.promise);
		}
		for (const w of [...this.#versionWaiters]) w();
		if (this.ephemeral) {
			const kept = [...this.members.values()].filter(m => m.workspace.root && m.workspace.state !== "removed");
			if (kept.length)
				this.log(`omp-agy-swarm: worktrees kept in ${this.dir}/workspaces (${kept.map(m => m.name).join(", ")}); git worktree remove <path> cleans them up`);
		}
		this.#listeners.clear();
		try {
			await raceTimeout(Promise.allSettled(disposals), Math.max(0, deadlineAt - Date.now()), undefined, { unref: true });
			await this.factory.dispose(deadlineAt);
		} finally {
			if (this.#lateUsage) {
				// Drain can finish a real request. Update only totals in the
				// pre-fence checkpoint, not the intentionally claimed waits/cursors.
				for (const [name, m] of this.members) {
					const saved = roster.members[name]?.stats;
					if (saved) {
						saved.tokens = m.stats.tokens;
						saved.cost = m.stats.cost;
					}
				}
				roster.spend_unknown = this.spendUnknown;
				this.#writeRoster(true, roster);
				this.writeMetrics();
			}
			this.store.close();
		}
	}
}

export function describeWorkspace(ws: WorkspaceRecord): string {
	if (ws.mode === "inherit") return `inherit: ${ws.path}`;
	return `${ws.mode}: ${ws.path} (${ws.branch ?? ""})${ws.state && ws.state !== "active" ? ` [${ws.state}]` : ""}`;
}

/** Resolves true when `p` settles successfully within `ms`, false on timeout or rejection. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
	return raceTimeout(
		p.then(
			() => true,
			() => false,
		),
		ms,
		false,
	);
}
