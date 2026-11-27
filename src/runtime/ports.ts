// Test seams between the runtime and the host (§2 rule 2). The real implementations live in
// omp-adapter.ts (worker sessions, thinking caps) and coordinator.ts (the main binding); the
// integration tests supply scripted ones.

import type { ScoutOverride } from "../board/types.ts";

/** A host model, identified by `provider/id`. The runtime never relies on object identity. */
export interface ModelInfo {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number | null;
}

export function modelKey(m: ModelInfo | undefined | null): string {
	return m ? `${m.provider}/${m.id}` : "";
}

export interface ThinkingCaps {
	/** `getSupportedEfforts(model)`; `[]` for non-reasoning models. */
	supportedEfforts(model: ModelInfo): string[];
	/** `clampThinkingLevelForModel(model, effort)`; undefined for non-reasoning models. */
	clamp(model: ModelInfo, effort: string): string | undefined;
}

/** Content blocks and messages as the host emits them (only the fields the runtime reads). */
export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

export interface HostMessage {
	role: string;
	content?: string | ContentBlock[];
	customType?: string;
	details?: unknown;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	provider?: string;
	model?: string;
	usage?: RequestUsage;
	timestamp?: number;
}

/** Direct bill for one model request (not the total inherited from a tool result). */
export interface RequestUsage {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface RequestBill {
	readonly provider?: string;
	readonly model?: string;
	readonly usage: RequestUsage;
}

/** Who made a billed request: the member itself, or one of its native scouts. */
export type UsageKind = "own" | "scout";

export interface SpendRefusal {
	readonly spent: number;
	readonly cap: number;
	readonly message: string;
}

/** Worker session events the runtime consumes (a subset of the host's AgentSessionEvent). */
export type WorkerEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "agent_pause"; yielded: boolean; awaiting: boolean }
	| { type: "turn_end" }
	| { type: "message_start"; message: HostMessage }
	| { type: "message_end"; message: HostMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; isError?: boolean; result?: unknown }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "auto_compaction_end";
			result: unknown;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			skipped?: boolean;
	  }
	| { type: "model_changed" }
	| { type: "thinking_level_changed"; thinkingLevel?: string }
	| { type: "retry_fallback_applied"; from: string; to: string }
	| { type: "notice"; level: string; message: string }
	| { type: string };

export interface CustomWakeMessage {
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
}

export interface ImageAttachment {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/** A transcript entry (current branch) as 19.0.1 writes it (session-entries.ts); the fields the UI reads. */
export interface TranscriptEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp?: string;
	/** Set on an entry written off the active branch: the leaf to restore on replay (null: cleared). */
	activeLeafId?: string | null;
	message?: HostMessage;
	customType?: string;
	content?: unknown;
	summary?: string;
	/** model_change: "provider/modelId". */
	model?: string;
	/** Older model_change shape (still read for old transcripts). */
	provider?: string;
	modelId?: string;
	thinkingLevel?: string | null;
}

export interface WakeSources {
	readonly jobs: readonly string[];
	readonly agents: readonly string[];
	readonly queued: boolean;
}

export interface WorkerSession {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly model: ModelInfo | undefined;
	readonly thinkingLevel: string | undefined;
	readonly isStreaming: boolean;
	/** User steering messages queued on the host session awaiting delivery. */
	readonly hasPendingSteering: boolean;
	readonly isRunActive: boolean;
	readonly wakeSources: WakeSources | undefined;
	/** Also includes owned jobs whose result will not wake the session. */
	readonly hasBackgroundWork: boolean;
	/** The latest model request the host's cost gate refused (a new object per refusal). */
	readonly costCapRefusal: { readonly message: string } | undefined;
	prompt(text: string): Promise<unknown>;
	steer(text: string, images?: readonly ImageAttachment[], onAdmitted?: () => void): Promise<boolean>;
	sendCustomMessage(message: CustomWakeMessage, options: { deliverAs: "aside" }): Promise<boolean>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	setModelTemporary(model: ModelInfo, effort?: string): Promise<void>;
	setThinkingLevel(effort: string | undefined): void;
	subscribe(listener: (event: WorkerEvent) => void): () => void;
	getLastAssistantMessage(): HostMessage | undefined;
	/** Current-branch entries (live transcript source). */
	branchEntries(): readonly TranscriptEntry[];
	setBoardWait(waitId: string, waiting: boolean): void;
	/** Explicit swarm kill. Other disposal paths leave the member revivable. */
	stop(): Promise<void>;
	dispose(): Promise<void>;
}

export type SessionMode =
	| { kind: "new" }
	| { kind: "revive"; file: string; conversationId: string }
	| { kind: "fork"; sourceFile: string };

export interface WorkerIdentity {
	agentId: string;
	sessionId: string;
	sessionFile: string | undefined;
}

/** Startup failed and its raw session has not confirmed that it stopped. */
export class WorkerStartupUnstopped extends Error {
	constructor(cause: unknown, readonly disposal: Promise<void>) {
		super(`session startup failed without confirming disposal: ${String(cause)}`, { cause });
	}
}

export interface CreateWorkerOptions {
	name: string;
	role: "worker" | "narrator" | "monitor";
	agentId: string;
	brief: string;
	signal: AbortSignal;
	/** Synchronous fence from the owned, detached registry tombstone. */
	onHostKill(identity: WorkerIdentity): void;
	/** Disposal started without a tombstone. The barrier tracks the actual raw session teardown. */
	onHostDispose(identity: WorkerIdentity, rootClosing: boolean, closed: Promise<void>): void;
	/** Delivered after a native tombstone release, without waiting on worker construction. */
	onHostRelease(confirmIdle: () => Promise<void>): void;
	cwd: string;
	sessionsDir: string;
	model: ModelInfo | undefined;
	effort: string | undefined;
	scoutOverride?: ScoutOverride;
	/** A shared, live limit, checked at native spawn and provider dispatch. */
	checkSwarmSpend?: () => SpendRefusal | undefined;
	/** Applies to this owned generation even while its turn or owner is being torn down. */
	onOwnedUsage?(bill: RequestBill, kind?: UsageKind): void;
	toolNames: string[];
	customTools: unknown[];
	appendSystemPrompt: string;
	mode: SessionMode;
	enableLsp: boolean;
}

export interface SessionFactory {
	create(options: CreateWorkerOptions): Promise<WorkerSession>;
	setPrintWake(active: boolean): void;
	observeCoordinatorUsage?(onUsage: (bill: RequestBill, kind?: UsageKind) => void): void;
	dispose(deadlineAt: number): Promise<void>;
}

export interface UsageLimitView {
	label: string;
	scope?: { modelId?: string; tier?: string };
	window?: { resetsAt?: number; label?: string };
	amount?: { remainingFraction?: number; usedFraction?: number };
	status?: string;
}

export interface UsageSource {
	reports(signal: AbortSignal): Promise<{ provider: string; limits: UsageLimitView[] }[]>;
}

/** A model switch scheduled for a run boundary (a worker's own, or the coordinator's). */
export interface PendingSwitch {
	model: string;
	effort: string | undefined;
}

/** The main-session binding (refreshed on every main event and tool call). */
export interface CoordinatorPort {
	readonly sessionId: string;
	readonly mode: "tui" | "rpc" | "print" | "json";
	readonly headless: boolean;
	readonly cwd: string;
	/**
	 * The coordinator's own model switch requested before any swarm exists (no runtime holds it):
	 * applied at the main run's boundary, or handed to the runtime when one is created.
	 */
	pendingSelfSwitch: PendingSwitch | undefined;
	sessionFile(): string | undefined;
	artifactsDir(): string | null;
	model(): ModelInfo | undefined;
	thinkingLevel(): string | undefined;
	models(): ModelInfo[];
	resolveModel(spec: string): ModelInfo | undefined;
	hasAuth(model: ModelInfo): boolean;
	setModel(model: ModelInfo): Promise<boolean>;
	setThinkingLevel(effort: string): void;
	isStreaming(): boolean;
	sendWake(message: CustomWakeMessage): void;
	activeTools(): string[];
	branchEntries(): readonly TranscriptEntry[];
	notify(text: string, level: "info" | "warning" | "error"): void;
	usage(): UsageSource | undefined;
}
