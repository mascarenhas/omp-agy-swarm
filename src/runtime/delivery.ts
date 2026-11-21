// Deliveries (§6.5): the only way posts and notices reach a member. At most one per member,
// bound to its generation. Cursors advance only on a host receipt event; an unacknowledged
// delivery is released and replayed, never dropped.

import type { BoardMessage, Page, PageMessage } from "../board/types.ts";
import { LIMITS, TIMING } from "../env.ts";
import { type Delivery, type Member, nextDeliveryId, type ReminderKey, roleDefaultMode } from "./member.ts";
import { firstMessage, nudgeText, wakeText } from "./prompts.ts";
import type { SwarmRuntime } from "./runtime.ts";
import { settleRun, startCycle } from "./settle.ts";

export function toPageMessage(msg: BoardMessage, me: string): PageMessage {
	const out: PageMessage = { seq: msg.seq, agent: msg.agent, time: msg.time, ts: msg.ts, text: msg.text };
	if (msg.channel && msg.channel !== "main") out.channel = msg.channel;
	if (msg.control) out.control = msg.control;
	if (msg.agent !== me && msg.ring.mentions.has(me)) out.for_you = true;
	return out;
}

/** Whether some post on the page names the member itself or its group prefix (not only @all / @#channel). */
function namesDirectly(rt: SwarmRuntime, m: Member, posts: readonly BoardMessage[]): boolean {
	return posts.some(p => p.agent !== m.name && rt.board.addressees(p, [m.name]).mentions.includes(m.name));
}

/** Where a member's next page starts: its cursor, or above posts it abandoned. */
export function pageFloor(m: Member): number {
	return Math.max(m.lastReadSeq, m.wakeFloor);
}

/**
 * The brief as the member should read it, recovered from its board post (`@<name> <brief>`
 * plus the slice line) when the in-memory brief was lost to a restart.
 */
export function briefFromPost(text: string, name: string): string {
	const prefix = `@${name}`;
	if (!text.startsWith(prefix)) return text;
	const rest = text.slice(prefix.length);
	return /^\s/.test(rest) ? rest.replace(/^[ \t]+/, "") : text;
}

export function wakePendingFor(rt: SwarmRuntime, m: Member, mode = roleDefaultMode(m.role)): BoardMessage[] {
	return rt.board.wakePending(m.name, mode, pageFloor(m));
}

export interface PresentedPage {
	page: Page;
	notices: string[];
	reminders: string[];
	triggerSeq?: number;
}

/** Builds a wake page and registers a `tool` delivery for the returning swarm_wait / read_board call. */
export function presentToolResult(
	rt: SwarmRuntime,
	m: Member,
	toolCallId: string,
	cause: Delivery["cause"],
	opts: { triggerSeq?: number } = {},
): PresentedPage {
	const page = rt.board.page(m.name, m.role, pageFloor(m), LIMITS.wakePage);
	const notices = m.notices.slice();
	const reminderEntries = Object.entries(m.reminders) as [ReminderKey, string][];
	const d: Delivery = {
		id: nextDeliveryId(),
		gen: m.gen,
		kind: "tool",
		status: "dispatched",
		since: page.since,
		through: page.next_since,
		noticeIds: notices.map(n => n.id),
		reminderKeys: reminderEntries.map(([k]) => k),
		toolCallId,
		carriesPosts: page.messages.length > 0,
		carriesBrief: false,
		direct: namesDirectly(rt, m, page.messages),
		cause,
		runIdAtDispatch: m.runId,
		dispatchedAt: Date.now(),
		nudge: false,
	};
	m.delivery = d;
	m.lastDeliveredThrough = d.through;
	rt.changed();
	const out: PresentedPage = {
		page,
		notices: notices.map(n => n.text),
		reminders: reminderEntries.map(([, t]) => t),
	};
	if (m.droppedNotices > 0) out.notices.unshift(`${m.droppedNotices} earlier notices dropped`);
	const trigger = opts.triggerSeq;
	if (trigger !== undefined && !page.messages.some(p => p.seq === trigger)) out.triggerSeq = trigger;
	return out;
}

/** Registers a plain own-view read as a `tool` delivery (cursor moves on its receipt). */
export function registerReadDelivery(rt: SwarmRuntime, m: Member, toolCallId: string, page: Page): void {
	if (m.delivery) return; // another delivery in flight: the page is returned without becoming one
	m.delivery = {
		id: nextDeliveryId(),
		gen: m.gen,
		kind: "tool",
		status: "dispatched",
		since: page.since,
		through: page.next_since,
		noticeIds: [],
		reminderKeys: [],
		toolCallId,
		carriesPosts: false,
		carriesBrief: false,
		direct: false,
		cause: "post",
		runIdAtDispatch: m.runId,
		dispatchedAt: Date.now(),
		nudge: false,
	};
}

export function acknowledge(rt: SwarmRuntime, m: Member, d: Delivery): void {
	if (m.delivery !== d) return;
	clearTimeout(d.receiptTimer);
	m.lastReadSeq = Math.max(m.lastReadSeq, d.through);
	if (d.noticeIds.length) {
		const ids = new Set(d.noticeIds);
		m.notices = m.notices.filter(n => !ids.has(n.id));
		m.droppedNotices = 0;
	}
	for (const k of d.reminderKeys) delete m.reminders[k];
	if (d.carriesBrief) m.briefPresented = true;
	if (d.carriesBrief) startCycle(m, "brief", true);
	else if (d.carriesPosts) startCycle(m, d.cause, d.direct);
	if (d.carriesPosts || d.carriesBrief || d.noticeIds.length) m.stats.wakes++;
	m.delivery = undefined;
	m.redeliveryAttempts = 0;
	m.redeliveryExhausted = false;
	if (d.kind === "tool" && m.phase === "resuming") m.phase = "working";
	if (d.carriesBrief) rt.flushStructural();
	else rt.scheduleFlush();
	rt.changed();
}

/** Releases an unacknowledged delivery: everything stays pending; the cursor is untouched. */
export function release(rt: SwarmRuntime, m: Member, why: string): void {
	const d = m.delivery;
	if (!d) return;
	clearTimeout(d.receiptTimer);
	m.delivery = undefined;
	if (m.phase === "starting" && !m.op) m.phase = "idle";
	if (d.kind === "aside" || d.kind === "prompt") {
		if (m.role === "coordinator") {
			m.redeliveryExhausted = true;
		} else {
			m.redeliveryAttempts++;
			const backoff = TIMING.redeliveryMs[m.redeliveryAttempts - 1];
			if (backoff === undefined) {
				m.redeliveryExhausted = true;
				rt.noticeToCoordinator(
					m,
					"delivery",
					`${m.name} did not receive its wake after ${m.redeliveryAttempts} attempts (${why}); post to it by name or swarm{action:"revive", name:"${m.name}"} to retry.`,
				);
			} else m.notBefore = Date.now() + backoff;
		}
	}
	rt.scheduleFlush();
	rt.changed();
}

/** "Is there something to deliver to an idle member?" Starts at most one delivery. */
export function reconcile(rt: SwarmRuntime, m: Member): void {
	if (rt.closing || m.killed || m.op || m.delivery || m.waiter || m.phase !== "idle") return;
	if (m.role === "coordinator" && rt.binding.headless) return;
	if (m.role === "worker" && rt.finishing) return;
	if (m.role !== "coordinator" && rt.spendExceeded()) return;
	if (m.failure && !m.retryToken) return;
	if (m.redeliveryExhausted) return;
	const needBrief = m.role !== "coordinator" && m.briefSeq > 0 && !m.briefPresented;
	const need =
		needBrief ||
		m.nudgePending ||
		m.notices.length > 0 ||
		m.reminders.resume !== undefined ||
		wakePendingFor(rt, m).length > 0;
	if (!need) return;
	const now = Date.now();
	if (now < m.notBefore) {
		if (!m.reconcileTimer) {
			m.reconcileTimer = setTimeout(() => {
				m.reconcileTimer = undefined;
				reconcile(rt, m);
			}, m.notBefore - now);
		}
		return;
	}
	admitDelivery(rt, m);
}

export function admitDelivery(rt: SwarmRuntime, m: Member): boolean {
	if (rt.closing || m.killed || m.op || m.delivery || m.waiter || m.phase !== "idle") return false;
	if (m.role === "coordinator" && rt.binding.headless) return false;
	// The start→prompt handoff admits directly; under a reached (or unknown) spend ceiling no
	// member's first turn starts either (reconcile applies the same rule to every later wake).
	if (m.role !== "coordinator" && rt.spendExceeded()) return false;
	if (m.role === "worker" && rt.finishing) return false;
	const kind = m.role !== "coordinator" && m.briefSeq > 0 && !m.briefPresented ? "prompt" : "aside";
	const d: Delivery = {
		id: nextDeliveryId(),
		gen: m.gen,
		kind,
		status: "admitted",
		since: pageFloor(m),
		through: pageFloor(m),
		noticeIds: [],
		reminderKeys: [],
		carriesPosts: false,
		carriesBrief: false,
		direct: false,
		cause: "post",
		runIdAtDispatch: m.runId,
		dispatchedAt: 0,
		nudge: m.nudgePending,
	};
	m.delivery = d;
	m.phase = "starting";
	rt.changed();
	queueMicrotask(() => dispatch(rt, m, d.id)); // same-tick posts batch into one delivery
	return true;
}

function cancel(rt: SwarmRuntime, m: Member, d: Delivery): void {
	if (m.delivery !== d) return;
	m.delivery = undefined;
	if (m.phase === "starting" && !m.op) m.phase = "idle";
	rt.changed();
}

/** The dedicated start→prompt handoff: the operation that created the session ends here. */
export function handoffPrompt(rt: SwarmRuntime, m: Member): void {
	m.op = undefined;
	m.phase = "idle";
	admitDelivery(rt, m);
}

export function dispatch(rt: SwarmRuntime, m: Member, id: string): void {
	const d = m.delivery;
	if (!d || d.id !== id || d.status !== "admitted") return;
	if (m.gen !== d.gen || m.killed || rt.closing || m.waiter || m.op) return cancel(rt, m, d);
	if (m.role === "coordinator" && rt.binding.headless) return cancel(rt, m, d);
	let text: string;
	if (d.kind === "prompt") {
		// Everything the member can see between its reservation and the brief rides with the
		// brief, bounded like any wake page. When the page stops short of the brief, the cursor
		// advances only through the last presented post; the rest arrives with the next wake.
		const floor = pageFloor(m);
		const page = rt.board.page(m.name, m.role, floor, LIMITS.wakePage);
		const early = page.messages.filter(p => p.seq < m.briefSeq);
		const truncated = page.more && page.next_since < m.briefSeq;
		const stored = m.brief ? undefined : briefFromPost(rt.board.messages[m.briefSeq - 1]?.text ?? "", m.name);
		text = firstMessage({
			name: m.name,
			addedBy: m.addedBy,
			briefSeq: m.briefSeq,
			// After a restart only the brief post survives; it already carries the slice line.
			brief: m.brief || stored || "",
			task: m.brief ? m.task || undefined : undefined,
			forkSource: m.fork || undefined,
			early,
		});
		d.carriesBrief = true;
		d.carriesPosts = early.length > 0;
		d.through = truncated ? page.next_since : Math.max(floor, m.briefSeq);
		d.cause = "brief";
		d.direct = true;
		const reminderEntries = Object.entries(m.reminders) as [ReminderKey, string][];
		if (reminderEntries.length) {
			text = `${reminderEntries.map(([, t]) => `(${t})`).join("\n")}\n\n${text}`;
			d.reminderKeys = reminderEntries.map(([k]) => k);
		}
	} else {
		const page = rt.board.page(m.name, m.role, pageFloor(m), LIMITS.wakePage);
		const notices = m.notices.slice();
		const reminderEntries = Object.entries(m.reminders) as [ReminderKey, string][];
		const nudge = d.nudge && m.role === "worker" ? nudgeText(m.addedBy) : undefined;
		if (!page.messages.length && !notices.length && !reminderEntries.length && !nudge) return cancel(rt, m, d);
		const pending = wakePendingFor(rt, m);
		const trigger = pending[0]?.seq;
		const noticeTexts = notices.map(n => n.text);
		if (m.droppedNotices > 0) noticeTexts.unshift(`${m.droppedNotices} earlier notices dropped`);
		text = wakeText({
			name: m.name,
			head: rt.board.head,
			reminders: reminderEntries.map(([, t]) => t),
			notices: noticeTexts,
			posts: page.messages,
			more: page.more,
			triggerSeq: trigger,
			nudge,
		});
		d.through = page.next_since;
		d.carriesPosts = page.messages.length > 0;
		d.direct = namesDirectly(rt, m, page.messages);
		d.noticeIds = notices.map(n => n.id);
		d.reminderKeys = reminderEntries.map(([k]) => k);
		d.cause = d.carriesPosts ? "post" : notices.length ? "notice" : m.reminders.resume ? "resume" : "nudge";
	}
	d.text = text;
	d.status = "dispatched";
	d.dispatchedAt = Date.now();
	d.runIdAtDispatch = m.runId;
	m.lastDeliveredThrough = d.through;
	if (d.nudge) {
		m.nudgePending = false;
		m.stats.nudges++;
	}
	rt.scheduleFlush();
	rt.changed();
	if (m.role === "coordinator") {
		rt.binding.sendWake({ customType: "swarm-wake", content: text, display: true, details: { delivery_id: d.id } });
		d.receiptTimer = setTimeout(() => {
			if (m.delivery === d && m.phase === "starting") release(rt, m, "no receipt");
		}, TIMING.coordinatorReceiptMs);
		return;
	}
	const session = m.session;
	if (!session) return release(rt, m, "no session");
	const sent =
		d.kind === "prompt"
			? session.prompt(text)
			: session.sendCustomMessage(
					{ customType: "swarm-wake", content: text, display: true, details: { delivery_id: d.id } },
					{ deliverAs: "aside" },
				);
	const gen = m.gen;
	sent.then(
		() => afterSend(rt, m, d, gen),
		(err: unknown) => sendFailed(rt, m, d, gen, err),
	);
}

/** The send promise resolved: if no run started since dispatch, the wake was folded or dropped. */
function afterSend(rt: SwarmRuntime, m: Member, d: Delivery, gen: number): void {
	if (m.gen !== gen || m.killed || rt.closing) return;
	if (m.runId !== d.runIdAtDispatch) return; // a run started; agent_end settles it
	if (m.delivery === d) {
		release(rt, m, "the wake did not start a turn");
		reconcile(rt, m);
	} else if (m.phase === "starting" || m.phase === "working") {
		m.phase = "idle";
		rt.changed();
		reconcile(rt, m);
	}
}

function sendFailed(rt: SwarmRuntime, m: Member, d: Delivery, gen: number, err: unknown): void {
	if (m.gen !== gen || m.killed || rt.closing) return;
	const text = err instanceof Error ? err.message : String(err);
	if (m.delivery === d) release(rt, m, text);
	if (d.kind === "aside" && m.runId === d.runIdAtDispatch) {
		// A rejected wake is a release, not a failed turn: it is replayed with backoff.
		if (m.phase === "starting") m.phase = "idle";
		reconcile(rt, m);
		return;
	}
	// prompt() rejected: this is the run's failure (single report through settleRun, §6.7).
	if (m.runId === d.runIdAtDispatch) m.runId++;
	settleRun(rt, m, text);
}
