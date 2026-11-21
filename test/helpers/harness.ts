// Integration harness: a real SwarmRuntime over scripted worker sessions and a fake main binding.
// Coordinator tool calls go through the real ops with the main-session receipts emulated.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { readEnv, type SwarmEnv, TIMING } from "../../src/env.ts";
import type {
	CoordinatorPort,
	CustomWakeMessage,
	ModelInfo,
	PendingSwitch,
	ThinkingCaps,
	TranscriptEntry,
	UsageSource,
} from "../../src/runtime/ports.ts";
import { type RuntimeDeps, SwarmRuntime } from "../../src/runtime/runtime.ts";
import { defaultGit } from "../../src/runtime/workspace.ts";
import { makeMemberTools } from "../../src/tools/member-tools.ts";
import {
	type OpsContext,
	postMessageOp,
	readBoardOp,
	swarmOp,
	swarmWaitOp,
	type ToolResult,
} from "../../src/tools/ops.ts";
import { buildSchemas, type Zod } from "../../src/tools/schemas.ts";
import { ScriptedFactory } from "./scripted-session.ts";

export const REPO = join(import.meta.dir, "..", "..");

export const MODELS: ModelInfo[] = [
	{ provider: "mock", id: "coord", reasoning: true },
	{ provider: "mock", id: "worker-a", reasoning: true },
	{ provider: "mock", id: "worker-b", reasoning: true },
	{ provider: "mock", id: "worker-limited", reasoning: true },
	{ provider: "mock", id: "plain", reasoning: false },
	{ provider: "mock", id: "always-429", reasoning: true },
];

const EFFORT_TABLE: Record<string, string[]> = {
	coord: ["low", "medium", "high"],
	"worker-a": ["low", "medium", "high"],
	"worker-b": ["low", "medium", "high"],
	"worker-limited": ["low", "high"],
	plain: [],
	"always-429": ["low"],
};

const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const fakeCaps: ThinkingCaps = {
	supportedEfforts: m => EFFORT_TABLE[m.id] ?? (m.reasoning ? ["low", "medium", "high"] : []),
	clamp: (m, e) => {
		const s = EFFORT_TABLE[m.id] ?? [];
		if (!s.length) return undefined;
		if (s.includes(e)) return e;
		const i = ORDER.indexOf(e);
		for (let k = i - 1; k >= 0; k--) if (s.includes(ORDER[k] as string)) return ORDER[k];
		for (let k = i + 1; k < ORDER.length; k++) if (s.includes(ORDER[k] as string)) return ORDER[k];
		return s[0];
	},
};

export class FakeBinding implements CoordinatorPort {
	readonly sessionId: string;
	mode: "tui" | "rpc" | "print" | "json";
	readonly cwd: string;
	currentModel: ModelInfo | undefined = MODELS[0];
	effort: string | undefined = "high";
	models_: ModelInfo[] = [...MODELS];
	wakes: CustomWakeMessage[] = [];
	notes: string[] = [];
	pendingSelfSwitch: PendingSwitch | undefined;
	setModelResult: boolean | "throw" | "hang" = true;
	/** When set, setModel completes only after this promise resolves (a slow host switch). */
	setModelDelay: Promise<void> | undefined;
	entries: TranscriptEntry[] = [];
	tools: string[] = ["read", "bash", "edit", "write", "glob", "grep", "eval", "todo", "web_search", "lsp", "ast_grep", "ast_edit", "task", "wait"];
	file: string | undefined;
	/** Called for each wake sent to the interactive coordinator. */
	onWake: ((m: CustomWakeMessage) => void) | undefined;

	constructor(sid: string, mode: "tui" | "rpc" | "print" | "json", cwd: string) {
		this.sessionId = sid;
		this.mode = mode;
		this.cwd = cwd;
	}
	get headless(): boolean {
		return this.mode === "print" || this.mode === "json";
	}
	sessionFile(): string | undefined {
		return this.file;
	}
	artifactsDir(): string | null {
		return null;
	}
	model(): ModelInfo | undefined {
		return this.currentModel;
	}
	thinkingLevel(): string | undefined {
		return this.effort;
	}
	models(): ModelInfo[] {
		return this.models_;
	}
	resolveModel(spec: string): ModelInfo | undefined {
		if (spec === "@smol") return this.models_.find(m => m.id === "worker-b");
		return this.models_.find(m => `${m.provider}/${m.id}` === spec || m.id === spec);
	}
	hasAuth(model: ModelInfo): boolean {
		return model.id !== "noauth";
	}
	async setModel(model: ModelInfo): Promise<boolean> {
		if (this.setModelResult === "throw") throw new Error("setModel failed");
		if (this.setModelResult === "hang") return new Promise(() => {});
		if (this.setModelDelay) await this.setModelDelay;
		if (this.setModelResult) this.currentModel = model;
		return this.setModelResult;
	}
	setThinkingLevel(effort: string): void {
		this.effort = effort;
	}
	sendWake(message: CustomWakeMessage): void {
		this.wakes.push(message);
		this.onWake?.(message);
	}
	activeTools(): string[] {
		return this.tools;
	}
	branchEntries(): readonly TranscriptEntry[] {
		return this.entries;
	}
	notify(text: string): void {
		this.notes.push(text);
	}
	usage(): UsageSource | undefined {
		return undefined;
	}
}

export interface HarnessOptions {
	mode?: "tui" | "rpc" | "print" | "json";
	env?: Partial<SwarmEnv>;
	root?: string;
	sid?: string;
	cwd?: string;
}

let callSeq = 0;

export class Harness {
	readonly root: string;
	readonly dir: string;
	readonly binding: FakeBinding;
	readonly factory: ScriptedFactory;
	readonly deps: RuntimeDeps;
	readonly logs: string[] = [];
	rt: SwarmRuntime;
	readonly schemas = buildSchemas(zod as unknown as Zod);

	constructor(opts: HarnessOptions = {}) {
		this.root = opts.root ?? mkdtempSync(join(tmpdir(), "swarm-it-"));
		this.dir = join(this.root, "swarm");
		mkdirSync(this.dir, { recursive: true });
		const cwd = opts.cwd ?? join(this.root, "work");
		mkdirSync(cwd, { recursive: true });
		this.binding = new FakeBinding(opts.sid ?? "01a1fc2e-701b-741a-8abd-a6061302517d", opts.mode ?? "print", cwd);
		this.factory = new ScriptedFactory();
		const env: SwarmEnv = { ...readEnv({}), dir: this.dir, ...opts.env };
		this.deps = {
			makeFactory: () => this.factory,
			caps: fakeCaps,
			makeMemberTools: (rt, m, gen) => makeMemberTools(rt, m, gen, { schemas: this.schemas, caps: fakeCaps, binding: () => rt.binding }),
			packageDir: REPO,
			defaultsDir: join(this.root, "defaults"),
			env,
			git: defaultGit,
			log: l => this.logs.push(l),
		};
		this.rt = SwarmRuntime.open(this.binding, this.deps, this.dir, false);
	}

	/** Re-opens the same swarm dir as a new process would (after shutdown or a simulated crash). */
	reopen(): SwarmRuntime {
		this.factory.sessions.clear();
		this.rt = SwarmRuntime.open(this.binding, this.deps, this.dir, false);
		return this.rt;
	}

	#ctx(id: string, signal?: AbortSignal, batch?: string[]): OpsContext {
		return {
			rt: this.rt,
			caller: this.rt.coordinator,
			ensure: () => this.rt,
			env: this.deps.env,
			binding: this.binding,
			caps: fakeCaps,
			toolCallId: id,
			signal,
			batch,
			isWorker: false,
		};
	}

	/** A coordinator tool call with the host's receipts (message_end before, tool_execution_end after). */
	async call(tool: "swarm" | "post_message" | "read_board" | "swarm_wait", params: Record<string, unknown>, opts: { signal?: AbortSignal; batch?: string[]; id?: string } = {}): Promise<ToolResult> {
		const id = opts.id ?? `ccall_${++callSeq}`;
		const batch = opts.batch ?? [id];
		this.rt.onMainMessageEnd({ role: "assistant", content: batch.map(b => ({ type: "toolCall", id: b, name: tool })) });
		const ctx = this.#ctx(id, opts.signal, batch);
		const op =
			tool === "swarm" ? swarmOp : tool === "post_message" ? postMessageOp : tool === "read_board" ? readBoardOp : swarmWaitOp;
		const res = await (op as (c: OpsContext, p: unknown) => Promise<ToolResult> | ToolResult)(ctx, params);
		this.rt.onMainToolEnd(id, !!res.isError);
		return res;
	}

	swarm(params: Record<string, unknown>): Promise<ToolResult> {
		return this.call("swarm", params);
	}

	post(text: string, channel?: string): Promise<ToolResult> {
		return this.call("post_message", channel ? { text, channel } : { text });
	}

	session(name: string) {
		const s = this.factory.sessions.get(name);
		if (!s) throw new Error(`no session for ${name}`);
		return s;
	}

	member(name: string) {
		const m = this.rt.members.get(name);
		if (!m) throw new Error(`no member ${name}`);
		return m;
	}

	async close(): Promise<void> {
		await this.rt.shutdown();
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** Waits until `pred` holds (polling every 5 ms) or throws after `ms`. */
export async function until(pred: () => boolean, ms = 3000, what = "condition"): Promise<void> {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** Lets queued microtasks and immediate timers run. */
export async function settle(times = 3): Promise<void> {
	for (let i = 0; i < times; i++) await Bun.sleep(0);
}

/** Shortens the runtime's timers for tests (the constants are module state shared by the run). */
export function fastTimers(overrides: Partial<Record<keyof typeof TIMING, unknown>> = {}): void {
	const t = TIMING as unknown as Record<string, unknown>;
	t.stallMs = 60;
	t.redeliveryMs = [20, 40, 60];
	t.failureRetryMs = 10;
	t.coordinatorReceiptMs = 60;
	t.killStopMs = 200;
	t.gateBudgetMs = 300;
	t.failureNoticeMs = 0;
	t.coordinatorSwitchMs = 200;
	t.gateSwitchMs = 300;
	t.keepAliveMs = 50;
	t.metricsDebounceMs = 20;
	t.shutdownDisposeMs = 100;
	Object.assign(t, overrides);
}
