// The ONLY module with value imports from @oh-my-pi/pi-coding-agent and @oh-my-pi/pi-catalog.
// Every import is static: the compiled omp binary resolves @oh-my-pi/* only through static
// imports (H1). Workers are restricted sessions (H5, H6) registered in a private AgentRegistry
// per swarm with expectedAgentRef null (H7).

import { mkdirSync, realpathSync } from "node:fs";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	type AgentSession,
	AgentRegistry,
	createAgentSession,
	createSubagentSettings,
	type CustomTool,
	SessionManager,
	type Settings,
	subagentLspWritethroughSettings,
	VERSION,
} from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CoordinatorBinding } from "./coordinator.ts";
import type {
	CreateWorkerOptions,
	CustomWakeMessage,
	HostMessage,
	ModelInfo,
	SessionFactory,
	ThinkingCaps,
	TranscriptEntry,
	WorkerEvent,
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

	constructor(session: AgentSession, binding: CoordinatorBinding) {
		this.#s = session;
		this.#binding = binding;
	}

	get sessionId(): string {
		return this.#s.sessionId;
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
	beginDispose(): void {
		this.#s.beginDispose();
	}
	dispose(): Promise<void> {
		return this.#s.dispose();
	}
}

const loggedMissing = new Set<string>();

/** A SessionFactory with its own private AgentRegistry (one per swarm). */
export function createSessionFactory(binding: CoordinatorBinding, log: (line: string) => void): SessionFactory {
	const registry = new AgentRegistry();
	return {
		async create(o: CreateWorkerOptions): Promise<WorkerSession> {
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
			let sessionManager: SessionManager;
			if (o.mode.kind === "revive") {
				sessionManager = await SessionManager.open(o.mode.file, undefined, undefined, {
					throwIfMissing: true,
					initialCwd: o.cwd,
					suppressBreadcrumb: true,
				});
				if (sessionManager.getSessionId() !== o.mode.conversationId)
					throw new Error(`the transcript's conversation ${sessionManager.getSessionId()} does not match ${o.mode.conversationId}`);
				if (!sameRealPath(sessionManager.getCwd(), o.cwd))
					throw new Error(`the transcript's cwd ${sessionManager.getCwd()} does not match the workspace ${o.cwd}`);
			} else if (o.mode.kind === "fork") {
				sessionManager = await SessionManager.forkFrom(o.mode.sourceFile, o.cwd, o.sessionsDir, undefined, {
					repairInterruptedTail: true,
					resetInheritedCost: true,
					suppressBreadcrumb: true,
					copyArtifacts: false,
				});
			} else sessionManager = SessionManager.create(o.cwd, o.sessionsDir);
			const model: Model | undefined = o.model ? binding.hostModel(o.model) : undefined;
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
				parentTaskPrefix: o.agentId,
				agentId: o.agentId,
				agentDisplayName: o.name,
				agentRegistry: registry,
				expectedAgentRef: null,
				disableModelFallback: true,
				disableServerSideFallback: true,
				cacheWarming: "off",
				appendSystemPrompt: o.appendSystemPrompt,
			});
			await initializeExtensions(session, {
				mode: "print",
				reportSendError: (_action, err) => log(`omp-agy-swarm: ${o.name}: send failed: ${err.message}`),
				reportRuntimeError: err => log(`omp-agy-swarm: ${o.name}: extension error: ${err.error}`),
			});
			const active = new Set(session.getActiveToolNames());
			for (const name of o.toolNames) {
				if (!active.has(name) && !loggedMissing.has(name)) {
					loggedMissing.add(name);
					log(`omp-agy-swarm: tool ${name} is not available to workers in this host; dropped`);
				}
			}
			return new HostWorkerSession(session, binding);
		},
	};
}
