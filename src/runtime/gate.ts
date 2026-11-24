// Completion, the headless stop-gate, the stall/quiescence guard and the progress budgets (§7,
// SW-03). Completion is derived from the board each time; nothing is stored separately.

import { channelMentions, mentionsOf } from "../board/channels.ts";
import type { BoardMessage } from "../board/types.ts";
import { TIMING } from "../env.ts";
import { type Delivery, type Member, nextDeliveryId, type ReminderKey } from "./member.ts";
import { applyCoordinatorSwitch } from "./models.ts";
import { INCOMPLETE_NOTE, waitText, wakeText } from "./prompts.ts";
import type { Outcome, SwarmRuntime } from "./runtime.ts";
import { claim } from "./waits.ts";
import { pageFloor, release } from "./delivery.ts";
import { LIMITS } from "../env.ts";

export function isTask(m: Member): boolean {
	return m.role === "worker" && !m.killed;
}

/** §7.1: active work, including waiting for a timer or for native background work. */
export function liveTaskWork(rt: SwarmRuntime): Member[] {
	const out: Member[] = [];
	for (const m of rt.members.values()) {
		if (!isTask(m)) continue;
		const live =
			m.phase === "starting" ||
			(m.phase === "working" || (m.phase === "idle" && m.hostWorking)) ||
			m.phase === "resuming" ||
			m.phase === "switching" ||
			!!m.op ||
			!!m.delivery ||
			m.reconcileTimer !== undefined ||
			(m.phase === "parked" && m.waiter?.deadline !== undefined) ||
			m.awaiting || !!m.session?.wakeSources;
		if (live) out.push(m);
	}
	return out;
}

export function liveWorkReason(m: Member, finish = false, absoluteTime?: { hour12?: boolean }): string {
	const deadline = m.waiter?.deadline;
	if (m.phase === "parked" && deadline !== undefined) {
		if (absoluteTime) {
			const time = new Date(deadline).toLocaleTimeString(undefined, { hour12: absoluteTime.hour12, hour: "numeric", minute: "2-digit", second: "2-digit" });
			return `${m.name} is parked in a timed swarm_wait (wakes at ${time}).`;
		}
		const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
		const eta = seconds >= 3600 ? `${Math.ceil(seconds / 3600)}h` : seconds >= 60 ? `${Math.ceil(seconds / 60)}m` : `${seconds}s`;
		const reason = `${m.name} is parked in a timed swarm_wait (wakes in ~${eta}).`;
		return finish ? `${reason} Post \`@${m.name} end your turn without rearming the timer\`, wait if the wake is wanted, or use \`finish{abandon:true}\` only to cancel outstanding work intentionally.` : reason;
	}
	if (m.awaiting || m.session?.wakeSources) return `${m.name} is ${m.state === "waiting" ? "waiting on" : "working with pending"} background work.`;
	if (m.phase === "working" && m.runId > m.settledRun && m.stats.posts > m.postsAtLoopStart) {
		const reason = `${m.name} posted, but its turn is still open.`;
		return finish ? `${reason} Call \`swarm_wait{}\`; when it wakes, retry \`finish\` without \`abandon:true\`.` : reason;
	}
	return `${m.name} is ${m.detail}.`;
}

export interface Owed {
	posts: number[];
	notices: number;
}

/** §7.1 owed(c, floor): unread posts visible to the coordinator (mentions ⊆ them) and its notices. */
export function owed(rt: SwarmRuntime, floor = 0): Owed {
	const c = rt.coordinator;
	const from = Math.max(pageFloor(c), floor);
	return { posts: rt.board.gateUnread(from, c.addressedRead).map(p => p.seq), notices: c.notices.length };
}

function isOwedEmpty(o: Owed): boolean {
	return o.posts.length === 0 && o.notices === 0;
}

export interface DoneMarker {
	seq: number;
	abandoned: boolean;
}

/** The latest coordinator post starting with `[done]` that mentions nobody. */
export function doneMarker(rt: SwarmRuntime): DoneMarker | undefined {
	const names = [...rt.members.keys()];
	for (let i = rt.board.messages.length - 1; i >= 0; i--) {
		const msg = rt.board.messages[i] as BoardMessage;
		if (msg.agent !== "coordinator" || msg.control) continue;
		if (!msg.text.trimStart().startsWith("[done]")) continue;
		if (mentionsNobody(msg.text, names)) return { seq: msg.seq, abandoned: msg.finish?.abandon === true };
	}
	return undefined;
}

export function mentionsNobody(text: string, names: readonly string[]): boolean {
	const m = mentionsOf(text, names);
	return m.mentions.length === 0 && !m.all && channelMentions(text).length === 0;
}

export function completionCurrent(rt: SwarmRuntime): boolean {
	const d = doneMarker(rt);
	if (!d) return false;
	for (let i = d.seq; i < rt.board.messages.length; i++) {
		const msg = rt.board.messages[i];
		if (!msg || msg.control) continue;
		const author = rt.members.get(msg.agent);
		if (msg.agent === "coordinator" || (author && isTask(author))) return false;
	}
	if (liveTaskWork(rt).length) return false;
	return isOwedEmpty(owed(rt, d.abandoned ? d.seq : 0));
}

/** "accepted" or "pending: parser working; unread #41, #44; notices: 1". */
export function completionLabel(rt: SwarmRuntime, absoluteTime?: { hour12?: boolean }): string {
	if (completionCurrent(rt)) return "accepted";
	const parts: string[] = [];
	const live = liveTaskWork(rt);
	if (live.length) {
		if (!absoluteTime) parts.push(live.map(m => liveWorkReason(m)).join(" "));
		else if (live.length === 1) parts.push(liveWorkReason(live[0]!, false, absoluteTime));
		else parts.push(`${live.length} task workers active`);
	}
	const d = doneMarker(rt);
	const o = owed(rt, d?.abandoned ? d.seq : 0);
	if (o.posts.length) parts.push(absoluteTime ? `${o.posts.length} unread` : `unread ${o.posts.map(s => `#${s}`).join(", ")}`);
	if (o.notices) parts.push(`notices: ${o.notices}`);
	if (!d) parts.push("no [done] yet");
	else if (!parts.length) parts.push(`activity after #${d.seq}`);
	return `pending: ${parts.join("; ")}`;
}

export type Decision = "ALLOW" | "DELIVER" | "WAIT";

export function decide(rt: SwarmRuntime): Decision {
	if (rt.outcome?.terminal) return "ALLOW";
	if (completionCurrent(rt)) return "ALLOW";
	if (!isOwedEmpty(owed(rt))) return "DELIVER";
	if (liveTaskWork(rt).length) return "WAIT";
	return "ALLOW";
}

export function recordOutcome(rt: SwarmRuntime, value: Outcome["value"], reason: string, terminal = false): void {
	if (rt.outcome?.terminal) return;
	rt.outcome = { value, reason, at: new Date().toISOString(), terminal };
	rt.writeMetrics();
	rt.changed();
}

/** §7.4 declareIncomplete: durable terminal outcome, one stderr line, a parked coordinator is told. */
export function declareIncomplete(rt: SwarmRuntime, reason: string): void {
	if (rt.outcome?.terminal) return;
	recordOutcome(rt, "incomplete", reason, true);
	const live = liveTaskWork(rt).map(m => m.name);
	const unread = owed(rt).posts.map(s => `#${s}`);
	rt.log(`omp-agy-swarm: outcome=incomplete (${reason}); live: ${live.join(", ") || "none"}; unread: ${unread.join(", ") || "none"}`);
	const c = rt.coordinator;
	if (c.waiter) claim(rt, c, c.waiter.id, "incomplete");
}

function budgetExceeded(rt: SwarmRuntime): boolean {
	return rt.gate.refusals >= rt.env.gateMaxRefusals;
}

/** Reserves a gate delivery (page from the coordinator's cursor plus notices). */
function reserveGate(rt: SwarmRuntime): string {
	const c = rt.coordinator;
	const page = rt.board.page("coordinator", "coordinator", pageFloor(c), { ...LIMITS.wakePage, exclude: c.addressedRead });
	const notices = c.notices.slice();
	const noticeTexts = notices.map(n => n.text);
	if (c.droppedNotices > 0) noticeTexts.unshift(`${c.droppedNotices} earlier notices dropped`);
	const reminders = Object.entries(c.reminders) as [ReminderKey, string][];
	const text = wakeText({
		name: "coordinator",
		head: rt.board.head,
		reminders: reminders.map(([, t]) => t),
		notices: noticeTexts,
		posts: page.messages,
		more: page.more,
	});
	const d: Delivery = {
		id: nextDeliveryId(),
		gen: c.gen,
		kind: "gate",
		status: "dispatched",
		since: page.since,
		through: page.next_since,
		noticeIds: notices.map(n => n.id),
		reminderKeys: reminders.map(([k]) => k),
		text,
		carriesPosts: page.messages.length > 0,
		carriesBrief: false,
		direct: false,
		cause: "post",
		runIdAtDispatch: c.runId,
		dispatchedAt: Date.now(),
		nudge: false,
	};
	c.delivery = d;
	rt.changed();
	return text;
}

export interface GateEvent {
	signal: AbortSignal;
	lastStopReason: string | undefined;
}

export type GateResult = { decision: "block"; reason: string } | undefined;

/** A no-wake terminal loop may reach here directly instead of via the stop hook. */
export function recordGateCompletion(rt: SwarmRuntime): void {
	if (rt.outcome?.terminal) return;
	const d = doneMarker(rt);
	if (completionCurrent(rt)) recordOutcome(rt, d?.abandoned ? "complete_with_abandonment" : "complete", "completion accepted");
	else recordOutcome(rt, "quiescent_no_done", "nothing running, nothing unread, no [done]");
}

/** §7.3 headless stop-gate (session_stop, print/json). Never waits longer than the 20 s budget. */
export async function stopGate(rt: SwarmRuntime, ev: GateEvent): Promise<GateResult> {
	if (ev.signal.aborted || rt.closing) return undefined;
	if (ev.lastStopReason === "error" || ev.lastStopReason === "aborted") {
		recordOutcome(rt, "coordinator_failed", `the coordinator's turn ended with ${ev.lastStopReason}`, true);
		return undefined;
	}
	if (rt.outcome?.terminal) return undefined;
	if (decide(rt) !== "ALLOW" && deadlineReached(rt)) return undefined;
	if (rt.coordinatorSwitch) {
		// The switch completes inside this stop, before any further turn. A host that does not
		// finish in time fails closed: no turn may start while setModel is still mutating.
		const res = await applyCoordinatorSwitch(rt, TIMING.gateSwitchMs);
		if (ev.signal.aborted) return undefined;
		if (res?.state === "pending") {
			declareIncomplete(rt, `the coordinator's model switch did not finish within ${TIMING.gateSwitchMs / 1000} s`);
			return undefined;
		}
		// A completed switch is not a refusal; a failed one is (it made no progress).
		if (res?.state === "ok") return { decision: "block", reason: res.text };
		if (res) return block(rt, res.text);
	}
	const c = rt.coordinator;
	// A delivery still unacknowledged at a stop never reached the model: release it (posts stay owed).
	if (c.delivery) release(rt, c, "the coordinator stopped before receiving it");
	const deadline = Date.now() + rt.env.gateWaitSeconds * 1000;
	rt.gate.waiting = true;
	try {
		for (;;) {
			const v = rt.version;
			switch (decide(rt)) {
				case "ALLOW":
					recordGateCompletion(rt);
					return undefined;
				case "DELIVER":
					if (deadlineReached(rt)) return undefined;
					if (budgetExceeded(rt)) {
						declareIncomplete(rt, `the coordinator stopped ${rt.gate.refusals} times without progress`);
						return undefined;
					}
					return block(rt, reserveGate(rt));
				case "WAIT": {
					if (deadlineReached(rt)) return undefined;
					if (rt.noProgressExceeded()) {
						declareIncomplete(rt, `no progress for ${rt.env.noProgressSeconds} s`);
						return undefined;
					}
					if (Date.now() >= deadline) {
						if (budgetExceeded(rt)) {
							declareIncomplete(rt, `the coordinator stopped ${rt.gate.refusals} times while members worked`);
							return undefined;
						}
						return block(rt, waitText(liveTaskWork(rt).map(m => liveWorkReason(m))));
					}
					await rt.changedSince(v, deadline, ev.signal);
					if (ev.signal.aborted) return undefined;
					break;
				}
			}
		}
	} finally {
		rt.gate.waiting = false;
	}
}

/** The run deadline ends the run incomplete wherever the gate notices it (not only on the tick). */
function deadlineReached(rt: SwarmRuntime): boolean {
	if (!rt.deadlineExceeded()) return false;
	declareIncomplete(rt, `run deadline of ${rt.env.deadlineSeconds} s passed`);
	return true;
}

function block(rt: SwarmRuntime, reason: string): GateResult {
	rt.gate.refusals++;
	rt.metrics.gate_refusals++;
	return { decision: "block", reason };
}

// ---------------------------------------------------------------------------
// Quiescence and the stall guard (§7.4 with SW-03). Evaluated after every state change.
// ---------------------------------------------------------------------------

function fingerprint(rt: SwarmRuntime): string {
	const parts: string[] = [];
	for (const m of rt.members.values()) {
		if (!isTask(m)) continue;
		const last = rt.board.postsBy(m.name);
		parts.push(`${m.name}:${m.state}:${m.failure?.kind ?? ""}:${last[last.length - 1] ?? 0}`);
	}
	let headNonRole = 0;
	for (let i = rt.board.messages.length - 1; i >= 0; i--) {
		const msg = rt.board.messages[i];
		const a = msg && rt.members.get(msg.agent);
		if (msg && !msg.control && (!a || !a.isRoleWorker)) {
			headNonRole = msg.seq;
			break;
		}
	}
	return `${parts.join(",")}|${headNonRole}|${rt.coordinator.lastReadSeq}`;
}

export function stallPayload(rt: SwarmRuntime): Record<string, unknown> {
	const members = [...rt.members.values()]
		.filter(isTask)
		.map(m => {
			const last = rt.board.postsBy(m.name);
			const row: Record<string, unknown> = { name: m.name, state: m.state };
			if (last.length) row.last_post_seq = last[last.length - 1];
			if (m.failure) row.error = `${m.failure.kind}: ${m.failure.text}`;
			return row;
		});
	return { members };
}

/**
 * At task quiescence with the coordinator parked: first claim it with a page of unread results
 * or notices (a result addressed to nobody must not stall the run); only an empty board arms the
 * stall timer.
 */
export function evaluateQuiescence(rt: SwarmRuntime): void {
	const c = rt.coordinator;
	const s = rt.stall;
	const parked = c.phase === "parked" && !!c.waiter;
	const revivalInFlight = [...rt.members.values()].some(m => m.op?.kind === "revive");
	if (!parked || rt.closing || liveTaskWork(rt).length || revivalInFlight) {
		clearTimeout(s.timer);
		s.timer = undefined;
		return;
	}
	const o = owed(rt);
	if (!isOwedEmpty(o)) {
		clearTimeout(s.timer);
		s.timer = undefined;
		const w = c.waiter;
		if (w) claim(rt, c, w.id, o.posts.length ? "post" : "notice", { quiescent: true });
		return;
	}
	if (s.timer) return;
	s.timer = setTimeout(() => {
		s.timer = undefined;
		fireStall(rt);
	}, TIMING.stallMs);
}

function fireStall(rt: SwarmRuntime): void {
	const c = rt.coordinator;
	const w = c.waiter;
	if (!w || rt.closing || liveTaskWork(rt).length || !isOwedEmpty(owed(rt))) return;
	const f = fingerprint(rt);
	const n = rt.stall.counts.get(f) ?? 0;
	rt.stall.counts.set(f, n + 1);
	if (n >= 2) {
		if (rt.binding.headless) declareIncomplete(rt, "stalled twice with no progress");
		else {
			rt.stall.interactiveStalled = true;
			rt.changed();
		}
		return;
	}
	rt.metrics.stall_wakes++;
	claim(rt, c, w.id, "stall", { ...stallPayload(rt), ...(n === 1 ? { final: true } : {}) });
}

export const INCOMPLETE_RESULT = { woke: "incomplete", terminal: true, note: INCOMPLETE_NOTE } as const;
