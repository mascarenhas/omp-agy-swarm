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
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager, type AgentLifecycleApi } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { CostGate, type CostCapRefusal } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TASK_SUBAGENT_EVENT_CHANNEL, type SubagentEventPayload } from "@oh-my-pi/pi-coding-agent/task/types";
import { cfgAsyncMaxJobs, cfgAsyncPrintWake } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { RemoteAgentSession } from "@oh-my-pi/pi-coding-agent/thread/remote-agent-session";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { SubagentLifecyclePayload } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { raceTimeout, TIMING } from "../env.ts";
import { HubBridge } from "./hub-bridge.ts";
import { preferredAgentId } from "./member.ts";
import type { CoordinatorBinding } from "./coordinator.ts";
import { WorkerStartupUnstopped } from "./ports.ts";
import { leasePrintWake } from "./print-wake.ts";
import type {
	CreateWorkerOptions,
	CustomWakeMessage,
	HostMessage,
	ModelInfo,
	SessionFactory,
	RequestBill,
	ThinkingCaps,
	TranscriptEntry,
	WakeSources,
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
	get isRunActive(): boolean {
		return this.#s.isRunActive;
	}
	get wakeSources(): WakeSources | undefined {
		return this.#s.wakeSources;
	}
	get hasBackgroundWork(): boolean {
		return !!this.#s.wakeSources || this.#host.hasOwnerWork();
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

type BillSink = (bill: RequestBill) => void;
type Owner = { ref: AgentRef; bill: BillSink; children: Set<AgentRef>; costGate?: AgentSession["costGate"] };

// The compiled host does not expose a runtime import for the mirror class.
export function isRemoteScoutSession(session: AgentRef["session"] | undefined): session is RemoteAgentSession {
	return !!session && "home" in session && typeof session.home === "string"
		&& "applyEntries" in session && typeof session.applyEntries === "function"
		&& "close" in session && typeof session.close === "function";
}

/** Use the host's request guard, including retries and auxiliary calls, in every worker tree. */
class SwarmWorkerCostGate extends CostGate {
	constructor(settings: Settings, initialSpend: number, readonly swarmCheck: () => CostCapRefusal | undefined, warn: (message: string) => void) {
		super(settings, initialSpend, warn);
	}

	override get capped(): boolean {
		return true;
	}

	override check(): CostCapRefusal | undefined {
		return this.swarmCheck() ?? super.check();
	}
}

const WORKER_SCOUT_HOOK = "<inline-0>";

/** Keep durable entry identities across native park/reopen and mirror replacements. */
class ScoutJournal {
	constructor(readonly seen: Set<string>, readonly since: number, readonly bill: BillSink, readonly log: (line: string) => void) {}

	record(id: string, entry: RequestBill): void {
		if (this.seen.has(id)) return;
		this.seen.add(id);
		reportBill(this.bill, this.log, entry);
	}

	scan(entries: readonly SessionEntry[]): void {
		for (const entry of entries) {
			// A discarded assistant is already billed from its raw message_end.
			if (entry.type !== "model_usage" || entry.purpose === "discarded-turn" || this.seen.has(entry.id)) continue;
			if (Date.parse(entry.timestamp) >= this.since) this.record(entry.id, entry);
		}
	}
}

function reportBill(bill: BillSink, log: (line: string) => void, entry: RequestBill): void {
	try { bill(entry); } catch (error) { log(`omp-agy-swarm: model usage accounting failed: ${String(error)}`); }
}

/** Stateless eval and other auxiliary calls are journaled, not assistant events. */
function observeAuxiliaryUsage(
	manager: SessionManager, bill: BillSink, log: (line: string) => void,
	journal?: ScoutJournal,
): () => void {
	const append = manager.appendModelUsage;
	const wrapped: typeof append = function (usage, owner) {
		const entryId = append.call(manager, usage, owner);
		if (entryId !== undefined) {
			if (journal) journal.record(entryId, usage);
			else reportBill(bill, log, usage);
		}
		return entryId;
	};
	manager.appendModelUsage = wrapped;
	// Auto-prewalk can journal before the first started frame.
	if (journal) journal.scan(manager.getEntriesView());
	return () => { if (manager.appendModelUsage === wrapped) manager.appendModelUsage = append; };
}

/** One observer per swarm. Registry refs, not the spelling of ids, establish ownership. */
class ScoutUsage {
	readonly #registry = AgentRegistry.global();
	readonly #roots = new Map<string, Owner>();
	readonly #paths = new WeakMap<AgentRef, Owner>();
	/** Host 19.1 publishes the same request object synchronously on the native bus. */
	readonly #sources = new WeakMap<object, AgentRef>();
	readonly #requests = new WeakSet<object>();
	readonly #aux = new Map<AgentRef, () => void>();
	readonly #journalEntries = new Map<string, Set<string>>();
	readonly #scoutHomes = new WeakMap<AgentRef, RemoteAgentSession["home"]>();
	readonly #retiring = new Map<string, AgentRef>();
	readonly #off: (() => void)[];
	#main: Owner | undefined;
	#mainSid: string | undefined;

	constructor(bus: WorkerBus, readonly log: (line: string) => void) {
		this.#off = [
			this.#registry.onChange(({ type, ref }) => {
				if (type === "registered") {
					this.#retiring.delete(ref.id);
					this.#own(ref);
					if (ref.status === "parked" || ref.status === "aborted") this.#fenceColdRevival(ref);
				} else if (type === "status_changed") this.#fenceColdRevival(ref);
				else if (type === "removed") {
					this.#paths.get(ref)?.children.delete(ref);
					// A worker unregisters before draining jobs; keep its journal hook
					// through disposal rather than unhooking on loss of visibility.
					if (this.#roots.get(ref.id)?.ref !== ref && !this.#scoutHomes.has(ref)) {
						this.#aux.get(ref)?.();
						this.#aux.delete(ref);
					}
				}
			}),
			bus.on("task:subagent:lifecycle", data => {
				const frame = data as SubagentLifecyclePayload;
				if (frame.status !== "started") {
					this.#retiring.delete(frame.id);
					return;
				}
				const ref = this.#registry.get(frame.id);
				if (!ref || (frame.sessionFile && frame.sessionFile !== ref.sessionFile)) return;
				let owner = this.#own(ref);
				if (!owner && frame.agent === "scout" && this.#main && ref.parentId === this.#main.ref.id
					&& this.#registry.get(ref.parentId) === this.#main.ref
					&& this.#main.ref.session instanceof AgentSession
					&& this.#main.ref.session.sessionManager.getSessionId() === this.#mainSid) {
					owner = this.#main;
					this.#paths.set(ref, owner);
				}
				if (!owner || this.#aux.has(ref)) return;
				const session = ref.session;
				if (!(session instanceof AgentSession) && !isRemoteScoutSession(session)) return;
				this.#scoutHomes.set(ref, session instanceof AgentSession ? "main" : session.home);
				const transcript = session.sessionManager.getSessionId();
				let seen = this.#journalEntries.get(transcript);
				if (!seen) this.#journalEntries.set(transcript, seen = new Set());
				const journal = new ScoutJournal(seen, ref.createdAt, owner.bill, this.log);
				if (!(session instanceof AgentSession)) {
					// The bridge mirrors entries only under a watch. Usage-only deltas
					// don't emit a session event, so account at the delta itself.
					const apply = session.applyEntries;
					const close = session.close;
					const onEntries: typeof apply = delta => {
						apply.call(session, delta);
						if (!session.closed) journal.scan(delta.entries);
					};
					const onClose: typeof close = reason => {
						close.call(session, reason);
						off();
						if (this.#aux.get(ref) === off) this.#aux.delete(ref);
					};
					session.applyEntries = onEntries;
					session.close = onClose;
					// Establish a watch; the usage entries arrive independently.
					const off = () => {
						if (session.applyEntries === onEntries) session.applyEntries = apply;
						if (session.close === onClose) session.close = close;
						unwatch();
					};
					const unwatch = session.subscribe(() => {});
					this.#aux.set(ref, off);
					journal.scan(session.sessionManager.getEntries());
					return;
				}
				const offUsage = observeAuxiliaryUsage(session.sessionManager, owner.bill, this.log, journal);
				// The native monitor attaches after its started frame. Pin the
				// emitter's actual generation before the coordinator sees its bill.
				const offSource = session.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "assistant")
						this.#sources.set(event.message, ref);
				});
				const off = () => { offUsage(); offSource(); };
				this.#aux.set(ref, off);
				session.addDisposer(() => {
					off();
					if (this.#aux.get(ref) === off) this.#aux.delete(ref);
				});
			}),
			bus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				const frame = data as SubagentEventPayload;
				const event = frame.event;
				if (event?.type !== "message_end" || event.message.role !== "assistant" || !event.message.usage) return;
				if (this.#requests.has(event.message)) return;
				const ref = this.#sources.get(event.message) ?? this.#registry.get(frame.id) ?? this.#retiring.get(frame.id);
				if (!ref || ref.id !== frame.id || event.message.timestamp < ref.createdAt) return;
				const owner = this.#own(ref);
				if (!owner) return;
				this.#requests.add(event.message);
				reportBill(owner.bill, this.log, event.message);
			}),
		];
	}

	#fenceColdRevival(ref: AgentRef): void {
		const owner = this.#paths.get(ref);
		if (!owner || owner === this.#main) return;
		const session = ref.session;
		const home = this.#scoutHomes.get(ref);
		if (!session && (ref.status === "aborted" || (ref.status === "parked" && home === undefined))) {
			// An aborted ref or a scout parked before its home was observed has
			// no known warm reviver. Native cold revival would use Main's gate.
			if (home !== undefined) this.#retiring.set(ref.id, ref);
			this.#registry.unregister(ref.id, ref);
		} else if (ref.status === "running" && session && owner.costGate) {
			// Warm revival retains the worker's gate and the original home.
			// After a thread loss the host can cold-revive the same parked ref;
			// SDK publishes this attachment before ensureLive returns a handle.
			const wrongGate = session instanceof AgentSession && session.costGate !== owner.costGate;
			const wrongHome = isRemoteScoutSession(session) && home !== undefined && session.home !== home;
			if (wrongGate || wrongHome) this.#registry.unregister(ref.id, ref);
		}
	}

	#own(ref: AgentRef): Owner | undefined {
		const prior = this.#paths.get(ref);
		if (prior || !ref.parentId) return prior;
		let id: string | undefined = ref.parentId;
		let parent: AgentRef | undefined;
		const visited = new Set([ref.id]);
		while (id !== undefined && !visited.has(id)) {
			visited.add(id);
			parent = this.#registry.get(id);
			const root = this.#roots.get(id);
			// The worker reserves its id until disposal/reaping completes. A
			// late child can register after we unpublish that exact root.
			const owner = root && (!parent || parent === root.ref) ? root : parent && this.#paths.get(parent);
			if (owner) {
				this.#paths.set(ref, owner);
				if (owner !== this.#main) owner.children.add(ref);
				return owner;
			}
			id = parent?.parentId;
		}
		return undefined;
	}

	coordinator(sid: string, bill: BillSink): void {
		const ref = this.#registry.get(MAIN_AGENT_ID);
		if (!(ref?.session instanceof AgentSession) || ref.session.sessionManager.getSessionId() !== sid) {
			this.log("omp-agy-swarm: Main usage observer could not bind to the coordinator's native session");
			return;
		}
		this.#mainSid = sid;
		this.#main = { ref, bill, children: new Set() };
		const manager = ref.session.sessionManager;
		this.#off.push(observeAuxiliaryUsage(manager, usage => {
			if (manager.getSessionId() === sid) bill(usage);
		}, this.log));
	}

	worker(ref: AgentRef, raw: AgentSession, bill: BillSink): Owner {
		const owner: Owner = { ref, bill, children: new Set(), costGate: raw.costGate };
		this.#roots.set(ref.id, owner);
		const offUsage = observeAuxiliaryUsage(raw.sessionManager, bill, this.log);
		const offDirect = raw.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") reportBill(bill, this.log, event.message);
		});
		this.#aux.set(ref, () => { offUsage(); offDirect(); });
		return owner;
	}

	async release(owner: Owner, lifecycle: AgentLifecycleApi, jobs: AsyncJobManager | undefined, tombstone: boolean): Promise<void> {
		const deadlineAt = Date.now() + TIMING.killStopMs;
		try {
			let failed: PromiseRejectedResult | undefined;
			while (owner.children.size) {
				const children = [...owner.children];
				owner.children.clear();
				const stopped = await Promise.allSettled(children.map(async child => {
					if (this.#registry.get(child.id) !== child) return;
					const session = child.session;
					try {
						jobs?.cancelAll({ ownerId: child.id });
						await lifecycle.release(child.id, child, { tombstone });
						if (session instanceof AgentSession) {
							await session.waitForIdle();
							if (!session.isDisposed) throw new Error(`Scout "${child.id}" did not dispose.`);
						}
						const current = this.#registry.get(child.id);
						if (jobs && (!current || current === child)) {
							const { completion } = await jobs.cancelAndReapOwnerJobs(child.id, deadlineAt);
							await completion;
						}
					} finally {
						this.#registry.unregister(child.id, child);
					}
				}));
				failed ??= stopped.find(r => r.status === "rejected");
			}
			if (failed) throw failed.reason;
		} finally {
			if (this.#roots.get(owner.ref.id) === owner) this.#roots.delete(owner.ref.id);
			this.#aux.get(owner.ref)?.();
			this.#aux.delete(owner.ref);
		}
	}

	close(): void {
		for (const off of this.#off) off();
		for (const off of this.#aux.values()) off();
		this.#aux.clear();
		this.#journalEntries.clear();
		this.#retiring.clear();
		this.#roots.clear();
		this.#main = undefined;
	}
}

/** Do not re-prompt Main from a terminal hook while the root is disposing or aborting. */
export function mainCanResume(sid: string): boolean {
	const main = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
	return main instanceof AgentSession && main.sessionManager.getSessionId() === sid && !main.isDisposed && !main.isAborting;
}
// Cover the async gap before the SDK CAS, and keep a stopped id unavailable until
// release completes (Tray's native stop path does not pass an exact ref).
const reservedIds = new Set<string>();

class RegistryIdOccupied extends Error {}

class WorkerRegistration {
	readonly #registry: AgentRegistryApi;
	readonly #lifecycle: AgentLifecycleApi;
	readonly #jobs: AsyncJobManager | undefined;
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
	#usageOwner: Owner | undefined;
	#localKill = false;

	constructor(registry: AgentRegistryApi, lifecycle: AgentLifecycleApi, options: CreateWorkerOptions, identity: WorkerIdentity, coordinatorId: string, jobs: AsyncJobManager | undefined) {
		this.#registry = registry;
		this.#lifecycle = lifecycle;
		this.#jobs = jobs;
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
					this.#jobs?.cancelAll({ ownerId: ref.id });
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

	attach(raw: AgentSession, events: WorkerBus, usage: ScoutUsage | undefined): void {
		this.#raw = raw;
		this.check();
		const ref = this.#ref;
		if (!ref) throw new Error(`Agent "${this.id}" did not register.`);
		const bill = this.#options.onOwnedUsage;
		if (bill) this.#usageOwner = usage?.worker(ref, raw, bill);
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
			this.#jobs?.cancelAll({ ownerId: ref.id });
			void dispose(options).catch(async err => {
				// Fence the old transcript writer even on a failed native teardown.
				// The failure still cannot authorize destructive workspace cleanup.
				raw.sessionManager.seal();
				await Promise.allSettled([raw.sessionManager.close(), raw.abort().catch(() => {}).then(() => raw.waitForIdle())]);
				throw err;
			}).finally(async () => {
				// Dispose fences new admission and drains tool handlers. Re-scan
				// owner jobs afterwards; cancellation alone does not reap them.
				if (this.#jobs) {
					const { completion } = await this.#jobs.cancelAndReapOwnerJobs(ref.id, Date.now() + TIMING.killStopMs);
					await completion;
				}
				if (this.#usageOwner) await usage?.release(this.#usageOwner, this.#lifecycle, this.#jobs, this.#localKill || this.#owner === "hostKill");
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

	hasOwnerWork(): boolean {
		if (!this.#jobs) return false;
		const filter = { ownerId: this.id };
		return this.#jobs.getRunningJobs(filter).length > 0 || this.#jobs.hasPendingDeliveries(filter);
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
		this.#localKill = kill;
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
				this.#jobs?.cancelAll({ ownerId: this.id });
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
	let manager: AsyncJobManager | undefined;
	let usage: ScoutUsage | undefined;
	const sid = binding.sessionId;
	let factoryDisposal: Promise<void> | undefined;
	let leasedSettings: Settings | undefined;
	let releasePrintWake: (() => void) | undefined;
	return {
		setPrintWake(active) {
			const settings = active && binding.headless ? binding.settings : undefined;
			if (leasedSettings === settings) return;
			releasePrintWake?.();
			leasedSettings = settings;
			releasePrintWake = settings ? leasePrintWake(settings, cfgAsyncPrintWake) : undefined;
		},
		observeCoordinatorUsage(onUsage) {
			(usage ??= new ScoutUsage(events, log)).coordinator(sid, onUsage);
		},
		dispose(deadlineAt) {
			if (!factoryDisposal) {
				releasePrintWake?.();
				releasePrintWake = undefined;
				leasedSettings = undefined;
				factoryDisposal = (manager?.dispose({ timeoutMs: Math.max(0, deadlineAt - Date.now()) }) ?? Promise.resolve())
					.then(() => {}).finally(() => usage?.close());
			}
			return factoryDisposal;
		},
		async create(o: CreateWorkerOptions): Promise<WorkerSession> {
			o.signal.throwIfAborted();
			const coordinatorId = binding.sessionId;
			const rootFile = binding.sessionFile();
			const base = binding.settings;
			if (!base) throw new Error("the coordinator's settings are not captured yet");
			const jobs = o.role === "worker"
				? (manager ??= new AsyncJobManager({ maxRunningJobs: () => Math.min(100, cfgAsyncMaxJobs.get(base)) }))
				: undefined;
			const scoped = sameRealPath(o.cwd, base.getCwd()) ? base : await base.cloneForCwd(o.cwd);
			const settings = createSubagentSettings(scoped, {
				...subagentLspWritethroughSettings(scoped),
				// Remote journals can arrive after another request in the same eval cell.
				// Keep capped worker trees on the billing thread without changing concurrency.
				...(jobs && o.checkSwarmSpend ? { "task.workerThreads": 0 } : {}),
				...(jobs ? { "async.enabled": true } : {
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"eval.autoBackground.enabled": false,
				}),
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
				const registration = new WorkerRegistration(registry, lifecycle, o, { agentId: id, sessionId: sessionManager.getSessionId(), sessionFile: file }, coordinatorId, jobs);
				let sdkReturned = false;
				try {
					let checkedSlot = false;
					const requestedScout = o.role === "worker" && o.toolNames.includes("task");
					const override = requestedScout ? o.scoutOverride : undefined;
					let scoutToolActive = requestedScout;
					let sessionForWarning: AgentSession | undefined;
					const costGate = o.checkSwarmSpend
						? new SwarmWorkerCostGate(settings, sessionManager.getUsageStatistics().cost, o.checkSwarmSpend,
							message => sessionForWarning?.emitNotice("warning", message, "cost-gate"))
						: undefined;
					if (override?.model) {
						const native = cfgTaskAgentModelOverrides.get(scoped);
						const scout = override.effort ? `${override.model}:${override.effort}` : override.model;
						cfgTaskAgentModelOverrides.override(settings, { ...native, scout });
					}
					const effort = override?.model ? undefined : override?.effort;
					const { session } = await createAgentSession({
						cwd: o.cwd,
						authStorage: binding.ctx.modelRegistry.authStorage,
						modelRegistry: binding.ctx.modelRegistry,
						settings,
						asyncJobManager: jobs,
						sessionManager,
						costGate,
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
						// The eval agent/workpool bridges consult this policy even
						// when the native task tool is absent.
						get spawns(): string {
							return scoutToolActive && !o.checkSwarmSpend?.() ? "scout" : "";
						},
						preloadedPreparedExtensions: effort ? [{
							path: WORKER_SCOUT_HOOK, resolvedPath: WORKER_SCOUT_HOOK, error: null,
							factory: pi => pi.on("before_subagent_spawn", (event, ctx) => {
								if (ctx.agent.id !== id || event.agent !== "scout" || !event.patterns.length) return;
								// The core hook leaves modelRole intact. Using its live
								// patterns preserves aliases and the current parent model.
								let models: Model[] | undefined;
								return { model: event.patterns.map(pattern => {
									const split = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
									const literal = split.level && (models ??= ctx.models.list()).some(m => m.id === pattern || `${m.provider}/${m.id}` === pattern);
									const base = literal ? pattern : split.base;
									return `${base}:${effort}`;
								}) };
							}),
						}] : undefined,
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
					sessionForWarning = session;
					scoutToolActive &&= session.getActiveToolNames().includes("task");
					if (o.onOwnedUsage && !usage) usage = new ScoutUsage(events, log);
					registration.attach(session, events, usage);
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
