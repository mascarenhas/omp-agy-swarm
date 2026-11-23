// Flat parameter schemas, built once by the factory with pi.zod and reused for worker tools.
// Per-action validation happens in ops.ts with precise messages.

import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { EFFORTS } from "../env.ts";
import type { PostParams, ReadParams, SwarmParams, WaitParams } from "./ops.ts";

export type Zod = ExtensionAPI["zod"];

const OMIT_UNUSED = " Omit unused optional arguments; use null if your tool-call format requires a value.";

export const DESCRIPTIONS = {
	swarm:
		"Manage the swarm: parallel worker agents sharing one message board. Actions: status | models | add | model | scout | kill | revive | finish | title | channel. add{name, brief, model?, effort?, tasks?|n?, fork?, workspace?, channels?, role?} starts a worker and posts its brief as `@name brief`; without model/effort it runs on yours. model{name?, model?, effort?} changes a waiting member's (or your own) model or effort; it keeps its conversation. scout{model?, effort?} configures scouts for newly added or revived workers. Effort alone retains native model selection; neither argument resets to native policy. kill{name} is permanent. workspace: inherit = your working copy; share = its own git worktree starting from your working copy as it stands (uncommitted changes included, ignored files not); branch = its own worktree from your last commit. models{query?, provider?} lists runnable models with their effort levels. Coordinators: read skill://swarm before the first add." +
		' Omit unused parameters; use "omit" for unused enum fields, [] for arrays, or null for other optional fields.',
	post_message:
		"Post to the swarm's message board. Start with the @name of whoever must act on it (@all for everyone, @#channel for a channel's members); a mention wakes that member. Refer to earlier posts as #seq." +
		OMIT_UNUSED,
	read_board:
		'Read the swarm\'s message board: posts after `since` (default: your read cursor) in your own view; channel:"name" reads one channel, "*" all. status:true returns each member\'s state, wake mode and cursors instead of posts.' +
		OMIT_UNUSED,
	swarm_wait:
		"Sleep until a board post names you (mentions_only:false: any post you can see) or timeout_seconds pass. Returns the new posts. Call it as the last tool call of your response. Sleeping costs nothing." +
		OMIT_UNUSED,
	swarm_wait_worker:
		"Sleep until a board post names you (mentions_only:false: any visible post), omp has background work ready, or timeout_seconds pass. woke:job means omp will deliver background work after the tool returns. For standby, omit the timeout. Call it as the only tool call of its response." +
		OMIT_UNUSED,
} as const;

export interface Schemas {
	swarm: ZodLikeSchema<SwarmParams>;
	post_message: ZodLikeSchema<PostParams>;
	read_board: ZodLikeSchema<ReadParams>;
	swarm_wait: ZodLikeSchema<WaitParams>;
}

export function buildSchemas(z: Zod): Schemas {
	// Keep one concrete wire type per field for CCA and Cursor. The host
	// already drops null for non-nullable optional enum and array inputs.
	const text = z.string().nullable().transform(value => value?.trim() ? value : undefined).optional();
	const bool = z.boolean().nullable().transform(value => value ?? undefined).optional();
	const array = z.array(z.string()).transform(value => value.length ? value : undefined).optional();
	const integer = z.number().int().min(0);
	const seq = integer.nullable().transform(value => value ?? undefined).optional();
	const count = (schema: ZodLikeSchema<number>) =>
		schema.nullable().transform(value => value === 0 ? undefined : value ?? undefined).optional();
	const choice = (values: readonly [string, ...string[]]) =>
		z.enum(["omit", ...values]).transform(value => value === "omit" ? undefined : value).optional();
	return {
		swarm: z.object({
			action: z
				.enum(["status", "models", "add", "model", "scout", "kill", "revive", "finish", "title", "channel"])
				.describe("What to do"),
			name: text.describe("add: worker name or group prefix; model/kill/revive: member or group prefix; channel (un)subscribe: member"),
			brief: text.describe("add: what the worker owns (≤ 6000 characters); optional for role narrator|monitor"),
			model: text.describe('add, model, scout: "provider/id" | bare id | "@role", optional ":effort" suffix'),
			effort: choice(EFFORTS).describe('When omitted, use the model suffix or, for add/model, inherited/current effort; "off" explicitly disables reasoning'),
			tasks: array.describe("add: 1..16 slices, each ≤ 1500 characters → <name>-1..<name>-k; [] omits"),
			n: count(integer).describe("add: 2..16 homogeneous copies (not with tasks); 0 or null omits"),
			fork: text.describe('add: member name or "coordinator" whose conversation the worker starts from'),
			workspace: choice(["inherit", "share", "branch"]).describe("add: where the worker works (defaults to inherit)"),
			channels: array.describe('add: initial subscriptions; first is the brief channel; [] omits; ["main"] selects only main'),
			role: choice(["worker", "narrator", "monitor"]).describe("add: defaults to worker"),
			discard_ignored: bool.describe("kill: also remove ignored files in the worktree"),
			keep_workspace: bool.describe("kill: keep the worktree"),
			summary: text.describe("finish: the [done] summary (no @mentions)"),
			abandon: bool.describe("finish: cancel what is still running and record it"),
			title: text.describe("title: ≤ 80 characters"),
			op: choice(["create", "list", "subscribe", "unsubscribe", "archive"]).describe("channel: operation; omit for other actions"),
			channel: text.describe("channel: channel name"),
			topic: text.describe("channel create: topic"),
			query: text.describe("models: terms that must all match provider/id or name"),
			provider: text.describe("models: exact provider"),
			limit: count(integer).describe("models: 1..100 (0 or null uses default 40)"),
		}),
		post_message: z.object({
			text: z.string().describe("The post (1..8000 characters). Start with the @name of whoever must act."),
			channel: text.describe("Channel (default: your default channel, else main)"),
		}),
		read_board: z.object({
			since: seq.describe("Posts after this seq (0 reads from the start; null uses your read cursor)"),
			limit: count(integer.max(200)).describe("At most this many posts (0 or null uses default 50)"),
			channel: text.describe('"*" = every channel; a name = that channel only; omitted = your own view'),
			status: bool.describe("true: member status instead of posts"),
		}),
		swarm_wait: z.object({
			since: seq.describe("Advisory; null uses the remembered read cursor"),
			mentions_only: bool.describe("Null or true wakes only if named; false wakes on any post you can see"),
			timeout_seconds: count(integer.max(86_400)).describe("Wake at the latest after this many seconds (0 or null means no timer)"),
		}),
	};
}

