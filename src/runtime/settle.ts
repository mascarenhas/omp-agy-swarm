// Worker session events, run-end handling, cycles, nudges and the failure path (§6.6, §6.7).

import { QUOTA_RE, LIMITS, TIMING } from "../env.ts";
import { messageText } from "./activity.ts";
import { acknowledge, reconcile, release, wakePendingFor } from "./delivery.ts";
import { type CycleCause, type Member, roleDefaultMode } from "./member.ts";
import { startBoundarySwitch } from "./models.ts";
import type { HostMessage, WorkerEvent } from "./ports.ts";
import { modelKey } from "./ports.ts";
import { failureNotice } from "./prompts.ts";
import type { SwarmRuntime } from "./runtime.ts";

export function startCycle(m: Member, cause: CycleCause, direct: boolean): void {
	m.cycle = { cause, direct, posted: false, nudged: false };
}

export function closeCycle(m: Member): void {
	m.cycle = undefined;
}

/** §6.7 silent-finish nudge eligibility. */
export function nudgeDue(rt: SwarmRuntime, m: Member): boolean {
	const c = m.cycle;
	return (
		!rt.closing && m.role === "worker" && !!c && (c.cause === "brief" || c.direct) && !c.posted && !c.nudged
		&& !m.awaiting && !m.session?.wakeSources
	);
}

function compactionDone(ev: WorkerEvent): boolean {
	if (ev.type !== "auto_compaction_end" || !("result" in ev)) return false;
	return !!ev.result && !ev.aborted && !ev.willRetry && !ev.errorMessage && !ev.skipped;
}

export function compactedReminder(m: Member): string {
	return m.role === "coordinator"
		? "Your context was compacted. You are the coordinator; read_board shows the board."
		: `Your context was compacted. You are \`${m.name}\`; your brief is #${m.briefSeq}.`;
}

/** Worker events (session.subscribe), bound to the generation that created the session. */
export function onWorkerEvent(rt: SwarmRuntime, m: Member, gen: number, ev: WorkerEvent): void {
	if (m.gen !== gen || m.killed || rt.closing) return;
	m.tracker.touch();
	m.stuckNotified = false;
	switch (ev.type) {
		case "agent_start":
			m.awaiting = false;
			m.postsAtLoopStart = m.stats.posts;
			// A run's first loop records the cost-cap refusal it starts with (19.0.1 emits agent_start
			// per model loop; later loops of the same run keep the first record).
			if (m.runId === m.settledRun) m.costRefusalSeen = m.session?.costCapRefusal;
			m.runId++;
			m.stats.runs++;
			if (m.phase === "starting" || m.phase === "idle") m.phase = "working";
			if (m.role === "worker") rt.progress();
			rt.changed();
			return;
		case "message_end": {
			const msg = "message" in ev ? (ev.message as HostMessage) : undefined;
			if (!msg) return;
			if (msg.role === "assistant") {
				m.tracker.onAssistant(msg);
				rt.changedActivity();
				return;
			}
			const d = m.delivery;
			if (!d || d.status !== "dispatched") return;
			// The prompt's receipt is the user message carrying exactly the text that was sent.
			if (msg.role === "user" && d.kind === "prompt" && d.text !== undefined && messageText(msg).trim() === d.text.trim()) acknowledge(rt, m, d);
			else if (msg.role === "custom" && msg.customType === "swarm-wake" && deliveryIdOf(msg) === d.id) acknowledge(rt, m, d);
			return;
		}
		case "tool_execution_start":
			if ("toolName" in ev) m.tracker.onToolStart(String(ev.toolName), "args" in ev ? ev.args : undefined);
			rt.changedActivity();
			return;
		case "tool_execution_end": {
			if (!("toolCallId" in ev)) return;
			const d = m.delivery;
			if (d?.kind === "tool" && d.toolCallId === ev.toolCallId) {
				if ("isError" in ev && ev.isError) release(rt, m, "the tool result was an error");
				else acknowledge(rt, m, d);
			}
			if (m.role === "worker") rt.progress();
			return;
		}
		case "turn_end":
			m.tracker.steps++;
			m.stats.steps++;
			rt.changedActivity();
			return;
		case "agent_pause":
			if (!("awaiting" in ev) || !ev.awaiting || m.awaiting || m.session?.isStreaming) return;
			m.awaiting = true;
			m.nudgePending = false;
			m.tracker.onRunEnd();
			const stop = m.session?.getLastAssistantMessage()?.stopReason;
			const refusal = m.session?.costCapRefusal;
			if (stop !== "error" && stop !== "aborted" && (!refusal || refusal === m.costRefusalSeen)) {
				m.failure = null;
				m.retryToken = false;
			}
			if (m.delivery) release(rt, m, "the loop paused before the wake was received");
			if (m.op?.kind !== "switch" && !m.waiter) {
				m.phase = "idle";
				m.wakeMode = roleDefaultMode(m.role);
				m.waitSince = m.lastReadSeq;
			}
			rt.changed();
			if (m.pendingSwitch && !m.op && m.phase === "idle") {
				startBoundarySwitch(rt, m);
				return;
			}
			reconcile(rt, m);
			return;
		case "agent_end":
			if (m.session?.isStreaming) return;
			if (m.awaiting) {
				m.awaiting = false;
				rt.changed();
			}
			settleRun(rt, m);
			return;
		case "auto_retry_start":
			if ("attempt" in ev) m.tracker.onRetry(Number(ev.attempt), Number(ev.maxAttempts), String(ev.errorMessage ?? ""));
			rt.changedActivity();
			return;
		case "auto_compaction_end":
			if (compactionDone(ev)) {
				m.reminders.compacted = compactedReminder(m);
				rt.changed();
			}
			return;
		case "model_changed":
		case "thinking_level_changed":
		case "retry_fallback_applied":
			detectExternalChange(rt, m);
			return;
		default:
			return;
	}
}

export function deliveryIdOf(msg: HostMessage): string | undefined {
	const d = msg.details;
	if (d && typeof d === "object" && "delivery_id" in d && typeof d.delivery_id === "string") return d.delivery_id;
	return undefined;
}

/** A model/effort change the runtime did not initiate: read back into the roster, notify (§4.3). */
export function detectExternalChange(rt: SwarmRuntime, m: Member): void {
	if (m.op?.kind === "switch" || !m.session) return;
	const model = modelKey(m.session.model);
	const effort = m.session.thinkingLevel ?? "";
	if (model === m.expectedModel && effort === m.expectedEffort) return;
	m.model = model;
	m.effort = effort;
	m.expectedModel = model;
	m.expectedEffort = effort;
	rt.noticeToCoordinator(m, "external_change", `${m.name}'s model changed outside the swarm: now ${model || "?"} (${effort || "default"}).`);
	rt.flushStructural();
	rt.changed();
}

/** Run end (agent_end, or a rejected send that started no run). Idempotent per run. */
export function settleRun(rt: SwarmRuntime, m: Member, error?: string): void {
	const runId = m.runId;
	if (runId <= m.settledRun) return;
	m.settledRun = runId;
	if (rt.closing || m.killed) return;
	m.tracker.onRunEnd();
	if (m.delivery) release(rt, m, "the run ended before the wake was received");
	if (m.op?.kind === "switch") return;
	if (m.role === "worker") rt.progress();
	// The host's cost gate refused a request of this run: a cost failure whatever the stop reason.
	const refusal = m.session?.costCapRefusal;
	if (!error && refusal && refusal !== m.costRefusalSeen) {
		m.costRefusalSeen = refusal;
		failurePath(rt, m, refusal.message, "cost");
		return;
	}
	const last = m.session?.getLastAssistantMessage();
	if (!error && last?.stopReason === "aborted") {
		closeCycle(m);
		m.phase = "idle";
		m.wakeMode = roleDefaultMode(m.role);
		m.waitSince = m.lastReadSeq;
		rt.changed();
		return;
	}
	if (error || last?.stopReason === "error") {
		failurePath(rt, m, error ?? last?.errorMessage ?? (last ? messageText(last) : "") ?? "error");
		return;
	}
	m.failure = null;
	m.retryToken = false;
	const due = nudgeDue(rt, m);
	if (due && m.cycle) m.cycle.nudged = true;
	closeCycle(m);
	if (due) m.nudgePending = true;
	m.phase = "idle";
	m.wakeMode = roleDefaultMode(m.role);
	m.waitSince = m.lastReadSeq;
	if (m.pendingSwitch) {
		startBoundarySwitch(rt, m);
		return;
	}
	rt.changed();
	reconcile(rt, m);
}

const COST_RE = /cost (?:cap|limit|ceiling)|max[- ]cost|budget exceeded/i;

/** §6.7 failure path: the notice is queued before the member's phase leaves `working`. */
export function failurePath(rt: SwarmRuntime, m: Member, rawText: string, kindHint?: "cost"): void {
	const text = rawText.replace(/\s+/g, " ").trim().slice(0, LIMITS.failureTextChars) || "error";
	const kind = kindHint ?? (COST_RE.test(text) ? "cost" : QUOTA_RE.test(text) ? "quota" : "error");
	const count = (m.failure?.count ?? 0) + 1;
	m.failure = { kind, text, at: new Date().toISOString(), at_seq: rt.board.head, count };
	m.stats.failures++;
	const now = Date.now();
	if (now - m.lastFailureNoticeAt >= TIMING.failureNoticeMs) {
		m.lastFailureNoticeAt = now;
		rt.noticeToCoordinator(m, "failure", failureNotice(m.name, kind, text, m.model, m.effort));
	}
	const newer = wakePendingFor(rt, m).some(p => p.seq > m.lastDeliveredThrough);
	// An unpresented startup brief is owed work too: replay it (bounded by the same retry budget).
	const briefOwed = m.role !== "coordinator" && m.briefSeq > 0 && !m.briefPresented;
	// A cost refusal would refuse again: no automatic retry (a model change or revive is explicit).
	m.retryToken = kind !== "cost" && count < 2 && (newer || briefOwed);
	closeCycle(m);
	m.nudgePending = false;
	m.phase = "idle";
	m.wakeMode = roleDefaultMode(m.role);
	m.waitSince = m.lastReadSeq;
	m.notBefore = now + TIMING.failureRetryMs;
	rt.flushStructural();
	rt.changed();
	reconcile(rt, m);
}
