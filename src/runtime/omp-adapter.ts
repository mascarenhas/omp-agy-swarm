// The ONLY module with value imports from @oh-my-pi/pi-coding-agent and @oh-my-pi/pi-catalog.
// Every import is static: the compiled omp binary resolves @oh-my-pi/* only through static
// imports (H1). Restricted workers register in the host's process-global registry with CAS.

import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	type AgentRef,
	AgentSession,
	AgentRegistry,
	createAgentSession,
	createSubagentSettings,
	type CustomTool,
	type ExtensionAPI,
	MAIN_AGENT_ID,
	SessionManager,
	type Settings,
	subagentLspWritethroughSettings,
	usageContextTokens,
	VERSION,
} from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager, type AgentLifecycleApi } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { raceTimeout, TIMING } from "../env.ts";
import { HubBridge } from "./hub-bridge.ts";
import { preferredAgentId } from "./member.ts";
import type { CoordinatorBinding } from "./coordinator.ts";
import { WorkerStartupUnstopped } from "./ports.ts";
import type {
	CreateWorkerOptions,
	CustomWakeMessage,
	HostMessage,
	ModelInfo,
	SessionFactory,
	ThinkingCaps,
	TranscriptEntry,
	WorkerEvent,
	WorkerIdentity,
	WorkerSession,
} from "./ports.ts";

export const HOST_VERSION: string = VERSION;

/** The calling session's live Settings (inside a main-session handler or tool call, H14). */
export function scopedSettings(): Settings | undefined {
	return findScopedSettings();
}

type ThinkingModel = Parameters<typeof getSupportedEfforts>[0];

export const thinkingCaps: ThinkingCaps = {
	supportedEfforts(model: ModelInfo): string[] {
		try {
			return [...getSupportedEfforts(model as ThinkingModel)];
		} catch {
			return [];
		}
	},
	clamp(model: ModelInfo, effort: string): string | undefined {
		try {
			return clampThinkingLevelForModel(model as ThinkingModel, effort as Parameters<typeof clampThinkingLevelForModel>[1]) ?? undefined;
		} catch {
			return undefined;
		}
	},
};

function sameRealPath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return a === b;
	}
}

class HostWorkerSession implements WorkerSession {
	readonly #s: AgentSession;
	readonly #binding: CoordinatorBinding;
	readonly #host: WorkerRegistration;

	constructor(session: AgentSession, binding: CoordinatorBinding, host: WorkerRegistration) {
		this.#s = session;
		this.#binding = binding;
		this.#host = host;
	}

	get agentId(): string {
		return this.#host.id;
	}
	get sessionId(): string {
		return this.#s.sessionManager.getSessionId();
	}
	get sessionFile(): string | undefined {
		return this.#s.sessionFile;
	}
	get model(): ModelInfo | undefined {
		return this.#s.model;
	}
	get thinkingLevel(): string | undefined {
		return this.#s.thinkingLevel ?? undefined;
	}
	get isStreaming(): boolean {
		return this.#s.isStreaming;
	}
	get costCapRefusal(): { readonly message: string } | undefined {
		return this.#s.costCapRefusal;
	}
	prompt(text: string): Promise<unknown> {
		return this.#s.prompt(text);
	}
	sendCustomMessage(message: CustomWakeMessage, options: { deliverAs: "aside" }): Promise<boolean> {
		return this.#s.sendCustomMessage(message, options);
	}
	abort(): Promise<void> {
		return this.#s.abort();
	}
	waitForIdle(): Promise<void> {
		return this.#s.waitForIdle();
	}
	async setModelTemporary(model: ModelInfo, effort?: string): Promise<void> {
		const host = this.#binding.hostModel(model);
		if (!host) throw new Error(`model ${model.provider}/${model.id} is not available`);
		await this.#s.setModelTemporary(host, effort as Parameters<AgentSession["setModelTemporary"]>[1]);
	}
	setThinkingLevel(effort: string | undefined): void {
		this.#s.setThinkingLevel(effort as Parameters<AgentSession["setThinkingLevel"]>[0]);
	}
	subscribe(listener: (event: WorkerEvent) => void): () => void {
		return this.#s.subscribe(ev => listener(ev as WorkerEvent));
	}
	getLastAssistantMessage(): HostMessage | undefined {
		return this.#s.getLastAssistantMessage() as HostMessage | undefined;
	}
	branchEntries(): readonly TranscriptEntry[] {
		return this.#s.sessionManager.getBranch() as unknown as TranscriptEntry[];
	}
	setBoardWait(waitId: string, waiting: boolean): void {
		this.#host.setBoardWait(waitId, waiting);
	}
	stop(): Promise<void> {
		return this.#host.dispose(true);
	}
	dispose(): Promise<void> {
		return this.#host.dispose();
	}
}

const loggedMissing = new Set<string>();

type WorkerBus = ExtensionAPI["events"];

// Cover the async gap before the SDK CAS, and keep a stopped id unavailable until
// release completes (Tray's native stop path does not pass an exact ref).
const reservedIds = new Set<string>();

class RegistryIdOccupied extends Error {}

class WorkerRegistration {
	readonly #registry: AgentRegistryApi;
	readonly #lifecycle: AgentLifecycleApi;
	readonly #options: CreateWorkerOptions;
	readonly #coordinatorId: string;
	readonly #identity: WorkerIdentity;
	readonly #unwatch: () => void;
	#ref: AgentRef | undefined;
	#raw: AgentSession | undefined;
	#rawDisposal: Promise<void> | undefined;
	#hostClose: Promise<void> | undefined;
	#bridge: HubBridge | undefined;
	#unsubscribe: (() => void) | undefined;
	#owner: "local" | "hostKill" | "hostRemove" | undefined;
	#disposal: Promise<void> | undefined;
	#constructionDone = false;
	#retired = false;
	#hostDone: { promise: Promise<void>; resolve: () => void } | undefined;
	#externalReleaseHook = false;
	#releaseNotified = false;

	constructor(registry: AgentRegistryApi, lifecycle: AgentLifecycleApi, options: CreateWorkerOptions, identity: WorkerIdentity, coordinatorId: string) {
		this.#registry = registry;
		this.#lifecycle = lifecycle;
		this.#options = options;
		this.#coordinatorId = coordinatorId;
		this.#identity = identity;
		this.#unwatch = registry.onChange(({ type, ref }) => {
			if (ref.id !== identity.agentId) return;
			const killed = ref.status === "aborted" && !ref.session;
			if (!this.#ref) {
				if (ref.sessionFile !== identity.sessionFile || (type !== "registered" && !(type === "status_changed" && killed))) return;
				this.#ref = ref;
				if (!killed) {
					lifecycle.adopt(ref.id, { idleTtlMs: 0, onRelease: () => this.#released() }, ref);
					this.#externalReleaseHook = true;
					if (options.signal.aborted) this.#cancel();
					return;
				}
			}
			if (this.#owner) return;
			if (ref === this.#ref && killed && (type === "status_changed" || type === "registered")) {
				this.#owner = "hostKill";
				this.#hostDone = Promise.withResolvers<void>();
				// Remove the tombstone while the native release still excludes cold revival.
				queueMicrotask(() => registry.unregister(ref.id, ref));
				try {
					options.onHostKill(identity);
				} finally {
					this.#quiesce(true);
				}
			} else if (this.#raw && ((type === "removed" && ref === this.#ref) || (type === "registered" && ref !== this.#ref))) {
				// Before attach, SDK's own failed initialization also emits "removed".
				this.#normalDisposal(type === "removed");
			}
		});
		options.signal.addEventListener("abort", this.#cancel, { once: true });
	}

	get id(): string {
		return this.#identity.agentId;
	}

	get registered(): boolean {
		return this.#ref !== undefined;
	}

	readonly #cancel = (): void => {
		// If the SDK has not registered yet, the observer above fences a late registration.
		if (this.#ref) void this.dispose().catch(() => {});
	};

	#ownsRef(): boolean {
		return this.#ref !== undefined && this.#registry.get(this.id) === this.#ref;
	}

	check(): void {
		this.#options.signal.throwIfAborted();
		if (this.#owner || !this.#ownsRef() || !this.#raw || this.#ref?.session !== this.#raw || this.#raw.isDisposed)
			throw new Error(`Agent "${this.id}" was stopped or replaced during session initialization.`);
	}

	attach(raw: AgentSession, events: WorkerBus): void {
		this.#raw = raw;
		this.check();
		const ref = this.#ref;
		if (!ref) throw new Error(`Agent "${this.id}" did not register.`);
		const bridge = this.#bridge = new HubBridge({
			id: ref.id, name: this.#options.name, role: this.#options.role,
			brief: this.#options.brief, sessionFile: raw.sessionFile, bus: events,
			ownsRef: () => this.#ownsRef(),
			activity: text => this.#registry.setActivity(ref.id, text, ref),
			model: () => {
				const model = raw.model;
				const identity = model ? `${model.provider}/${model.id}` : undefined;
				const effort = raw.thinkingLevel ?? undefined;
				const serving = raw.servingModel;
				if (serving?.isFallback) return {
					resolvedModel: serving.selector, resolvedModelIdentity: serving.modelIdentity,
					resolvedModelIsFallback: true,
					resolvedThinkingLevel: serving.thinkingLevel, contextWindow: serving.contextWindow ?? undefined,
				};
				return {
					resolvedModel: identity && effort ? `${identity}:${effort}` : identity,
					resolvedModelIdentity: identity, resolvedThinkingLevel: effort, contextWindow: model?.contextWindow ?? undefined,
				};
			},
			occupiedContext: usageContextTokens,
		});
		const sync = this.#registry.syncSessionStatus(ref.id, raw);
		const listen = raw.subscribe(ev => bridge.event(ev));
		const runState = (state: "running" | "idle"): void => {
			if (state === "running") bridge.start(raw.runStartedAt ?? Date.now());
			else bridge.idle();
		};
		const run = raw.subscribeRunState(runState);
		this.#unsubscribe = () => { sync(); listen(); run(); };
		// The SDK's core dispose is memoized, but its wrapper is not. Capture a
		// single completion before beginDispose fires, whoever called raw.dispose.
		const dispose = raw.dispose.bind(raw);
		raw.dispose = options => {
			if (this.#rawDisposal) return this.#rawDisposal;
			const done = Promise.withResolvers<void>();
			this.#rawDisposal = done.promise;
			void dispose(options).catch(async err => {
				// Fence the old transcript writer even on a failed native teardown.
				// The failure still cannot authorize destructive workspace cleanup.
				raw.sessionManager.seal();
				await Promise.allSettled([raw.sessionManager.close(), raw.abort().catch(() => {}).then(() => raw.waitForIdle())]);
				throw err;
			}).then(done.resolve, done.reject);
			return done.promise;
		};
		raw.addDisposer(() => this.#normalDisposal());
		const state = raw.runStartedAt === undefined ? "idle" : "running";
		this.#registry.setStatus(ref.id, state, ref);
		runState(state);
	}

	constructionDone(): void {
		if (this.#constructionDone) return;
		this.#constructionDone = true;
		this.#options.signal.removeEventListener("abort", this.#cancel);
		// A synchronous registry subscriber can stop the unattached ref before our
		// adoption callback is installed. SDK construction has now also unwound.
		if (this.#owner === "hostKill" && !this.#externalReleaseHook) void this.#released();
		if (this.#retired) reservedIds.delete(this.id.toLowerCase());
	}

	setBoardWait(waitId: string, waiting: boolean): void {
		if (!this.#owner) this.#bridge?.setBoardWait(waitId, waiting);
	}

	#quiesce(killed = false, removed = false): void {
		this.#unwatch();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#bridge?.close(killed, removed ? () => this.#registry.get(this.id) === undefined : undefined);
		this.#bridge = undefined;
	}

	#retire(): void {
		if (this.#retired) return;
		this.#retired = true;
		if (this.#ref && this.#ownsRef()) this.#registry.unregister(this.id, this.#ref);
		if (this.#constructionDone) reservedIds.delete(this.id.toLowerCase());
	}

	#normalDisposal(removed = false): void {
		if (this.#owner) return;
		this.#owner = "hostRemove";
		const main = this.#registry.get(MAIN_AGENT_ID)?.session;
		const rootClosing = main instanceof AgentSession && main.isDisposed && main.sessionManager.getSessionId() === this.#coordinatorId;
		const raw = this.#raw;
		// A standalone beginDispose or registry removal might not have called
		// dispose yet. Start it after the synchronous disposal fence returns.
		const closed = this.#hostClose = Promise.resolve().then(async () => {
			await raw?.dispose();
			await raw?.waitForIdle();
		});
		void closed.then(() => this.#retire(), () => this.#retire());
		try {
			this.#options.onHostDispose(this.#identity, rootClosing, closed);
		} finally {
			this.#quiesce(false, removed);
			if (this.#ref && this.#ownsRef()) this.#registry.unregister(this.id, this.#ref);
		}
	}

	async #released(): Promise<void> {
		if (this.#owner === "local" || this.#releaseNotified) return;
		this.#releaseNotified = true;
		if (this.#owner !== "hostKill") {
			this.#normalDisposal();
			return;
		}
		this.#retire();
		this.#hostDone?.resolve();
		// Runtime waits for creation outside this hook before probing idle.
		this.#options.onHostRelease(async () => {
			const raw = this.#raw;
			if (!raw) return;
			if (!raw.isDisposed) throw new Error(`Agent "${this.id}" did not dispose.`);
			await this.#rawDisposal;
			await raw.waitForIdle();
		});
	}

	dispose(kill = false): Promise<void> {
		if (this.#disposal) return this.#disposal;
		if (this.#hostDone) return this.#hostDone.promise.then(() => this.#raw?.waitForIdle());
		if (this.#hostClose) return this.#hostClose;
		this.#owner = "local";
		const settled = Promise.withResolvers<void>();
		this.#disposal = settled.promise;
		this.#quiesce(kill);
		const raw = this.#raw;
		const ref = this.#ref;
		const stop = async (): Promise<void> => {
			if (kill && raw) {
				// Do not keep the worker focusable while abort settles. Normally
				// abort completes before disposal (as in Hub and Tray), but a
				// stuck abort must not prevent disposal from starting.
				if (ref) this.#registry.unregister(this.id, ref);
				const abort = raw.abort().then(() => ({ ok: true as const }), err => ({ ok: false as const, err }));
				await raceTimeout(abort, TIMING.killStopMs / 2, undefined, { unref: true });
				await raw.dispose();
				const result = await abort;
				if (!result.ok) throw result.err;
			} else if (ref) {
				const release = this.#lifecycle.release(this.id, ref);
				this.#registry.unregister(this.id, ref);
				await release;
			}
			const session = this.#raw;
			if (session && !session.isDisposed) await session.dispose();
			await this.#rawDisposal;
			await session?.waitForIdle();
		};
		void stop().then(
			() => { this.#retire(); settled.resolve(); },
			err => { this.#retire(); settled.reject(err); },
		);
		return settled.promise;
	}
}

/** Host registration is identical in TUI, RPC, print and JSON. */
export function createSessionFactory(binding: CoordinatorBinding, events: WorkerBus, log: (line: string) => void): SessionFactory {
	return {
		async create(o: CreateWorkerOptions): Promise<WorkerSession> {
			o.signal.throwIfAborted();
			const coordinatorId = binding.sessionId;
			const rootFile = binding.sessionFile();
			const base = binding.settings;
			if (!base) throw new Error("the coordinator's settings are not captured yet");
			const scoped = sameRealPath(o.cwd, base.getCwd()) ? base : await base.cloneForCwd(o.cwd);
			const settings = createSubagentSettings(scoped, {
				...subagentLspWritethroughSettings(scoped),
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"eval.autoBackground.enabled": false,
			});
			mkdirSync(o.sessionsDir, { recursive: true, mode: 0o700 });
			// Hub and tree cost match lexical paths. The store uses realpath for
			// leases, so restore Main's spelling (e.g. /home vs /var/home) only
			// when it names this same physical sessions directory.
			const rooted = rootFile?.endsWith(".jsonl") ? join(rootFile.slice(0, -".jsonl".length), "swarm", "sessions") : undefined;
			const sessionsDir = rooted && rooted !== o.sessionsDir && sameRealPath(rooted, o.sessionsDir) ? rooted : o.sessionsDir;
			let sessionManager: SessionManager;
			if (o.mode.kind === "revive") {
				const file = dirname(o.mode.file) === o.sessionsDir ? join(sessionsDir, basename(o.mode.file)) : o.mode.file;
				sessionManager = await SessionManager.open(file, undefined, undefined, {
					throwIfMissing: true,
					initialCwd: o.cwd,
					suppressBreadcrumb: true,
				});
				if (sessionManager.getSessionId() !== o.mode.conversationId)
					throw new Error(`the transcript's conversation ${sessionManager.getSessionId()} does not match ${o.mode.conversationId}`);
				if (!sameRealPath(sessionManager.getCwd(), o.cwd))
					throw new Error(`the transcript's cwd ${sessionManager.getCwd()} does not match the workspace ${o.cwd}`);
			} else if (o.mode.kind === "fork") {
				sessionManager = await SessionManager.forkFrom(o.mode.sourceFile, o.cwd, sessionsDir, undefined, {
					repairInterruptedTail: true,
					resetInheritedCost: true,
					suppressBreadcrumb: true,
					copyArtifacts: false,
				});
			} else {
				// Like native Task, never replace Main's terminal breadcrumb. The
				// fresh persisted factory has no suppression option in omp 19.1;
				// persisting an empty manager retains the host's normal file naming.
				sessionManager = await SessionManager.inMemory(o.cwd).persistCopy({ sessionDir: sessionsDir, suppressBreadcrumb: true });
			}
			const model: Model | undefined = o.model ? binding.hostModel(o.model) : undefined;
			const registry = AgentRegistry.global();
			const lifecycle = AgentLifecycleManager.global();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error(`Agent "${o.name}" has no transcript path.`);
			const baseId = preferredAgentId(o.name);
			const preferredKey = o.agentId.toLowerCase();
			let attempt = 0;
			for (;;) {
				if (o.signal.aborted) {
					await sessionManager.close().catch(() => {});
					o.signal.throwIfAborted();
				}
				let id: string;
				let key: string;
				const occupied = new Set(registry.list().map(ref => ref.id.toLowerCase()));
				do {
					const preferred = attempt === 0;
					id = preferred ? o.agentId : attempt === 1 ? baseId : `${baseId}~${attempt}`;
					attempt++;
					key = id.toLowerCase();
					if (!preferred && key === preferredKey) continue;
					if (!occupied.has(key) && !reservedIds.has(key)) break;
				} while (true);
				reservedIds.add(key);
				const registration = new WorkerRegistration(registry, lifecycle, o, { agentId: id, sessionId: sessionManager.getSessionId(), sessionFile: file }, coordinatorId);
				let sdkReturned = false;
				try {
					let checkedSlot = false;
					const { session } = await createAgentSession({
						cwd: o.cwd,
						authStorage: binding.ctx.modelRegistry.authStorage,
						modelRegistry: binding.ctx.modelRegistry,
						settings,
						sessionManager,
						model,
						thinkingLevel: o.effort as ThinkingLevel | undefined,
						restrictToolNames: true,
						allowRestrictedCustomTools: true,
						toolNames: o.toolNames,
						customTools: o.customTools as CustomTool[],
						disableExtensionDiscovery: true,
						enableMCP: false,
						enableIrc: false,
						enableLsp: o.enableLsp,
						lspReadOnly: false,
						skipPythonPreflight: true,
						hasUI: false,
						parentTaskPrefix: id,
						agentId: id,
						agentDisplayName: o.name,
						get expectedAgentRef(): null {
							// In omp 19.1 the SDK first reads this option immediately
							// before its CAS. Reject late occupants here: its normal
							// null-CAS fallback may otherwise reclaim a parked ref.
							if (!checkedSlot) {
								o.signal.throwIfAborted();
								if (registry.list().some(ref => ref.id.toLowerCase() === key)) throw new RegistryIdOccupied(id);
								checkedSlot = true;
							}
							return null;
						},
						subagentEventBus: events,
						disableModelFallback: true,
						disableServerSideFallback: true,
						cacheWarming: "off",
						appendSystemPrompt: o.appendSystemPrompt,
					});
					sdkReturned = true;
					registration.attach(session, events);
					await initializeExtensions(session, {
						mode: "print",
						reportSendError: (_action, err) => log(`omp-agy-swarm: ${o.name}: send failed: ${err.message}`),
						reportRuntimeError: err => log(`omp-agy-swarm: ${o.name}: extension error: ${err.error}`),
					});
					registration.check();
					const active = new Set(session.getActiveToolNames());
					for (const name of o.toolNames) {
						if (!active.has(name) && !loggedMissing.has(name)) {
							loggedMissing.add(name);
							log(`omp-agy-swarm: tool ${name} is not available to workers in this host; dropped`);
						}
					}
					return new HostWorkerSession(session, binding, registration);
				} catch (err) {
					const collision = !registration.registered && (err instanceof RegistryIdOccupied
						|| (err instanceof Error && err.message === `Agent "${id}" is already owned by another session generation.`));
					// A pre-attach native kill can finish only after construction unwinds.
					// Local cancellation instead drains the raw session before settling launch.
					const disposal = registration.dispose();
					registration.constructionDone();
					const stopped = await raceTimeout(disposal.then(() => true, () => false), TIMING.killStopMs, false, { unref: true });
					if (!stopped) throw new WorkerStartupUnstopped(err, disposal);
					if (!collision) {
						if (!sdkReturned) await sessionManager.close().catch(() => {});
						throw err;
					}
				} finally {
					registration.constructionDone();
				}
			}
		},
	};
}
