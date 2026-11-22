import type { Checks } from "./check.ts";
import type { PaidCtx, Trace } from "./paid-evidence.ts";

export interface PaidScenario {
	id: string;
	prompt: string | ((scoutOverride: string | undefined) => string);
	fixture?: Record<string, string>;
	mock?: boolean;
	model?: string;
	cap?: number;
	maxSeconds?: number;
	pty?: boolean;
	env?: NodeJS.ProcessEnv;
	/** Driven by observed runtime state, never by model reports or fixed provider delays. */
	tick?(c: PaidCtx, trace: Trace[]): void;
	after?(c: PaidCtx): Promise<void>;
	check(c: PaidCtx, k: Checks): void;
}

export const W = { haiku: "anthropic/claude-haiku-5-5", luna: "openai-codex/gpt-6-luna", deepseek: "opencode-go/deepseek-v4.1-flash" };
export const EFFORT = "low";
export const OBSERVER = new URL("./paid-observer.ts", import.meta.url).pathname;
export const SCOUT_PROVIDERS = ["openai-codex", "anthropic", "antigravity-cli"];
