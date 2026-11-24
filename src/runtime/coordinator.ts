// The main-session binding: pi, the latest ctx, mode and the session's Settings, refreshed on
// every main event and tool call (§3.6). Type-only host imports.

import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import type { CoordinatorPort, CustomWakeMessage, ModelInfo, PendingSwitch, TranscriptEntry, UsageSource } from "./ports.ts";

export class CoordinatorBinding implements CoordinatorPort {
	readonly pi: ExtensionAPI;
	#ctx: ExtensionContext;
	/** Captured inside the main session's handlers and tool calls (never looked up ambiently). */
	settings: Settings | undefined;
	/** The coordinator's self switch requested before a swarm exists (see CoordinatorPort). */
	pendingSelfSwitch: PendingSwitch | undefined;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, settings: Settings | undefined) {
		this.pi = pi;
		this.#ctx = ctx;
		this.settings = settings;
	}

	update(ctx: ExtensionContext, settings: Settings | undefined): void {
		this.#ctx = ctx;
		if (settings) this.settings = settings;
	}

	get ctx(): ExtensionContext {
		return this.#ctx;
	}

	get sessionId(): string {
		return this.#ctx.sessionManager.getSessionId();
	}

	get mode(): "tui" | "rpc" | "print" | "json" {
		return this.#ctx.mode;
	}

	get headless(): boolean {
		return this.#ctx.mode === "print" || this.#ctx.mode === "json";
	}

	get cwd(): string {
		return this.#ctx.cwd;
	}

	sessionFile(): string | undefined {
		return this.#ctx.sessionManager.getSessionFile();
	}

	artifactsDir(): string | null {
		try {
			return this.#ctx.sessionManager.getSessionFile() ? this.#ctx.sessionManager.getArtifactsDir() : null;
		} catch {
			return null;
		}
	}

	model(): ModelInfo | undefined {
		return this.#ctx.model;
	}

	thinkingLevel(): string | undefined {
		return this.pi.getThinkingLevel() ?? undefined;
	}

	models(): ModelInfo[] {
		return this.#ctx.models.list();
	}

	resolveModel(spec: string): ModelInfo | undefined {
		return this.#ctx.models.resolve(spec);
	}

	/** The host Model object for a model the runtime resolved from `models()`. */
	hostModel(m: ModelInfo): Model | undefined {
		return this.#ctx.models.list().find(x => x.provider === m.provider && x.id === m.id);
	}

	hasAuth(model: ModelInfo): boolean {
		const host = this.hostModel(model);
		if (!host) return false;
		try {
			return this.#ctx.modelRegistry.hasConfiguredAuth(host);
		} catch {
			return true;
		}
	}

	setModel(model: ModelInfo): Promise<boolean> {
		const host = this.hostModel(model);
		if (!host) return Promise.resolve(false);
		return this.pi.setModel(host);
	}

	setThinkingLevel(effort: string): void {
		this.pi.setThinkingLevel(effort as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	}

	isStreaming(): boolean {
		return !this.#ctx.isIdle();
	}

	sendWake(message: CustomWakeMessage): void {
		this.pi.sendMessage(message, { deliverAs: "aside" });
	}

	activeTools(): string[] {
		return this.pi.getActiveTools();
	}

	branchEntries(): readonly TranscriptEntry[] {
		try {
			return this.#ctx.sessionManager.getBranch() as unknown as TranscriptEntry[];
		} catch {
			return [];
		}
	}

	notify(text: string, level: "info" | "warning" | "error"): void {
		if (this.#ctx.mode !== "tui" && this.#ctx.mode !== "rpc") return;
		try {
			this.#ctx.ui.notify(text, level);
		} catch {}
	}

	usage(): UsageSource | undefined {
		const storage = this.#ctx.modelRegistry.authStorage;
		if (!storage?.usage) return undefined;
		return {
			reports: async signal => {
				const reports = await storage.usage.reports({ signal });
				return (reports ?? []).map(r => ({ provider: r.provider, limits: r.limits }));
			},
		};
	}
}
