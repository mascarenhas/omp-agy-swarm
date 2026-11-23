// Waiters and the one-shot claim (§6.2). A wait ends through exactly one claim: post arrival,
// timer, abort listener, kill, switch, stall/quiescence and shutdown all call `claim`; the
// first wins and the others are no-ops. A claimed member is `resuming`, never `idle`.

import type { WakeMode } from "../board/types.ts";
import type { ClaimReason, Member, Waiter } from "./member.ts";
import type { SwarmRuntime } from "./runtime.ts";

const TOOL_INTERRUPT = "pi-agent-core.tool-interrupt";

export function claim(rt: SwarmRuntime, m: Member, waitId: string, reason: ClaimReason, extra?: Record<string, unknown>): boolean {
	const w = m.waiter;
	if (!w || w.id !== waitId || w.claimed) return false;
	w.claimed = true;
	clearTimeout(w.timer);
	if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
	if (extra) w.extra = extra;
	m.waiter = undefined;
	if (m.phase === "parked") {
		m.phase = reason === "job" ? "working" : "resuming";
		// The park can outlast the stuck interval. A successful claim starts
		// a new activity interval even before the host emits its tool receipt.
		m.tracker.touch();
		m.stuckNotified = false;
	}
	m.wakeMode = "working";
	m.waitUntil = null;
	m.session?.setBoardWait(w.id, false);
	w.resolve(reason);
	rt.keepAlive();
	rt.changed();
	return true;
}

export interface ArmOptions {
	toolCallId: string;
	mode: WakeMode;
	timeoutSeconds: number | undefined;
	signal: AbortSignal | undefined;
}

/**
 * Arms a waiter synchronously and returns the promise of its claim reason. The caller has
 * already done the synchronous pending check: no await may separate that check from this call.
 */
export function arm(rt: SwarmRuntime, m: Member, o: ArmOptions): { waiter: Waiter; reason: Promise<ClaimReason> } {
	const { promise, resolve } = Promise.withResolvers<ClaimReason>();
	const now = Date.now();
	const waiter: Waiter = {
		id: o.toolCallId,
		mode: o.mode,
		startedAt: now,
		deadline: o.timeoutSeconds !== undefined ? now + o.timeoutSeconds * 1000 : undefined,
		timeoutSeconds: o.timeoutSeconds,
		timer: undefined,
		signal: o.signal,
		onAbort: undefined,
		claimed: false,
		resolve,
	};
	m.waiter = waiter;
	m.phase = "parked";
	m.wakeMode = o.mode;
	m.waitSince = m.lastReadSeq;
	m.waitUntil = waiter.deadline ?? null;
	m.session?.setBoardWait(waiter.id, true);
	if (o.timeoutSeconds !== undefined) {
		waiter.timer = setTimeout(() => claim(rt, m, waiter.id, "timeout"), o.timeoutSeconds * 1000);
	}
	if (o.signal) {
		const signal = o.signal;
		waiter.onAbort = () => {
			const r: unknown = signal.reason;
			const interrupted = typeof r === "symbol" && r.description === TOOL_INTERRUPT;
			claim(rt, m, waiter.id, interrupted ? "interrupted" : "aborted");
		};
		signal.addEventListener("abort", waiter.onAbort, { once: true });
	}
	rt.keepAlive();
	rt.changed();
	return { waiter, reason: promise };
}

/** Remaining whole seconds of a timed wait at claim time. */
export function remainingSeconds(w: Waiter, at = Date.now()): number {
	if (w.deadline === undefined) return 0;
	return Math.max(0, Math.ceil((w.deadline - at) / 1000));
}
