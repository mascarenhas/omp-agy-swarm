// Flat parameter schemas, built once by the factory with pi.zod and reused for worker tools.
// Per-action validation happens in ops.ts with precise messages.

import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { EFFORTS } from "../env.ts";
import type { PostParams, ReadParams, SwarmParams, WaitParams } from "./ops.ts";

export type Zod = ExtensionAPI["zod"];

export const DESCRIPTIONS = {
	swarm:
		"Manage the swarm: parallel worker agents, each in its own conversation, sharing one message board. Actions: status | models | add | model | kill | revive | finish | title | channel. add{name, brief, model?, effort?, tasks?|n?, fork?, workspace?, channels?, role?} starts a worker and posts its brief as `@name brief`; without model/effort it runs on yours. model{name?, model?, effort?} changes a waiting member's (or your own) model or effort; it keeps its conversation. kill{name} is permanent. workspace: inherit = your working copy; share = its own git worktree starting from your working copy as it stands (uncommitted changes included, ignored files not); branch = its own worktree from your last commit. models{query?, provider?} lists runnable models with their effort levels. Coordinators: read skill://swarm before the first add.",
	post_message:
		"Post to the swarm's message board. Start with the @name of whoever must act on it (@all for everyone, @#channel for a channel's members); a mention wakes that member. Refer to earlier posts as #seq.",
	read_board:
		'Read the swarm\'s message board: posts after `since` (default: your read cursor) in your own view; channel:"name" reads one channel, "*" all. status:true returns each member\'s state, wake mode and cursors instead of posts.',
	swarm_wait:
		"Sleep until a board post names you (mentions_only:false: any post you can see) or timeout_seconds pass. Returns the new posts. Call it as the last tool call of your response. Sleeping costs nothing.",
	swarm_wait_worker:
		"Sleep until a board post names you (mentions_only:false: any post you can see) or timeout_seconds pass. Returns the new posts. Call it on its own: it must be the only tool call of its response. Sleeping costs nothing.",
} as const;

export interface Schemas {
	swarm: ZodLikeSchema<SwarmParams>;
	post_message: ZodLikeSchema<PostParams>;
	read_board: ZodLikeSchema<ReadParams>;
	swarm_wait: ZodLikeSchema<WaitParams>;
}

export function buildSchemas(z: Zod): Schemas {
	const effort = z.enum(EFFORTS);
	return {
		swarm: z.object({
			action: z
				.enum(["status", "models", "add", "model", "kill", "revive", "finish", "title", "channel"])
				.describe("What to do"),
			name: z.string().optional().describe("add: worker name or group prefix; model/kill/revive: member or group prefix; channel (un)subscribe: member"),
			brief: z.string().optional().describe("add: what the worker owns (≤ 6000 characters); optional for role narrator|monitor"),
			model: z.string().optional().describe('add, model: "provider/id" | bare id | "@role", optional ":effort" suffix'),
			effort: effort.optional().describe("add, model: reasoning effort"),
			tasks: z.array(z.string()).optional().describe("add: 1..16 slices, each ≤ 1500 characters → <name>-1..<name>-k"),
			n: z.number().int().optional().describe("add: 2..16 homogeneous copies (not with tasks)"),
			fork: z.string().optional().describe('add: member name or "coordinator" whose conversation the worker starts from'),
			workspace: z.enum(["inherit", "share", "branch"]).optional().describe("add: where the worker works (default inherit)"),
			channels: z.array(z.string()).optional().describe("add: initial subscriptions; the first is the brief's channel"),
			role: z.enum(["worker", "narrator", "monitor"]).optional().describe("add: default worker"),
			discard_ignored: z.boolean().optional().describe("kill: also remove ignored files in the worktree"),
			keep_workspace: z.boolean().optional().describe("kill: keep the worktree"),
			summary: z.string().optional().describe("finish: the [done] summary (no @mentions)"),
			abandon: z.boolean().optional().describe("finish: cancel what is still running and record it"),
			title: z.string().optional().describe("title: ≤ 80 characters"),
			op: z.enum(["create", "list", "subscribe", "unsubscribe", "archive"]).optional().describe("channel: operation"),
			channel: z.string().optional().describe("channel: channel name"),
			topic: z.string().optional().describe("channel create: topic"),
			query: z.string().optional().describe("models: terms that must all match provider/id or name"),
			provider: z.string().optional().describe("models: exact provider"),
			limit: z.number().int().optional().describe("models: 1..100 (default 40)"),
		}),
		post_message: z.object({
			text: z.string().describe("The post (1..8000 characters). Start with the @name of whoever must act."),
			channel: z.string().optional().describe("Channel (default: your default channel, else main)"),
		}),
		read_board: z.object({
			since: z.number().int().min(0).optional().describe("Posts after this seq (default: your read cursor)"),
			limit: z.number().int().min(1).max(200).optional().describe("At most this many posts (default 50)"),
			channel: z.string().optional().describe('"*" = every channel; a name = that channel only; omitted = your own view'),
			status: z.boolean().optional().describe("true: member status instead of posts"),
		}),
		swarm_wait: z.object({
			since: z.number().int().min(0).optional().describe("Advisory; the board remembers your cursor"),
			mentions_only: z.boolean().optional().describe("Default true; false wakes on any post you can see"),
			timeout_seconds: z.number().int().min(1).max(86_400).optional().describe("Wake at the latest after this many seconds"),
		}),
	};
}

