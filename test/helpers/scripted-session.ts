// Scripted WorkerSession/SessionFactory (§12.2). Scripted turns call the real member tools and
// emit the events the host emits (assistant message_end with tool-call lists before tool
// execution, tool_execution_start/end, custom/user message_end receipts, turn_end, agent_end).
// Sends can be told to drop, delay, reject or fold.

import type {
	CreateWorkerOptions,
	CustomWakeMessage,
	HostMessage,
	ModelInfo,
	SessionFactory,
	TranscriptEntry,
	WakeSources,
	WorkerEvent,
	WorkerSession,
} from "../../src/runtime/ports.ts";

export interface ToolOut {
	details: Record<string, unknown>;
	isError?: boolean;
	useless?: boolean;
	content: { type: string; text: string }[];
}

export interface TurnCtx {
	readonly name: string;
	/** The text that started this run (prompt or wake). */
	readonly input: string;
	readonly signal: AbortSignal;
	readonly session: ScriptedSession;
	/** One tool call as its own response. */
	call(tool: string, params?: Record<string, unknown>): Promise<ToolOut>;
	/** Several tool calls in one response (executed concurrently, like the host's shared mode). */
	batch(calls: [string, Record<string, unknown>][]): Promise<ToolOut[]>;
	/** Ends the run with an error (stopReason "error"). */
	fail(message: string): never;
}

export type Brain = (t: TurnCtx) => Promise<void>;

export type SendMode = "normal" | "drop" | "reject" | "fold" | "hang";

class RunFailed extends Error {}

interface CustomToolLike {
	name: string;
	execute(toolCallId: string, params: unknown, onUpdate: unknown, ctx: unknown, signal?: AbortSignal): Promise<ToolOut>;
}

let callSeq = 0;
let entrySeq = 0;

export class ScriptedSession implements WorkerSession {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly name: string;
	model: ModelInfo | undefined;
	thinkingLevel: string | undefined;
	readonly tools: Map<string, CustomToolLike>;
	readonly #listeners = new Set<(e: WorkerEvent) => void>();
	readonly #runListeners = new Set<(state: "running" | "idle") => void>();
	readonly waitTransitions: { id: string; waiting: boolean }[] = [];
	readonly teardown: string[] = [];
	readonly #factory: ScriptedFactory;
	readonly entries: TranscriptEntry[] = [];
	#run: { ac: AbortController; done: Promise<void> } | undefined;
	#runOpen = false;
	get isRunActive(): boolean {
		return this.#runOpen;
	}
	wakeSources: WakeSources | undefined;
	get hasBackgroundWork(): boolean {
		return !!this.wakeSources;
	}
	#last: HostMessage | undefined;
	disposed = false;
	/** Set by a test (or a brain) to emulate the host cost gate refusing a request. */
	costCapRefusal: { readonly message: string } | undefined;
	readonly inputs: string[] = [];
	readonly opts: CreateWorkerOptions;

	constructor(factory: ScriptedFactory, opts: CreateWorkerOptions, id: string) {
		this.#factory = factory;
		this.opts = opts;
		this.name = opts.name;
		this.agentId = factory.resolvedIds.get(opts.name) ?? opts.agentId;
		this.sessionId = id;
		this.sessionFile = `${opts.sessionsDir}/${id}.jsonl`;
		this.model = opts.model;
		this.thinkingLevel = opts.effort;
		this.tools = new Map((opts.customTools as CustomToolLike[]).map(t => [t.name, t]));
	}

	get isStreaming(): boolean {
		return !!this.#run;
	}

	emit(e: WorkerEvent): void {
		if (!this.disposed && e.type === "message_end" && "message" in e && e.message.role === "assistant" && e.message.usage)
			this.opts.onOwnedUsage?.({ usage: e.message.usage, model: e.message.model, provider: e.message.provider });
		for (const l of [...this.#listeners]) l(e);
	}

	subscribe(listener: (event: WorkerEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	subscribeRunState(listener: (state: "running" | "idle") => void): () => void {
		this.#runListeners.add(listener);
		return () => this.#runListeners.delete(listener);
	}

	setBoardWait(id: string, waiting: boolean): void {
		this.waitTransitions.push({ id, waiting });
	}

	#entry(message: HostMessage): void {
		const id = `e${++entrySeq}`;
		this.entries.push({ type: "message", id, parentId: this.entries[this.entries.length - 1]?.id ?? null, message, timestamp: new Date().toISOString() });
	}

	#toolCtx() {
		return {
			sessionManager: {
				getSessionId: () => this.sessionId,
				getBranch: () => this.entries,
			},
		};
	}

	async #startRun(input: string, receipt: HostMessage): Promise<void> {
		const ac = new AbortController();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#run = { ac, done: promise };
		this.inputs.push(input);
		if (!this.#runOpen) {
			this.#runOpen = true;
			for (const listener of this.#runListeners) listener("running");
		}
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message: receipt });
		this.emit({ type: "message_end", message: receipt });
		this.#entry(receipt);
		const brain = this.#factory.brains.get(this.name) ?? this.#factory.defaultBrain;
		let stopReason = "stop";
		let errorMessage: string | undefined;
		const ctx: TurnCtx = {
			name: this.name,
			input,
			signal: ac.signal,
			session: this,
			call: (tool, params = {}) => ctx.batch([[tool, params]]).then(r => r[0] as ToolOut),
			batch: async calls => {
				if (ac.signal.aborted) throw new RunFailed("aborted");
				const ids = calls.map(() => `call_${++callSeq}`);
				const assistant: HostMessage = {
					role: "assistant",
					content: calls.map(([name, args], i) => ({ type: "toolCall", id: ids[i], name, arguments: args })),
					stopReason: "toolUse",
					provider: this.model?.provider,
					model: this.model?.id,
					usage: this.#factory.usage.get(this.name) ?? { totalTokens: 15, cost: { total: 0.001 } },
				};
				this.emit({ type: "message_end", message: assistant });
				this.#entry(assistant);
				const results = await Promise.all(
					calls.map(async ([name, args], i) => {
						const id = ids[i] as string;
						this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
						const tool = this.tools.get(name);
						const out: ToolOut = tool
							? await tool.execute(id, args, undefined, this.#toolCtx(), ac.signal)
							: { details: { error: `unknown tool ${name}` }, isError: true, content: [{ type: "text", text: "" }] };
						this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, isError: !!out.isError, result: out });
						this.#entry({ role: "toolResult", toolCallId: id, toolName: name, isError: !!out.isError, content: out.content as HostMessage["content"] });
						return out;
					}),
				);
				this.emit({ type: "turn_end" });
				if (ac.signal.aborted) throw new RunFailed("aborted");
				return results;
			},
			fail: (message: string): never => {
				throw new RunFailed(`error:${message}`);
			},
		};
		try {
			await brain(ctx);
			if (ac.signal.aborted) stopReason = "aborted";
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (ac.signal.aborted || msg === "aborted") stopReason = "aborted";
			else {
				stopReason = "error";
				errorMessage = msg.startsWith("error:") ? msg.slice(6) : msg;
			}
		}
		this.#last = {
			role: "assistant",
			content: [{ type: "text", text: "turn end" }],
			stopReason,
			errorMessage,
			provider: this.model?.provider,
			model: this.model?.id,
			usage: this.#factory.usage.get(this.name) ?? { totalTokens: 5, cost: { total: 0.0005 } },
		};
		this.emit({ type: "message_end", message: this.#last });
		this.#entry(this.#last);
		this.emit({ type: "turn_end" });
		this.#run = undefined;
		if (stopReason !== "aborted" && this.wakeSources) this.emit({ type: "agent_pause", yielded: true, awaiting: true });
		else this.endRun();
		resolve();
	}

	endRun(): void {
		if (!this.#runOpen) return;
		this.#runOpen = false;
		for (const listener of this.#runListeners) listener("idle");
		this.emit({ type: "agent_end" });
	}

	async prompt(text: string): Promise<unknown> {
		const mode = this.#factory.sendMode(this.name);
		if (mode === "reject") throw new Error("prompt rejected (scripted)");
		if (mode === "drop") return false;
		if (mode === "hang") return new Promise(() => {});
		await this.#startRun(text, { role: "user", content: [{ type: "text", text }] });
		return true;
	}

	async sendCustomMessage(message: CustomWakeMessage, _options: { deliverAs: "aside" }): Promise<boolean> {
		const mode = this.#factory.sendMode(this.name);
		this.#factory.sent.push({ name: this.name, message });
		if (mode === "reject") throw new Error("send rejected (scripted)");
		if (mode === "drop") return false;
		if (mode === "hang") return new Promise(() => {});
		const receipt: HostMessage = { role: "custom", customType: message.customType, content: message.content, details: message.details };
		if (mode === "fold") {
			this.emit({ type: "message_end", message: receipt });
			this.#entry(receipt);
			return false;
		}
		if (this.#run) return false;
		await this.#startRun(message.content, receipt);
		return true;
	}

	async abort(): Promise<void> {
		this.teardown.push("abort");
		const r = this.#run;
		if (!r) return;
		r.ac.abort();
		await r.done;
	}

	async waitForIdle(): Promise<void> {
		while (this.#run) await this.#run.done;
	}

	async setModelTemporary(model: ModelInfo, effort?: string): Promise<void> {
		const f = this.#factory.switchBehavior(this.name);
		if (f === "throw-before") throw new Error("switch failed before applying (scripted)");
		this.model = model;
		if (effort !== undefined) this.thinkingLevel = effort;
		const gate = this.#factory.switchGates.get(this.name);
		if (gate) await gate;
		if (f === "throw-after") throw new Error("reconcile failed after applying (scripted)");
		if (f === "slow") await Bun.sleep(50);
	}

	setThinkingLevel(effort: string | undefined): void {
		this.thinkingLevel = effort;
		this.emit({ type: "thinking_level_changed", thinkingLevel: effort });
	}

	getLastAssistantMessage(): HostMessage | undefined {
		return this.#last;
	}

	branchEntries(): readonly TranscriptEntry[] {
		return this.entries;
	}

	async stop(): Promise<void> {
		await this.abort();
		await this.dispose();
	}

	hostKill(): void {
		this.teardown.push("hostKill");
		this.opts.onHostKill(this);
	}

	async hostRelease(killed: boolean): Promise<void> {
		const disposed = Promise.resolve().then(() => this.dispose());
		if (!killed) this.opts.onHostDispose(this, false, disposed.then(() => this.waitForIdle()));
		await disposed;
		this.teardown.push("hostRelease");
		if (killed) this.opts.onHostRelease(() => this.waitForIdle());
	}

	async dispose(): Promise<void> {
		this.teardown.push("dispose");
		if (this.#factory.disposeHangs.has(this.name)) return new Promise(() => {});
		const gate = this.#factory.disposeGates.get(this.name);
		if (gate) await gate;
		this.disposed = true;
		if (this.wakeSources) {
			this.teardown.push(`cancel/reap ${this.agentId}`);
			this.wakeSources = undefined;
		}
		this.#run?.ac.abort();
	}
}

export class ScriptedFactory implements SessionFactory {
	readonly brains = new Map<string, Brain>();
	readonly sessions = new Map<string, ScriptedSession>();
	readonly resolvedIds = new Map<string, string>();
	readonly all: ScriptedSession[] = [];
	readonly created: CreateWorkerOptions[] = [];
	readonly sent: { name: string; message: CustomWakeMessage }[] = [];
	readonly sendModes = new Map<string, SendMode[]>();
	readonly switchModes = new Map<string, string>();
	readonly switchGates = new Map<string, Promise<void>>();
	readonly disposeHangs = new Set<string>();
	readonly disposeGates = new Map<string, Promise<void>>();
	/** Gates construction per name (resolve to let it finish). */
	readonly gates = new Map<string, Promise<void>>();
	readonly failCreate = new Map<string, string>();
	/** Usage every assistant message of a member reports (default: priced). */
	readonly usage = new Map<string, HostMessage["usage"]>();
	defaultBrain: Brain = async () => {};
	#ids = 0;
	readonly printWake: boolean[] = [];
	setPrintWake(active: boolean): void {
		this.printWake.push(active);
	}
	async dispose(): Promise<void> {}

	sendMode(name: string): SendMode {
		const q = this.sendModes.get(name);
		return q?.shift() ?? "normal";
	}

	switchBehavior(name: string): string {
		return this.switchModes.get(name) ?? "ok";
	}

	async create(o: CreateWorkerOptions): Promise<WorkerSession> {
		this.created.push(o);
		const gate = this.gates.get(o.name);
		if (gate) await gate;
		const fail = this.failCreate.get(o.name);
		if (fail) throw new Error(fail);
		const id = o.mode.kind === "revive" ? o.mode.conversationId : `conv-${o.name}-${++this.#ids}`;
		const s = new ScriptedSession(this, o, id);
		this.sessions.set(o.name, s);
		this.all.push(s);
		return s;
	}
}
