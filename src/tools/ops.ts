// swarm / post_message / read_board / swarm_wait implementations shared by the main-session and
// member wrappers (§8). Host-agnostic: the wrappers supply an OpsContext.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { channelMentions, effectiveChannels, MAIN } from "../board/channels.ts";
import type { BoardMessage, Role, WorkspaceMode } from "../board/types.ts";
import {
	CHANNEL_RE,
	EFFORTS,
	type Effort,
	hasKey,
	isEffort,
	LIMITS,
	NAME_RE,
	RESERVED_CHANNELS,
	RESERVED_NAMES,
	ROLE_WORKER_NAME_RE,
	type SwarmEnv,
} from "../env.ts";
import {
	type PresentedPage,
	pageFloor,
	presentToolResult,
	registerReadDelivery,
	toPageMessage,
	wakePendingFor,
} from "../runtime/delivery.ts";
import { completionLabel, INCOMPLETE_RESULT, liveTaskWork, mentionsNobody } from "../runtime/gate.ts";
import type { ClaimReason, Member } from "../runtime/member.ts";
import { effortsOf, resolveEffort, resolveSpec, type SwitchEntry, switchMember } from "../runtime/models.ts";
import { type CoordinatorPort, type ModelInfo, modelKey, type ThinkingCaps } from "../runtime/ports.ts";
import { HEADLESS_HINT, nudgeText, QUIESCENT_NOTE, STALL_NOTE } from "../runtime/prompts.ts";
import type { AddGroup, ReserveSpec, SwarmRuntime } from "../runtime/runtime.ts";
import { nudgeDue, closeCycle } from "../runtime/settle.ts";
import { arm, remainingSeconds } from "../runtime/waits.ts";
import { helperDepth, permitted } from "./permissions.ts";

// ---------------------------------------------------------------------------
// Result shape and the single woke/elision table (SW-14)
// ---------------------------------------------------------------------------

export const WOKE = [
	"post",
	"timeout",
	"notice",
	"stall",
	"incomplete",
	"nudge",
	"switch",
	"interrupted",
	"aborted",
	"killed",
	"closing",
	"not_parked",
	"no_swarm",
] as const;
export type Woke = (typeof WOKE)[number];

/** Results that carry no information and are elided from context later (H18). */
export const USELESS_WOKE: Readonly<Record<Woke, boolean>> = {
	post: false,
	timeout: false,
	notice: false,
	stall: false,
	incomplete: false,
	nudge: false,
	switch: false,
	interrupted: true,
	aborted: true,
	killed: true,
	closing: true,
	not_parked: true,
	no_swarm: true,
};

export interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
	useless?: boolean;
}

function prune(v: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = x;
	return out;
}

export function ok(payload: Record<string, unknown>, useless = false): ToolResult {
	const details = prune(payload);
	const r: ToolResult = { content: [{ type: "text", text: JSON.stringify(details) }], details };
	if (useless) r.useless = true;
	return r;
}

export function fail(error: string, hint?: string): ToolResult {
	const details = prune({ error, hint });
	return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
}

export const NOT_A_MEMBER = "this session is no longer a member of the swarm";

export interface OpsContext {
	/** The runtime, or null when no swarm exists yet (main session only). */
	rt: SwarmRuntime | null;
	/** The calling member (null only for the main session before a swarm exists). */
	caller: Member | null;
	/** Main session: creates the swarm lazily (title, channel create, add). Workers: never called. */
	ensure(): SwarmRuntime | { error: string };
	/** The plugin's environment (the object the runtime uses); readable before a swarm exists. */
	env: SwarmEnv;
	binding: CoordinatorPort;
	caps: ThinkingCaps;
	toolCallId: string;
	signal: AbortSignal | undefined;
	/** The tool calls of the response this call belongs to, in emitted order, if known. */
	batch: string[] | undefined;
	isWorker: boolean;
}

// ---------------------------------------------------------------------------
// Parameter shapes (validated per action here; schemas are flat)
// ---------------------------------------------------------------------------

export interface SwarmParams {
	action: string;
	name?: string;
	brief?: string;
	model?: string;
	effort?: string;
	tasks?: string[];
	n?: number;
	fork?: string;
	workspace?: string;
	channels?: string[];
	role?: string;
	discard_ignored?: boolean;
	keep_workspace?: boolean;
	summary?: string;
	abandon?: boolean;
	title?: string;
	op?: string;
	channel?: string;
	topic?: string;
	query?: string;
	provider?: string;
	limit?: number;
}

export interface PostParams {
	text: string;
	channel?: string;
}

export interface ReadParams {
	since?: number;
	limit?: number;
	channel?: string;
	status?: boolean;
}

export interface WaitParams {
	since?: number;
	mentions_only?: boolean;
	timeout_seconds?: number;
}

function modeOf(binding: CoordinatorPort): "headless" | "interactive" {
	return binding.headless ? "headless" : "interactive";
}

function openBoard(binding: CoordinatorPort): string {
	return binding.mode === "tui" ? "/swarm" : "";
}

function callerModel(ctx: OpsContext, caller: Member): ModelInfo | undefined {
	if (caller.role === "coordinator") return ctx.binding.model();
	return caller.session?.model ?? ctx.binding.models().find(m => modelKey(m) === caller.model);
}

function callerEffort(ctx: OpsContext, caller: Member): string | undefined {
	if (caller.role === "coordinator") return ctx.binding.thinkingLevel();
	return caller.session?.thinkingLevel ?? (caller.effort || undefined);
}

// ---------------------------------------------------------------------------
// swarm
// ---------------------------------------------------------------------------

export async function swarmOp(ctx: OpsContext, p: SwarmParams): Promise<ToolResult> {
	const rt = ctx.rt;
	switch (p.action) {
		case "status":
			return statusOp(ctx);
		case "models":
			return modelsOp(ctx, p);
		case "add":
			return addOp(ctx, p);
		case "model":
			return modelOp(ctx, p);
		case "kill":
			return killOp(ctx, p);
		case "revive":
			return reviveOp(ctx, p);
		case "finish":
			return finishOp(ctx, p);
		case "title": {
			if (ctx.caller && ctx.caller.role !== "coordinator") return fail("only the coordinator can set the title");
			const title = (p.title ?? "").trim();
			if (!title) return fail("title is required");
			if (title.length > LIMITS.titleChars) return fail(`title is longer than ${LIMITS.titleChars} characters`);
			const r = rt ?? ctx.ensure();
			if ("error" in r) return fail(r.error);
			r.setTitle(title);
			return ok({ title });
		}
		case "channel":
			return channelOp(ctx, p);
		default:
			return fail(`unknown action ${JSON.stringify(p.action)}`, "status | models | add | model | kill | revive | finish | title | channel");
	}
}

function statusOp(ctx: OpsContext): ToolResult {
	const rt = ctx.rt;
	if (!rt || !ctx.caller) return ok({ swarm: null, hint: 'add a worker with swarm{action:"add", …}' });
	const c = rt.coordinator;
	const reminders = ctx.caller === c ? Object.values(c.reminders) : [];
	return ok({
		title: rt.title,
		you: ctx.caller.name,
		mode: modeOf(rt.binding),
		head: rt.board.head,
		swarm_dir: rt.dir,
		open_board: openBoard(rt.binding),
		completion: completionLabel(rt),
		outcome: rt.outcome ? rt.outcome.value : null,
		spend: rt.spendView(),
		members: [...rt.members.values()].filter(m => m.role !== "coordinator").map(m => rt.memberStatus(m)),
		attention: rt.attention(),
		reminder: reminders.length ? reminders.join(" ") : undefined,
		hint: rt.binding.headless ? HEADLESS_HINT : undefined,
	});
}

async function modelsOp(ctx: OpsContext, p: SwarmParams): Promise<ToolResult> {
	const list = ctx.binding.models();
	const caller = ctx.caller;
	const cur = caller ? callerModel(ctx, caller) : ctx.binding.model();
	const providers: Record<string, number> = {};
	for (const m of list) providers[m.provider] = (providers[m.provider] ?? 0) + 1;
	let selected: ModelInfo[];
	const terms = (p.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	if (p.provider || terms.length) {
		selected = list.filter(m => {
			if (p.provider && m.provider !== p.provider) return false;
			const hay = `${modelKey(m)} ${m.name ?? ""}`.toLowerCase();
			return terms.every(t => hay.includes(t));
		});
	} else {
		const inUse = new Set(ctx.rt ? [...ctx.rt.members.values()].filter(m => !m.killed).map(m => m.model) : []);
		selected = list.filter(m => m.provider === cur?.provider || inUse.has(modelKey(m)));
	}
	const limit = Math.max(1, Math.min(100, Math.trunc(p.limit ?? 40)));
	const shown = selected.slice(0, limit);
	const quota = await (ctx.rt?.quota.get(ctx.binding) ?? Promise.resolve(null));
	const quotaShown: Record<string, unknown> = {};
	if (quota) for (const prov of new Set(shown.map(m => m.provider))) if (quota[prov]) quotaShown[prov] = quota[prov];
	return ok({
		current: { model: modelKey(cur), effort: caller ? callerEffort(ctx, caller) ?? "" : ctx.binding.thinkingLevel() ?? "" },
		total: list.length,
		shown: shown.length,
		providers,
		models: shown.map(m => ({
			model: modelKey(m),
			name: m.name,
			efforts: effortsOf(ctx.caps, m),
			context: m.contextWindow,
		})),
		quota: Object.keys(quotaShown).length ? quotaShown : undefined,
		note: "Pass model as provider/id; effort separately or as provider/id:effort. Narrow with query/provider.",
	});
}

/** §4.1–4.2 for one request: the model and the effective effort, with notes. */
function resolveModelAndEffort(
	ctx: OpsContext,
	spec: string | undefined,
	effortParam: string | undefined,
	fallbackModel: ModelInfo | undefined,
	fallbackEffort: string | undefined,
): { model: ModelInfo | undefined; effort: string | undefined; notes: string[] } | { error: string } {
	if (effortParam !== undefined && !isEffort(effortParam)) {
		if (effortParam === "auto") return { error: "auto effort is not supported" };
		return { error: `effort must be one of ${EFFORTS.join(", ")}` };
	}
	const notes: string[] = [];
	let model = fallbackModel;
	let suffix: Effort | undefined;
	if (spec !== undefined) {
		const r = resolveSpec(spec, ctx.binding.models(), callerModel(ctx, ctx.caller ?? ({ role: "coordinator" } as Member)), s =>
			ctx.binding.resolveModel(s),
		);
		if ("error" in r) return r;
		model = r.model;
		suffix = r.suffixEffort;
		notes.push(...r.notes);
	}
	if (effortParam !== undefined && suffix !== undefined && effortParam !== suffix) return { error: "effort given twice" };
	const requested = effortParam ?? suffix ?? fallbackEffort;
	if (!model) return { model: undefined, effort: requested, notes };
	const e = resolveEffort(ctx.caps, model, requested);
	if (e.note) notes.push(e.note);
	return { model, effort: e.effort, notes };
}

async function addOp(ctx: OpsContext, p: SwarmParams): Promise<ToolResult> {
	const caller0 = ctx.caller;
	if (caller0 && caller0.role !== "coordinator" && caller0.role !== "worker") return fail(`${caller0.role} members cannot add members`);
	const role: Role = p.role === "narrator" || p.role === "monitor" ? p.role : p.role === undefined || p.role === "worker" ? "worker" : ("bad" as Role);
	if ((role as string) === "bad") return fail('role must be "worker", "narrator" or "monitor"');
	const ws: WorkspaceMode = p.workspace === "share" || p.workspace === "branch" ? p.workspace : "inherit";
	if (p.workspace !== undefined && p.workspace !== "inherit" && p.workspace !== "share" && p.workspace !== "branch")
		return fail('workspace must be "inherit", "share" or "branch"');
	// Everything is validated before the swarm is created: a refused add never leaves a swarm
	// directory behind. `rt0` is null before the first swarm (no members, no channels yet).
	const rt0 = ctx.rt;
	const callerRole = ctx.caller?.role ?? "coordinator";
	if (rt0?.finishing) return fail("finish is in progress");
	if (rt0?.spendExceeded()) return fail(`the swarm's spend ceiling ($${ctx.env.maxCostUsd}) was reached; no new members are started`);
	const isRoleAdd = role === "narrator" || role === "monitor";
	if (callerRole === "worker" && ctx.caller && rt0) {
		if (isRoleAdd) return fail("only the coordinator adds a narrator or monitor");
		const depth = helperDepth(ctx.caller.name, n => rt0.members.get(n)?.addedBy);
		if (depth >= LIMITS.helperDepth) return fail(`helpers can be nested at most ${LIMITS.helperDepth} deep`);
	}
	let brief = (p.brief ?? "").trim();
	const specs: ReserveSpec[] = [];
	if (isRoleAdd) {
		if (p.n !== undefined || p.tasks !== undefined || p.fork !== undefined || p.channels !== undefined || ws !== "inherit")
			return fail(`n, tasks, fork, channels and workspace are not available for role ${role}`);
		const live = rt0?.workersOf(role) ?? [];
		if (live.length) return fail(`a ${role} is already live (${live.map(m => m.name).join(", ")})`);
		let next = role as string;
		for (let i = 2; rt0?.members.has(next); i++) next = `${role}-${i}`;
		if (p.name !== undefined && p.name !== next) return fail(`a ${role}'s name is assigned: omit name (next is ${next})`);
		specs.push({ name: next });
		if (!brief)
			brief =
				role === "narrator"
					? "You are the narrator. Follow your role block: keep the Overview files current."
					: "You are the monitor. Follow your role block: watch for stalls and nudge only when needed.";
	} else {
		const name = (p.name ?? "").trim();
		if (!name) return fail("name is required");
		if (ROLE_WORKER_NAME_RE.test(name)) return fail(`a worker may not be named ${name}; use role:"narrator" or role:"monitor"`);
		if (!brief) return fail("brief is required");
		if (p.tasks !== undefined && p.n !== undefined) return fail("use tasks or n, not both");
		if (p.tasks !== undefined) {
			if (!Array.isArray(p.tasks) || p.tasks.length < 1 || p.tasks.length > LIMITS.groupMax)
				return fail(`tasks must list 1..${LIMITS.groupMax} slices`);
			for (const [i, t] of p.tasks.entries()) {
				if (typeof t !== "string" || !t.trim()) return fail(`task ${i + 1} is empty`);
				if (t.length > LIMITS.taskChars) return fail(`task ${i + 1} is longer than ${LIMITS.taskChars} characters`);
				specs.push({ name: `${name}-${i + 1}`, task: t.trim() });
			}
		} else if (p.n !== undefined) {
			if (!Number.isInteger(p.n) || p.n < 2 || p.n > LIMITS.groupMax) return fail(`n must be an integer 2..${LIMITS.groupMax}`);
			for (let i = 1; i <= p.n; i++) specs.push({ name: `${name}-${i}` });
		} else specs.push({ name });
	}
	if (brief.length > LIMITS.briefChars) return fail(`brief is longer than ${LIMITS.briefChars} characters`);
	for (const s of specs) {
		if (!NAME_RE.test(s.name)) return fail(`invalid name ${s.name}: use ^[a-z][a-z0-9_-]{0,31}$`);
		if (hasKey(RESERVED_NAMES, s.name)) return fail(`${s.name} is reserved`);
		if (rt0?.members.has(s.name)) return fail(`${s.name} is already used (names are never reused, killed members included)`);
	}
	if ((rt0?.nonKilledCount() ?? 0) + specs.length > ctx.env.maxWorkers)
		return fail(`the swarm is limited to ${ctx.env.maxWorkers} members (OMP_SWARM_MAX_WORKERS)`);
	let channels: string[] | undefined;
	if (p.channels !== undefined) {
		channels = [];
		for (const c of p.channels) {
			if (c === MAIN) continue;
			const ch = rt0?.board.channel(c);
			if (!ch) return fail(`channel #${c} does not exist`);
			if (ch.archived) return fail(`channel #${c} is archived`);
			if (!channels.includes(c)) channels.push(c);
		}
	}
	let fork: AddGroup["fork"];
	if (p.fork !== undefined) {
		if (p.fork === "coordinator") {
			if (callerRole !== "coordinator") return fail("only the coordinator can fork the coordinator");
			const file = ctx.binding.sessionFile();
			if (!file || !existsSync(file)) return fail("the coordinator has no saved transcript yet");
			fork = { source: "coordinator", file };
		} else {
			const src = rt0?.members.get(p.fork);
			if (!rt0 || !src || src.role === "coordinator") return fail(`unknown fork source ${p.fork}`);
			const denied = permitted("fork", ctx.caller ?? rt0.coordinator, { name: src.name, role: src.role, addedBy: src.addedBy });
			if (denied) return fail(denied);
			const file = src.sessionFile ? join(rt0.dir, "sessions", basename(src.sessionFile)) : "";
			if (!file || !existsSync(file)) return fail(`${src.name} has no saved transcript`);
			fork = { source: src.name, file };
		}
	}
	const fallbackModel = ctx.caller ? callerModel(ctx, ctx.caller) : ctx.binding.model();
	const fallbackEffort = ctx.caller ? callerEffort(ctx, ctx.caller) : ctx.binding.thinkingLevel();
	const me = resolveModelAndEffort(ctx, p.model, p.effort, fallbackModel, fallbackEffort);
	if ("error" in me) return fail(me.error);
	if (me.model && !ctx.binding.hasAuth(me.model)) return fail(`no credentials are configured for ${modelKey(me.model)}`);
	const rtOrErr = rt0 ?? ctx.ensure();
	if ("error" in rtOrErr) return fail(rtOrErr.error);
	const rt = rtOrErr;
	const caller = ctx.caller ?? rt.coordinator;
	// A swarm opened just now (an interrupted earlier open of this session) may already hold names.
	if (!rt0) for (const s of specs) if (rt.members.has(s.name)) return fail(`${s.name} is already used (names are never reused, killed members included)`);
	const group: AddGroup = { role, brief, model: me.model, effort: me.effort, workspace: ws, channels, fork };
	if (caller.role === "coordinator") rt.gate.refusals = 0;
	const reserved = rt.reserve(caller, specs, group);
	const out = await rt.startReserved(caller, reserved, group);
	return ok({
		added: out.added.map(m => ({
			name: m.name,
			role: m.role,
			model: m.model,
			effort: m.effort,
			workspace: prune({ mode: m.workspace.mode, path: m.workspace.path, branch: m.workspace.branch, base: m.workspace.base?.slice(0, 9) }),
			channels: rt.channelsView(m),
			brief_seq: m.briefSeq,
		})),
		notes: [...me.notes, ...out.notes].length ? [...me.notes, ...out.notes] : undefined,
		errors: out.errors.length ? out.errors : undefined,
		head: rt.board.head,
		mode: modeOf(rt.binding),
		hint: rt.binding.headless ? HEADLESS_HINT : undefined,
		swarm_dir: rt.dir,
		open_board: openBoard(rt.binding),
	});
}

async function modelOp(ctx: OpsContext, p: SwarmParams): Promise<ToolResult> {
	const rt = ctx.rt;
	const caller = ctx.caller;
	if (!rt || !caller) {
		// No swarm yet: only the coordinator's own model, and nothing is created on disk (§8.1).
		// An effort-only change applies now; a model change waits on the binding for the run
		// boundary (or for the runtime, if a swarm is created first).
		if (p.name !== undefined) return fail("no swarm yet");
		if (p.model === undefined && p.effort === undefined) return fail("give model and/or effort");
		const b = ctx.binding;
		const me = resolveModelAndEffort(ctx, p.model, p.effort, b.model(), b.thinkingLevel());
		if ("error" in me) return fail(me.error);
		if (!me.model) return fail("the coordinator's model is not available; give model");
		const previous = { model: modelKey(b.model()), effort: b.thinkingLevel() ?? "" };
		const targetKey = modelKey(me.model);
		const notes = me.notes.length ? me.notes : undefined;
		if (targetKey === previous.model) {
			if (me.effort !== undefined) b.setThinkingLevel(me.effort);
			const entry: SwitchEntry = { name: "coordinator", model: modelKey(b.model()), effort: b.thinkingLevel() ?? "", previous };
			return ok({ switched: [entry], notes });
		}
		b.pendingSelfSwitch = { model: targetKey, effort: me.effort };
		const entry: SwitchEntry = { name: "coordinator", model: previous.model, effort: previous.effort, previous, note: "Applies at your next turn boundary." };
		return ok({ scheduled: [entry], notes });
	}
	const targets = p.name !== undefined ? rt.expand(p.name) : [caller];
	if (!targets.length) return fail(`no member named ${p.name}`);
	const switched: SwitchEntry[] = [];
	const scheduled: SwitchEntry[] = [];
	const notes: string[] = [];
	const errors: { name: string; error: string }[] = [];
	for (const t of targets) {
		const denied = permitted("model", caller, { name: t.name, role: t.role, addedBy: t.addedBy });
		if (denied) {
			errors.push({ name: t.name, error: denied });
			continue;
		}
		let spec = p.model;
		if (spec === undefined && p.effort === undefined) {
			if (t === caller) {
				errors.push({ name: t.name, error: "give model and/or effort" });
				continue;
			}
			spec = modelKey(callerModel(ctx, caller));
		}
		const current = t.role === "coordinator" ? ctx.binding.model() : ctx.binding.models().find(m => modelKey(m) === t.model) ?? t.session?.model;
		const targetEffort = t.role === "coordinator" ? ctx.binding.thinkingLevel() : t.effort || undefined;
		const me = resolveModelAndEffort(ctx, spec, p.effort, current, targetEffort);
		if ("error" in me) {
			errors.push({ name: t.name, error: me.error });
			continue;
		}
		if (!me.model) {
			errors.push({ name: t.name, error: `${t.name}'s model ${t.model || "?"} is not available; give model` });
			continue;
		}
		for (const n of me.notes) if (!notes.includes(n)) notes.push(n);
		const out = await switchMember(rt, caller, t, me.model, me.effort);
		if (out.kind === "error") errors.push({ name: t.name, error: out.error });
		else if (out.kind === "scheduled") scheduled.push(out.entry);
		else switched.push(out.entry);
	}
	return ok({
		switched: switched.length ? switched : undefined,
		scheduled: scheduled.length ? scheduled : undefined,
		notes: notes.length ? notes : undefined,
		errors: errors.length ? errors : undefined,
	});
}

async function killOp(ctx: OpsContext, p: SwarmParams): Promise<ToolResult> {
	const rt = ctx.rt;
	const caller = ctx.caller;
	if (!rt || !caller) return fail("no swarm yet");
	if (!p.name) return fail("name is required");
	const targets = rt.expand(p.name);
	if (!targets.length) return fail(`no member named ${p.name}`);
	const killed: string[] = [];
	const workspaces: unknown[] = [];
	const errors: { name: string; error: string }[] = [];
	await Promise.all(
		targets.map(async t => {
			const denied = permitted("kill", caller, { name: t.name, role: t.role, addedBy: t.addedBy });
			if (denied) {
				errors.push({ name: t.name, error: denied });
				return;
			}
			if (t === caller) {
				errors.push({ name: t.name, error: "a member cannot kill itself" });
				return;
			}
			const ws = await rt.kill(t, { discardIgnored: p.discard_ignored === true, keepWorkspace: p.keep_workspace === true });
			killed.push(t.name);
			if (ws) workspaces.push(ws);
		}),
	);
	return ok({ killed, workspaces: workspaces.length ? workspaces : undefined, errors: errors.length ? errors : undefined });
}

function reviveOp(ctx: OpsContext, p: SwarmParams): ToolResult {
	const rt = ctx.rt;
	const caller = ctx.caller;
	if (!rt || !caller) return fail("no swarm yet");
	const targets =
		p.name !== undefined
			? rt.expand(p.name)
			: [...rt.members.values()].filter(m => m.phase === "stopped" && wakePendingFor(rt, m).length > 0);
	if (p.name !== undefined && !targets.length) return fail(`no member named ${p.name}`);
	const reviving: string[] = [];
	const skipped: { name: string; reason: string }[] = [];
	for (const t of targets) {
		const denied = permitted("revive", caller, { name: t.name, role: t.role, addedBy: t.addedBy });
		if (denied) {
			skipped.push({ name: t.name, reason: denied });
			continue;
		}
		const why = rt.revive(t);
		if (why) skipped.push({ name: t.name, reason: why });
		else reviving.push(t.name);
	}
	if (caller.role === "coordinator") rt.gate.refusals = 0;
	return ok({ reviving, skipped: skipped.length ? skipped : undefined });
}

async function finishOp(ctx: OpsContext, p: SwarmParams): Promise<ToolResult> {
	const rt = ctx.rt;
	const caller = ctx.caller;
	if (!rt || !caller) return fail("no swarm yet");
	if (caller.role !== "coordinator") return fail("only the coordinator can finish");
	const summary = (p.summary ?? "").trim();
	if (!summary) return fail("summary is required");
	if (summary.length > LIMITS.summaryChars) return fail(`summary is longer than ${LIMITS.summaryChars} characters`);
	if (!mentionsNobody(summary, [...rt.members.keys()]) || /(^|\s)@/.test(summary))
		return fail("the summary must not mention anyone (no @name, @all or @#channel): a [done] post that names someone is not a completion");
	if (/^\s*\[abandoned\]/im.test(summary)) return fail("the summary must not contain an [abandoned] line; pass abandon:true instead");
	rt.gate.refusals = 0;
	const r = await rt.finish(summary, p.abandon === true);
	if ("error" in r) return fail(r.error);
	return ok({ completion: completionLabel(rt), seq: r.seq, abandoned: r.abandoned.length ? r.abandoned : undefined });
}

function channelOp(ctx: OpsContext, p: SwarmParams): ToolResult {
	const caller0 = ctx.caller;
	const op = p.op;
	if (op === "list") {
		if (!ctx.rt) return ok({ channels: [] });
		return ok({ channels: ctx.rt.channelList() });
	}
	const name = (p.channel ?? "").trim().toLowerCase();
	if (op === "create") {
		if (caller0 && caller0.role !== "coordinator") return fail("only the coordinator can create channels");
		if (!CHANNEL_RE.test(name) || hasKey(RESERVED_CHANNELS, name)) return fail(`invalid channel name ${JSON.stringify(name)}: ^[a-z][a-z0-9-]{0,23}$, not main/all/here`);
		const rt = ctx.rt ?? ctx.ensure();
		if ("error" in rt) return fail(rt.error);
		if (rt.board.channel(name)) return fail(`channel #${name} already exists`);
		const topic = (p.topic ?? "").trim().slice(0, 200);
		const r = rt.createChannel(rt.coordinator, name, topic);
		if ("error" in r) return fail(r.error);
		return ok({ channel: name, seq: r.msg.seq });
	}
	const rt = ctx.rt;
	const caller = ctx.caller;
	if (!rt || !caller) return fail("no swarm yet");
	const ch = rt.board.channel(name);
	if (!ch) return fail(`channel #${name} does not exist`);
	if (op === "archive") {
		const denied = permitted("channel_archive", caller);
		if (denied) return fail(denied);
		if (ch.archived) return fail(`channel #${name} is already archived`);
		const r = rt.archiveChannel(caller, name);
		if ("error" in r) return fail(r.error);
		return ok({ channel: name, seq: r.msg.seq });
	}
	if (op === "subscribe" || op === "unsubscribe") {
		if (ch.archived) return fail(`channel #${name} is archived`);
		const targets = p.name !== undefined ? rt.expand(p.name) : [caller];
		if (!targets.length) return fail(`no member named ${p.name}`);
		for (const t of targets) {
			const denied = permitted("channel_subscribe", caller, { name: t.name, role: t.role, addedBy: t.addedBy });
			if (denied) return fail(denied);
			if (t.killed) return fail(`${t.name} is killed`);
		}
		const r = rt.subscribe(caller, op, name, targets);
		if ("error" in r) return fail(r.error);
		return ok({ channel: name, members: targets.map(t => t.name), seq: r.msg.seq });
	}
	return fail('channel needs op: "create" | "list" | "subscribe" | "unsubscribe" | "archive"');
}

// ---------------------------------------------------------------------------
// post_message
// ---------------------------------------------------------------------------

const AT_WORD = /(?<![\p{L}\p{Nd}_-])@(#?)([\p{L}\p{Nd}_-]+)/gu;

function unknownMentions(rt: SwarmRuntime, text: string): string[] {
	const out: string[] = [];
	const names = [...rt.members.keys()];
	for (const m of text.matchAll(AT_WORD)) {
		const isChannel = m[1] === "#";
		const word = (m[2] ?? "").toLowerCase();
		if (isChannel) {
			if (word === MAIN || rt.board.channel(word)) continue;
		} else if (word === "all" || names.includes(word) || names.some(n => new RegExp(`^${word.replace(/[-]/g, "\\-")}-\\d+$`).test(n))) continue;
		const tok = `@${m[1]}${m[2]}`;
		if (!out.includes(tok)) out.push(tok);
	}
	return out;
}

export function postMessageOp(ctx: OpsContext, p: PostParams): ToolResult {
	const rt = ctx.rt;
	const caller = ctx.caller;
	if (!rt || !caller) return fail("no swarm yet", 'add a worker first with swarm{action:"add", …}');
	if (caller.role === "narrator") return fail("the narrator does not post");
	const text = typeof p.text === "string" ? p.text : "";
	if (!text.trim()) return fail("text is empty");
	if (text.length > LIMITS.postChars) return fail(`text is longer than ${LIMITS.postChars} characters`);
	if (channelMentions(text).includes(MAIN)) return fail("@#main calls nobody; name members, or use @all");
	let channel = p.channel?.trim().toLowerCase();
	if (!channel) {
		channel = rt.defaultChannel(caller);
		const ch = channel === MAIN ? undefined : rt.board.channel(channel);
		if (ch?.archived) return fail(`your default channel #${channel} is archived; pass channel explicitly`);
	}
	if (channel !== MAIN) {
		const ch = rt.board.channel(channel);
		if (!ch) return fail(`channel #${channel} does not exist`);
		if (ch.archived) return fail(`channel #${channel} is archived`);
		if (caller.role === "worker") {
			const set = effectiveChannels(caller.role, caller.channels, caller.name);
			if (!set.includes(channel) && !set.includes("*")) return fail(`${caller.name} is not subscribed to #${channel}; post in main or one of your channels`);
		}
	}
	const r = rt.commitPost(caller, text, { channel });
	if ("error" in r) return fail(r.error);
	const addr = rt.board.addressees(r.msg, [...rt.members.keys()].filter(n => n !== caller.name));
	const isDone = caller.role === "coordinator" && text.trimStart().startsWith("[done]");
	return ok({
		seq: r.msg.seq,
		channel,
		mentions: addr.mentions,
		all: addr.all,
		channel_mentions: addr.channels,
		woke: r.woke,
		unknown_mentions: (() => {
			const u = unknownMentions(rt, text);
			return u.length ? u : undefined;
		})(),
		stopped: r.stopped.length ? r.stopped : undefined,
		hint: r.stopped.length
			? `${r.stopped.join(", ")} ${r.stopped.length > 1 ? "are" : "is"} stopped; swarm{action:"revive", name} starts ${r.stopped.length > 1 ? "them" : "it"} again`
			: undefined,
		completion: isDone ? completionLabel(rt) : undefined,
	});
}

// ---------------------------------------------------------------------------
// read_board
// ---------------------------------------------------------------------------

function statusRows(rt: SwarmRuntime): Record<string, unknown>[] {
	return [...rt.members.values()].map(m => {
		const posts = rt.board.postsBy(m.name);
		const last = posts[posts.length - 1];
		const row: Record<string, unknown> = {
			name: m.name,
			role: m.role,
			state: m.state,
			detail: m.detail,
			wake_mode: m.phase === "parked" ? m.wakeMode : m.role === "narrator" ? "anything" : m.state === "working" ? "working" : "mentions",
			wait_since: m.waitSince,
			last_read_seq: m.lastReadSeq,
			channels: rt.channelsView(m),
		};
		if (m.waitUntil) row.wait_until = m.waitUntil;
		if (last !== undefined) {
			row.last_post_seq = last;
			row.last_post_time = rt.board.messages[last - 1]?.time;
		}
		if (m.failure) row.error = `${m.failure.kind}: ${m.failure.text}`;
		return row;
	});
}

export function readBoardOp(ctx: OpsContext, p: ReadParams): ToolResult {
	const rt = ctx.rt;
	const caller = ctx.caller;
	if (!rt || !caller) return ok({ swarm: null, head: 0, messages: [] }, true);
	const head = rt.board.head;
	if (p.status) return ok({ head, tail_from_seq: 1, members: statusRows(rt) });
	if (p.since !== undefined && (!Number.isInteger(p.since) || p.since < 0)) return fail("since must be an integer ≥ 0");
	if (p.since !== undefined && p.since > head) return fail(`since ${p.since} is beyond the board head ${head}`);
	const limit = Math.max(1, Math.min(LIMITS.readPage.maxLimit, Math.trunc(p.limit ?? LIMITS.readPage.limit)));
	const channel = p.channel?.trim().toLowerCase();
	if (channel !== undefined && channel !== "*" && channel !== MAIN && !rt.board.channel(channel))
		return fail(`channel #${channel} does not exist`);
	const cursor = pageFloor(caller);
	let since = p.since ?? cursor;
	let sinceNote: number | undefined;
	if (channel === undefined && since > cursor) {
		sinceNote = since;
		since = cursor; // never skip an unread post
	}
	const page = rt.board.page(caller.name, caller.role, since, { limit, maxBytes: LIMITS.readPage.maxBytes, channel });
	if (channel === undefined && page.messages.length) registerReadDelivery(rt, caller, ctx.toolCallId, page);
	return ok(
		{
			head,
			since,
			since_used: sinceNote !== undefined ? since : undefined,
			messages: page.messages.map(m => toPageMessage(m, caller.name)),
			more: page.more,
			next_since: page.next_since,
		},
		page.messages.length === 0,
	);
}

// ---------------------------------------------------------------------------
// swarm_wait (§6.3 with SW-01 batch rule and SW-03 quiescence)
// ---------------------------------------------------------------------------

function waitPayload(
	rt: SwarmRuntime,
	m: Member,
	woke: Woke,
	presented: PresentedPage | undefined,
	extra: Record<string, unknown>,
): ToolResult {
	const base: Record<string, unknown> = { woke, head: rt.board.head };
	if (presented) {
		base.messages = presented.page.messages.map((x: BoardMessage) => toPageMessage(x, m.name));
		base.notices = presented.notices;
		base.more = presented.page.more;
		base.next_since = presented.page.next_since;
		if (presented.triggerSeq !== undefined) base.trigger_seq = presented.triggerSeq;
		if (presented.reminders.length) base.reminder = presented.reminders.join(" ");
	}
	return ok({ ...base, ...extra }, USELESS_WOKE[woke]);
}

export async function swarmWaitOp(ctx: OpsContext, p: WaitParams): Promise<ToolResult> {
	const rt = ctx.rt;
	const m = ctx.caller;
	if (!rt || !m) return ok({ woke: "no_swarm" }, true);
	const head = rt.board.head;
	if (p.since !== undefined && (!Number.isInteger(p.since) || p.since < 0)) return fail("since must be an integer ≥ 0");
	if (p.since !== undefined && p.since > head) return fail(`since ${p.since} is beyond the board head ${head}`);
	if (p.timeout_seconds !== undefined && (!Number.isInteger(p.timeout_seconds) || p.timeout_seconds < 1 || p.timeout_seconds > 86_400))
		return fail("timeout_seconds must be an integer 1..86400");
	const batch = ctx.batch;
	if (batch && batch.length > 1) {
		if (ctx.isWorker)
			return ok({ woke: "not_parked", note: "swarm_wait must be the only tool call in its response. The other calls ran; call swarm_wait again on its own." }, true);
		if (batch[batch.length - 1] !== ctx.toolCallId)
			return ok({ woke: "not_parked", note: "swarm_wait must be the last tool call of a response. The other calls ran; call swarm_wait again on its own." }, true);
	}
	if (ctx.signal?.aborted) return ok({ woke: "aborted" }, true);
	const mode = p.mentions_only === false ? "anything" : "mentions";
	const cursorNote = p.since !== undefined && p.since !== pageFloor(m) ? `your read cursor is #${pageFloor(m)}; since is advisory` : undefined;
	// ── synchronous section: no await between here and arm ──
	const d = m.delivery;
	if (d?.status === "admitted") {
		m.delivery = undefined;
	} else if (d?.status === "dispatched" && d.kind === "tool") {
		return ok({ woke: "not_parked", note: "Another board tool ran in the same response; call swarm_wait on its own." }, true);
	} else if (d?.status === "dispatched") {
		return ok({ woke: "interrupted", note: "A wake message is arriving; read it." }, true);
	}
	const isCoord = m.role === "coordinator";
	// A scheduled self switch (worker: pendingSwitch; coordinator: rt.coordinatorSwitch) applies at
	// the run boundary: parking would keep the run, and its turns, on the old model.
	if (m.pendingSwitch || (isCoord && rt.coordinatorSwitch))
		return ok({ woke: "switch", note: "Your model switch applies when this turn ends. End your turn." });
	if (isCoord && rt.outcome?.terminal) return ok({ ...INCOMPLETE_RESULT });
	if (nudgeDue(rt, m) && m.cycle) {
		m.cycle.nudged = true;
		m.stats.nudges++;
		return ok({ woke: "nudge", note: nudgeText(m.addedBy) });
	}
	const pending = rt.board.wakePending(m.name, mode, pageFloor(m));
	const quiescentUnread = isCoord && !liveTaskWork(rt).length ? rt.board.gateUnread(pageFloor(m)) : [];
	if (pending.length || m.notices.length || quiescentUnread.length) {
		m.lastParkBlockedSeq = pending[0]?.seq ?? m.lastParkBlockedSeq;
		const presented = presentToolResult(rt, m, ctx.toolCallId, pending.length || quiescentUnread.length ? "post" : "notice");
		return waitPayload(rt, m, pending.length || quiescentUnread.length ? "post" : "notice", presented, {
			waited_seconds: 0,
			cursor_note: cursorNote,
			note: !pending.length && quiescentUnread.length ? QUIESCENT_NOTE : undefined,
		});
	}
	closeCycle(m);
	if (isCoord) rt.gate.refusals = 0;
	const started = Date.now();
	const { waiter, reason } = arm(rt, m, { toolCallId: ctx.toolCallId, mode, timeoutSeconds: p.timeout_seconds, signal: ctx.signal });
	// ───────────────────────────────────────────────────────────
	const why: ClaimReason = await reason;
	const waited = Math.round((Date.now() - started) / 1000);
	if (why === "interrupted" || why === "aborted" || why === "killed" || why === "closing") return ok({ woke: why }, true);
	if (why === "switch") return ok({ woke: "switch", note: "Your model is being switched; you will be resumed on the new model." });
	if (ctx.signal?.aborted) return ok({ woke: "aborted" }, true);
	if (why === "incomplete") return ok({ ...INCOMPLETE_RESULT });
	const extra = waiter.extra ?? {};
	const presented = presentToolResult(rt, m, ctx.toolCallId, why === "timeout" ? "timeout" : why === "stall" ? "stall" : why === "notice" ? "notice" : "post", {
		triggerSeq: typeof extra.trigger === "number" ? extra.trigger : undefined,
	});
	const payloadExtra: Record<string, unknown> = {
		waited_seconds: waited,
		remaining_seconds: remainingSeconds(waiter),
		cursor_note: cursorNote,
	};
	if (why === "stall") {
		payloadExtra.members = extra.members;
		payloadExtra.note = STALL_NOTE;
		if (extra.final) payloadExtra.final = true;
	} else if (extra.quiescent) payloadExtra.note = QUIESCENT_NOTE;
	return waitPayload(rt, m, why, presented, payloadExtra);
}
