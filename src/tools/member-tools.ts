// CustomTool wrappers bound to one member and one generation (identity by construction, §3.2).
// Worker ABI: execute(toolCallId, params, onUpdate, ctx, signal) (H6).

import type { CustomTool, CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import type { Member } from "../runtime/member.ts";
import type { CoordinatorPort, ThinkingCaps } from "../runtime/ports.ts";
import type { SwarmRuntime } from "../runtime/runtime.ts";
import {
	fail,
	NOT_A_MEMBER,
	type OpsContext,
	type PostParams,
	postMessageOp,
	type ReadParams,
	readBoardOp,
	type SwarmParams,
	swarmOp,
	swarmWaitOp,
	type ToolResult,
	type WaitParams,
} from "./ops.ts";
import { DESCRIPTIONS, type Schemas } from "./schemas.ts";

const ROLE_TOOLS: Record<string, readonly string[]> = {
	worker: ["swarm", "post_message", "read_board", "swarm_wait"],
	narrator: ["read_board", "swarm_wait"],
	monitor: ["read_board", "swarm_wait", "post_message"],
};

interface BranchEntryLike {
	type?: string;
	message?: { role?: string; content?: unknown };
}

/** The tool calls of the response holding `toolCallId`, read from the session's branch (fallback for H12). */
function batchFromBranch(ctx: CustomToolContext, toolCallId: string): string[] | undefined {
	let branch: BranchEntryLike[];
	try {
		branch = ctx.sessionManager.getBranch() as BranchEntryLike[];
	} catch {
		return undefined;
	}
	for (let i = branch.length - 1; i >= 0 && i >= branch.length - 20; i--) {
		const msg = branch[i]?.message;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const ids = (msg.content as { type?: string; id?: string }[]).filter(c => c.type === "toolCall" && typeof c.id === "string").map(c => c.id as string);
		if (ids.includes(toolCallId)) return ids;
	}
	return undefined;
}

export interface MemberToolDeps {
	schemas: Schemas;
	caps: ThinkingCaps;
	binding: () => CoordinatorPort;
}

export function makeMemberTools(rt: SwarmRuntime, m: Member, gen: number, deps: MemberToolDeps): CustomTool[] {
	const admit = (ctx: CustomToolContext): boolean => {
		if (rt.closing || m.killed || m.gen !== gen) return false;
		try {
			return ctx.sessionManager.getSessionId() === m.conversationId;
		} catch {
			return false;
		}
	};
	const opsCtx = (toolCallId: string, ctx: CustomToolContext, signal: AbortSignal | undefined): OpsContext => ({
		rt,
		caller: m,
		ensure: () => ({ error: "workers cannot create a swarm" }),
		env: rt.env,
		binding: deps.binding(),
		caps: deps.caps,
		toolCallId,
		signal,
		batch: m.tracker.batchOf(toolCallId) ?? batchFromBranch(ctx, toolCallId),
		isWorker: true,
	});
	const wrap = <P>(
		name: string,
		parameters: unknown,
		approval: "read" | "write",
		run: (o: OpsContext, p: P) => ToolResult | Promise<ToolResult>,
	): CustomTool => {
		const tool = {
			name,
			label: name,
			description: name === "swarm_wait" ? DESCRIPTIONS.swarm_wait_worker : DESCRIPTIONS[name as keyof typeof DESCRIPTIONS],
			parameters,
			loadMode: "essential" as const,
			approval,
			async execute(toolCallId: string, params: unknown, _onUpdate: unknown, ctx: CustomToolContext, signal?: AbortSignal) {
				if (!admit(ctx)) return fail(NOT_A_MEMBER);
				return run(opsCtx(toolCallId, ctx, signal), (params ?? {}) as P);
			},
		};
		// The host's CustomTool generic is keyed to its schema type; ours is the zod-like schema it accepts.
		return tool as unknown as CustomTool;
	};
	const all: Record<string, CustomTool> = {
		swarm: wrap<SwarmParams>("swarm", deps.schemas.swarm, "write", swarmOp),
		post_message: wrap<PostParams>("post_message", deps.schemas.post_message, "write", postMessageOp),
		read_board: wrap<ReadParams>("read_board", deps.schemas.read_board, "read", readBoardOp),
		swarm_wait: wrap<WaitParams>("swarm_wait", deps.schemas.swarm_wait, "read", swarmWaitOp),
	};
	return (ROLE_TOOLS[m.role] ?? []).map(n => all[n]).filter((t): t is CustomTool => !!t);
}
