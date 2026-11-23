// Model resolution, effort, switch flows and the quota summary (§4, §6.8, SW-04).

import { EFFORTS, type Effort, isEffort, raceTimeout, TIMING } from "../env.ts";
import { reconcile } from "./delivery.ts";
import type { Member } from "./member.ts";
import { type CoordinatorPort, type ModelInfo, modelKey, type ThinkingCaps, type UsageLimitView } from "./ports.ts";
import type { SwarmRuntime } from "./runtime.ts";
import { claim, remainingSeconds } from "./waits.ts";

export interface Resolved {
	model: ModelInfo;
	suffixEffort?: Effort;
	notes: string[];
}

export type ResolveResult = Resolved | { error: string };

function suggestions(spec: string, list: readonly ModelInfo[]): string[] {
	const lower = spec.toLowerCase();
	const idPart = lower.includes("/") ? lower.slice(lower.indexOf("/") + 1) : lower;
	const terms = idPart.split(/[^a-z0-9.]+/).filter(t => t.length >= 2);
	const scored = list
		.map(m => {
			const key = modelKey(m).toLowerCase();
			const score = terms.reduce((n, t) => n + (key.includes(t) ? 1 : 0), 0);
			return { key: modelKey(m), score };
		})
		.filter(s => s.score > 0)
		.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
	return scored.slice(0, 5).map(s => s.key);
}

function literal(spec: string, list: readonly ModelInfo[], caller: ModelInfo | undefined): ModelInfo | { error: string } | undefined {
	const whole = list.find(m => modelKey(m) === spec);
	if (whole) return whole;
	const bare = list.filter(m => m.id === spec);
	if (bare.length === 1) return bare[0];
	if (bare.length > 1) {
		const same = caller ? bare.find(m => m.provider === caller.provider) : undefined;
		if (same) return same;
		return { error: `ambiguous model id; use one of: ${bare.map(modelKey).join(", ")}` };
	}
	return undefined;
}

/**
 * §4.1 resolution: literal whole `provider/id` → literal bare id → only then a trailing `:effort`
 * split; qualified specs never fuzzy-match; `@role[:effort]` aliases go through the host resolver
 * with the suffix parsed explicitly (invalid suffixes are rejected, SW-14).
 */
export function resolveSpec(
	spec: string,
	list: readonly ModelInfo[],
	caller: ModelInfo | undefined,
	resolveAlias: (alias: string) => ModelInfo | undefined,
): ResolveResult {
	const s = spec.trim();
	if (!s) return { error: "model is empty" };
	if (s === "auto" || s.endsWith(":auto")) return { error: "auto effort is not supported" };
	if (s.startsWith("@")) {
		const colon = s.indexOf(":");
		const alias = colon < 0 ? s : s.slice(0, colon);
		const suffix = colon < 0 ? undefined : s.slice(colon + 1);
		if (suffix !== undefined && !isEffort(suffix))
			return { error: `invalid effort suffix ":${suffix}" on ${alias}; use one of ${EFFORTS.join(", ")}` };
		const m = resolveAlias(alias);
		const found = m ? list.find(x => modelKey(x) === modelKey(m)) : undefined;
		if (!found) return { error: `alias ${alias} does not resolve to an available model` };
		return {
			model: found,
			suffixEffort: suffix as Effort | undefined,
			notes: [`alias ${alias} → ${modelKey(found)}`],
		};
	}
	const direct = literal(s, list, caller);
	if (direct && "error" in direct) return direct;
	if (direct) return { model: direct, notes: [] };
	const colon = s.lastIndexOf(":");
	if (colon > 0) {
		const base = s.slice(0, colon);
		const e = s.slice(colon + 1);
		if (isEffort(e)) {
			const r = literal(base, list, caller);
			if (r && "error" in r) return r;
			if (r) return { model: r, suffixEffort: e, notes: [] };
		}
	}
	const near = suggestions(s, list);
	return { error: `unknown model ${s}${near.length ? `; did you mean: ${near.join(", ")}` : ""}` };
}

export interface EffortResult {
	effort: string | undefined;
	note?: string;
}

/** §4.2: what the session will run, given a request; never `auto`. */
export function resolveEffort(caps: ThinkingCaps, model: ModelInfo, requested: string | undefined): EffortResult {
	const supported = caps.supportedEfforts(model);
	const key = modelKey(model);
	if (supported.length === 0) {
		return requested && requested !== "off"
			? { effort: "off", note: `${key} does not reason; effort '${requested}' → 'off'` }
			: { effort: requested === "off" ? "off" : undefined };
	}
	if (requested === undefined) return { effort: undefined };
	if (requested === "off") return { effort: "off" };
	if (supported.includes(requested)) return { effort: requested };
	const eff = caps.clamp(model, requested) ?? supported[0];
	return { effort: eff, note: `${key} supports ${supported.join(", ")}; '${requested}' → '${eff}'` };
}

export function effortsOf(caps: ThinkingCaps, model: ModelInfo): string[] {
	const s = caps.supportedEfforts(model);
	return s.length ? ["off", ...s.filter(e => e !== "off")] : ["off"];
}

// ---------------------------------------------------------------------------
// Switch flows (§6.8 with SW-04): model changes only at a run boundary; effort-only changes are
// immediate. Every exit reads back the session's actual model/effort, clears the operation and
// leaves the member in a viable phase.
// ---------------------------------------------------------------------------

export interface SwitchEntry {
	name: string;
	model: string;
	effort: string;
	previous: { model: string; effort: string };
	resumed?: boolean;
	note?: string;
}

export type SwitchOutcome =
	| { kind: "switched"; entry: SwitchEntry }
	| { kind: "scheduled"; entry: SwitchEntry }
	| { kind: "error"; error: string };

function readBack(m: Member): void {
	if (!m.session) return;
	m.model = modelKey(m.session.model) || m.model;
	m.effort = m.session.thinkingLevel ?? "";
	m.expectedModel = m.model;
	m.expectedEffort = m.effort;
}

/** Clears a failure and arranges exactly one resume delivery (the stated recovery contract). */
function resumeAfterChange(rt: SwarmRuntime, m: Member, text: string): boolean {
	const hadFailure = !!m.failure;
	m.failure = null;
	m.retryToken = true;
	m.redeliveryExhausted = false;
	m.notBefore = 0;
	if (hadFailure || text) m.reminders.resume = text;
	reconcile(rt, m);
	return !!m.delivery;
}

export async function switchMember(
	rt: SwarmRuntime,
	caller: Member,
	target: Member,
	model: ModelInfo,
	effort: string | undefined,
): Promise<SwitchOutcome> {
	const previous = { model: target.model, effort: target.effort };
	const targetKey = modelKey(model);
	const modelChange = targetKey !== target.model;
	const entry = (resumed?: boolean, note?: string): SwitchEntry => ({
		name: target.name,
		model: target.model,
		effort: target.effort,
		previous,
		...(resumed !== undefined ? { resumed } : {}),
		...(note ? { note } : {}),
	});
	if (target.killed) return { kind: "error", error: `${target.name} is killed` };

	if (target.role === "coordinator") {
		if (!modelChange) {
			if (effort !== undefined) rt.binding.setThinkingLevel(effort);
			target.model = modelKey(rt.binding.model());
			target.effort = rt.binding.thinkingLevel() ?? "";
			return { kind: "switched", entry: entry() };
		}
		rt.coordinatorSwitch = { model: targetKey, effort };
		return { kind: "scheduled", entry: { ...entry(), note: "Applies at your next turn boundary." } };
	}

	if (target.phase === "stopped") {
		target.model = targetKey;
		if (effort !== undefined) target.effort = effort;
		if (target.failure?.kind === "model_unavailable") target.failure = null;
		rt.flushStructural();
		rt.changed();
		return { kind: "switched", entry: entry(false, "applied when it is revived") };
	}

	const self = caller === target;
	if (self && modelChange) {
		target.pendingSwitch = { model: targetKey, effort };
		rt.changed();
		return { kind: "scheduled", entry: { ...entry(), note: "Applies when this turn ends; you will be resumed." } };
	}
	const session = target.session;
	if (!session) return { kind: "error", error: `${target.name} has no live session` };

	if (!modelChange) {
		if (target.phase === "starting" || target.phase === "switching" || target.op)
			return { kind: "error", error: `${target.name} is ${target.detail}; try again when it is waiting` };
		target.expectedEffort = effort ?? "";
		session.setThinkingLevel(effort);
		readBack(target);
		let resumed = false;
		if (target.failure && target.phase === "idle" && !self)
			resumed = resumeAfterChange(rt, target, `Your effort is now ${target.effort || "default"} after a failed turn. Continue where you left off.`);
		rt.flushStructural();
		rt.changed();
		return { kind: "switched", entry: entry(resumed) };
	}

	if (target.phase !== "parked" && (target.phase !== "idle" || target.hostWorking))
		return { kind: "error", error: `\`${target.name}\` is working; switch it when it is waiting` };
	if (!rt.binding.hasAuth(model)) return { kind: "error", error: `no credentials are configured for ${targetKey}` };

	const op = rt.beginOp(target, "switch");
	let prior: { mode: string; remaining: number } | undefined;
	if (target.phase === "parked" && target.waiter) {
		const w = target.waiter;
		prior = { mode: w.mode, remaining: remainingSeconds(w) };
		claim(rt, target, w.id, "switch");
	}
	target.phase = "switching";
	rt.changed();
	let failure: string | undefined;
	try {
		if (prior) {
			await session.abort();
			await session.waitForIdle();
		}
		if (!rt.opValid(target, op)) return { kind: "error", error: `the switch of ${target.name} was cancelled` };
		if (session.isStreaming || (!prior && target.hostWorking)) throw new Error("the worker resumed while switching; try again when it is waiting");
		target.expectedModel = targetKey;
		target.expectedEffort = effort ?? "";
		await session.setModelTemporary(model, effort);
		if (modelKey(session.model) !== targetKey) failure = `the session reports ${modelKey(session.model) || "no model"}`;
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	} finally {
		if (target.op === op) {
			// Reconciliation can await while a native result starts a loop.
			// Preserve the host's phase on both success and failure.
			readBack(target);
			target.op = undefined;
			if (target.phase === "switching") target.phase = target.hostWorking ? "working" : "idle";
			rt.flushStructural();
			rt.changed();
		}
	}
	if (!rt.opValid(target, op, true)) return { kind: "error", error: `the switch of ${target.name} was cancelled` };
	const now = `${target.model} (${target.effort || "default"})`;
	let text: string;
	if (failure) text = `The switch to ${targetKey} failed (${failure}); you are on ${now}.`;
	else if (prior)
		text =
			`Your model is now ${now}. You were waiting on the board; unless the posts below need action, call ` +
			`swarm_wait{mentions_only:${prior.mode !== "anything"}${prior.remaining ? `, timeout_seconds:${prior.remaining}` : ""}} again.`;
	else text = target.failure ? `Your model is now ${now} after a failed turn. Continue where you left off.` : "";
	let resumed: boolean;
	if (prior || (target.failure && !failure)) resumed = resumeAfterChange(rt, target, text);
	else {
		reconcile(rt, target);
		resumed = target.hostWorking || !!target.delivery;
	}
	if (failure) return { kind: "error", error: `switch failed: ${failure}; ${target.name} is on ${now}` };
	return { kind: "switched", entry: entry(resumed) };
}

/** Worker self-switch at its run boundary (settleRun found `pendingSwitch`). */
export function startBoundarySwitch(rt: SwarmRuntime, m: Member): void {
	const sw = m.pendingSwitch;
	m.pendingSwitch = undefined;
	if (!sw) return;
	const model = rt.binding.models().find(x => modelKey(x) === sw.model);
	if (!model) {
		m.reminders.resume = `Your switch to ${sw.model} could not be applied: the model is no longer available.`;
		reconcile(rt, m);
		return;
	}
	const gen = m.gen;
	void switchMember(rt, rt.coordinator, m, model, sw.effort).then(out => {
		if (rt.closing || m.gen !== gen || m.killed) return;
		if (out.kind === "switched" && !m.delivery) {
			m.reminders.resume = `Your model is now ${m.model} (${m.effort || "default"}); continue.`;
			reconcile(rt, m);
		} else if (out.kind === "error") {
			if (m.hostWorking) m.pendingSwitch ??= sw;
			else {
				m.reminders.resume = out.error;
				reconcile(rt, m);
			}
		}
	});
}

export interface CoordinatorSwitchResult {
	state: "ok" | "failed" | "pending";
	text: string;
}

/**
 * Applies a scheduled coordinator switch at a run boundary. Effort is applied only if the model
 * change succeeded. When the host does not finish within `timeoutMs` the fence is invalidated at
 * once: a turn may start on the old model from here on, so a late completion must never change
 * the effort or the roster mid-turn (the roster catches up at the next turn start).
 */
export async function applyCoordinatorSwitch(rt: SwarmRuntime, timeoutMs: number = TIMING.coordinatorSwitchMs): Promise<CoordinatorSwitchResult | undefined> {
	const sw = rt.coordinatorSwitch;
	if (!sw) return undefined;
	rt.coordinatorSwitch = undefined;
	const binding: CoordinatorPort = rt.binding;
	const model = binding.models().find(m => modelKey(m) === sw.model);
	if (!model) return { state: "failed", text: `[swarm] Your switch to ${sw.model} failed: the model is not available.` };
	const fence = ++rt.coordinatorSwitchSeq;
	const attempt = binding.setModel(model).then(
		ok => ({ ok, error: "" }),
		(err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
	);
	const res = await raceTimeout(attempt, timeoutMs, "timeout" as const);
	if (res === "timeout") {
		rt.coordinatorSwitchSeq++;
		void attempt.then(r => {
			const now = modelKey(binding.model());
			rt.coordinatorNotice(
				"external_change",
				r.ok
					? `Your model switch to ${sw.model} completed late; you are on ${now || "?"}; the effort was left unchanged.`
					: `Your model switch to ${sw.model} failed${r.error ? ` (${r.error})` : ""}.`,
			);
		});
		return { state: "pending", text: `[swarm] Your model switch to ${sw.model} is still being applied; continue your work.` };
	}
	if (fence === rt.coordinatorSwitchSeq) {
		if (res.ok && sw.effort !== undefined) binding.setThinkingLevel(sw.effort);
		rt.coordinator.model = modelKey(binding.model());
		rt.coordinator.effort = binding.thinkingLevel() ?? "";
		rt.flushStructural();
		rt.changed();
	}
	const now = `${rt.coordinator.model} (${rt.coordinator.effort || "default"})`;
	if (!res.ok)
		return { state: "failed", text: `[swarm] Your switch to ${sw.model} failed${res.error ? ` (${res.error})` : ""}; you are on ${now}. Continue.` };
	return { state: "ok", text: `[swarm] Your model is now ${now}. Continue.` };
}

/**
 * The coordinator's self switch requested before any swarm exists, applied at the main run's
 * boundary from the binding alone (nothing is created on disk). Effort is applied only when the
 * model switch succeeded in time; a late completion never changes the effort.
 */
export async function applyPreSwarmSwitch(binding: CoordinatorPort, timeoutMs: number): Promise<CoordinatorSwitchResult | undefined> {
	const sw = binding.pendingSelfSwitch;
	if (!sw) return undefined;
	binding.pendingSelfSwitch = undefined;
	const model = binding.models().find(m => modelKey(m) === sw.model);
	if (!model) return { state: "failed", text: `[swarm] Your switch to ${sw.model} failed: the model is not available.` };
	const attempt = binding.setModel(model).then(
		ok => ({ ok, error: "" }),
		(err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
	);
	const res = await raceTimeout(attempt, timeoutMs, "timeout" as const);
	if (res === "timeout") return { state: "pending", text: `[swarm] Your model switch to ${sw.model} is still being applied; the effort was left unchanged.` };
	if (res.ok && sw.effort !== undefined) binding.setThinkingLevel(sw.effort);
	const now = `${modelKey(binding.model())} (${binding.thinkingLevel() || "default"})`;
	if (!res.ok) return { state: "failed", text: `[swarm] Your switch to ${sw.model} failed${res.error ? ` (${res.error})` : ""}; you are on ${now}. Continue.` };
	return { state: "ok", text: `[swarm] Your model is now ${now}. Continue.` };
}

// ---------------------------------------------------------------------------
// Quota summary (advisory; §8.2 models).
// ---------------------------------------------------------------------------

export interface QuotaRow {
	limit: string;
	scope?: string;
	remaining?: string;
	resets?: string;
	status?: string;
}

function fmtReset(ms: number | undefined): string | undefined {
	if (!ms) return undefined;
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function quotaRows(limits: readonly UsageLimitView[]): QuotaRow[] {
	return limits.map(l => {
		const row: QuotaRow = { limit: l.label };
		const scope = [l.scope?.tier, l.scope?.modelId].filter(Boolean).join(" ");
		if (scope) row.scope = scope;
		const rem =
			l.amount?.remainingFraction ?? (l.amount?.usedFraction !== undefined ? 1 - l.amount.usedFraction : undefined);
		if (rem !== undefined) row.remaining = `${Math.round(rem * 100)}%`;
		const reset = fmtReset(l.window?.resetsAt);
		if (reset) row.resets = reset;
		if (l.status) row.status = l.status;
		return row;
	});
}

export class QuotaCache {
	#at = 0;
	#value: Record<string, QuotaRow[]> | null = null;

	async get(binding: CoordinatorPort): Promise<Record<string, QuotaRow[]> | null> {
		if (this.#value && Date.now() - this.#at < TIMING.quotaCacheMs) return this.#value;
		const src = binding.usage();
		if (!src) return null;
		try {
			const reports = await src.reports(AbortSignal.timeout(TIMING.quotaTimeoutMs));
			const out: Record<string, QuotaRow[]> = {};
			for (const r of reports) if (r.limits?.length) out[r.provider] = quotaRows(r.limits);
			this.#value = out;
			this.#at = Date.now();
			return out;
		} catch {
			return null;
		}
	}
}
