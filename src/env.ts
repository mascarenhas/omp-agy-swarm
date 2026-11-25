// Environment knobs and limits: the single source of every tunable number in the plugin.
// PURE: node builtins only.

export const SUPPORTED_HOST: readonly string[] = ["19.2.0"];

export const MEMBER_TOOL_NAMES = ["swarm", "post_message", "read_board", "swarm_wait"] as const;
export type SwarmToolName = (typeof MEMBER_TOOL_NAMES)[number];
export const HARD_EXCLUDED_TOOLS: Readonly<Record<string, true>> = {
	wait: true,
	manage_skill: true,
	new_context: true,
	yield: true,
	irc: true,
	async: true,
	job: true,
	swarm: true,
	post_message: true,
	read_board: true,
	swarm_wait: true,
};

export const DEFAULT_WORKER_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"glob",
	"grep",
	"eval",
	"task",
	"todo",
	"web_search",
	"lsp",
	"ast_grep",
	"ast_edit",
] as const;
export const NARRATOR_TOOLS = ["read", "write", "edit", "bash", "glob", "grep"] as const;
export const DEFAULT_SCOUT_EFFORT = "high";

export const LIMITS = {
	postChars: 8000,
	briefChars: 6000,
	taskChars: 1500,
	titleChars: 80,
	summaryChars: 2000,
	groupMax: 16,
	helperDepth: 2,
	addParallel: 4,
	wakePage: { limit: 20, maxBytes: 12_000 },
	readPage: { limit: 50, maxLimit: 200, maxBytes: 48_000 },
	noticeQueue: 20,
	noticeChars: 400,
	failureTextChars: 300,
	activityChars: 96,
	transcriptItemBytes: 4096,
	transcriptPage: 200,
	viewFileBytes: 64 * 1024,
	frameBytes: 8 * 1024 * 1024,
	webFileBytes: 512 * 1024,
	postedFrames: 24,
	allowedFiles: 64,
	rosterFile: 16 * 1024 * 1024,
	journalFile: 512 * 1024 * 1024,
} as const;

export const TIMING = {
	stallMs: 5_000,
	gateBudgetMs: 20_000,
	/** The one ref'd keep-alive interval (also runs the stuck, no-progress and deadline checks). */
	keepAliveMs: 5_000,
	flushDebounceMs: 250,
	redeliveryMs: [2_000, 8_000, 30_000] as readonly number[],
	failureRetryMs: 2_000,
	coordinatorReceiptMs: 5_000,
	stuckMs: 10 * 60_000,
	killStopMs: 10_000,
	shutdownDisposeMs: 1_500,
	gitTimeoutMs: 60_000,
	quotaCacheMs: 60_000,
	quotaTimeoutMs: 2_500,
	failureNoticeMs: 60_000,
	coordinatorSwitchMs: 8_000,
	/** A headless coordinator switch must finish inside the stop handler (gateBudgetMs). */
	gateSwitchMs: 15_000,
	metricsDebounceMs: 2_000,
	uiFilePollMs: 2_000,
	uiRenderCoalesceMs: 100,
} as const;

/**
 * Settles with `p`, or with `fallback` once `ms` pass. The timer is a cancellable setTimeout
 * cleared on every exit (an uncancellable Bun.sleep would hold the event loop after a fast
 * completion); `unref` lets a shutdown race never keep the process alive.
 */
export async function raceTimeout<T, F>(p: Promise<T>, ms: number, fallback: F, opts: { unref?: boolean } = {}): Promise<T | F> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<F>(resolve => {
		timer = setTimeout(() => resolve(fallback), ms);
		if (opts.unref) timer.unref?.();
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export interface SwarmEnv {
	dir: string | undefined;
	ui: boolean;
	uiPort: number;
	uiRoots: string[];
	maxWorkers: number;
	workerTools: string[] | undefined;
	gateMaxRefusals: number;
	/** How long one headless stop may wait for members before refusing (handler budget is 30 s). */
	gateWaitSeconds: number;
	noProgressSeconds: number;
	deadlineSeconds: number;
	shareMaxMb: number;
	maxCostUsd: number;
}

function int(v: string | undefined, def: number, min: number, max: number): number {
	if (v === undefined || v.trim() === "") return def;
	const n = Number(v);
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

function num(v: string | undefined, def: number): number {
	if (v === undefined || v.trim() === "") return def;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Reads the environment once per call; callers capture it at runtime construction. */
export function readEnv(env: Record<string, string | undefined> = process.env): SwarmEnv {
	const tools = env.OMP_SWARM_WORKER_TOOLS;
	const roots = (env.OMP_SWARM_UI_ROOTS ?? "")
		.split(":")
		.map(s => s.trim())
		.filter(s => s.startsWith("/"))
		.slice(0, 4);
	return {
		dir: env.OMP_SWARM_DIR?.trim() || undefined,
		ui: env.OMP_SWARM_UI === "1",
		uiPort: int(env.OMP_SWARM_UI_PORT, 0, 0, 65535),
		uiRoots: roots,
		maxWorkers: int(env.OMP_SWARM_MAX_WORKERS, 24, 1, 256),
		workerTools:
			tools === undefined
				? undefined
				: tools
						.split(",")
						.map(s => s.trim())
						.filter(Boolean),
		gateMaxRefusals: int(env.OMP_SWARM_GATE_MAX_REFUSALS, 8, 1, 1000),
		gateWaitSeconds: int(env.OMP_SWARM_GATE_WAIT_SECONDS, TIMING.gateBudgetMs / 1000, 1, 25),
		noProgressSeconds: int(env.OMP_SWARM_NO_PROGRESS_SECONDS, 3600, 0, 7 * 86400),
		deadlineSeconds: int(env.OMP_SWARM_DEADLINE_SECONDS, 0, 0, 7 * 86400),
		shareMaxMb: int(env.OMP_SWARM_SHARE_MAX_MB, 200, 1, 100_000),
		maxCostUsd: num(env.OMP_SWARM_MAX_COST_USD, 0),
	};
}

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export function isEffort(v: unknown): v is Effort {
	return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const RESERVED_NAMES: Readonly<Record<string, true>> = { all: true, coordinator: true, main: true, here: true };
export const CHANNEL_RE = /^[a-z][a-z0-9-]{0,23}$/;
export const RESERVED_CHANNELS: Readonly<Record<string, true>> = { main: true, all: true, here: true };
export const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit|usage limit/i;
export const ROLE_WORKER_NAME_RE = /^(?:narrator|monitor)(?:-\d+)?$/;

/** Own-key membership for the static lookup tables above (never matches prototype keys). */
export function hasKey(table: Readonly<Record<string, true>>, key: string): boolean {
	return Object.hasOwn(table, key);
}
