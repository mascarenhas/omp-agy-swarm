// ToolDefinition wrappers for the main session (§8.1). Registered `defaultInactive` + `essential`
// and admitted only in the main session_start (H13).

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { SwarmEnv } from "../env.ts";
import type { CoordinatorBinding } from "../runtime/coordinator.ts";
import type { ThinkingCaps } from "../runtime/ports.ts";
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
import { callLine, lineComponent, resultLine } from "./render.ts";
import { DESCRIPTIONS, type Schemas } from "./schemas.ts";

/** Scheduling flags typed once (§2 rule 5). */
export type MainTool = ToolDefinition & Pick<AgentTool, "interruptible" | "concurrency">;

export interface MainToolHost {
	schemas: Schemas;
	caps: ThinkingCaps;
	env: SwarmEnv;
	/** Refreshes and returns the binding for a main-session call. */
	bind(ctx: ExtensionContext): CoordinatorBinding;
	/** The main session's cwd as its binding last saw it (session_start onward), if bound yet. */
	boundCwd(): string | undefined;
	runtime(sid: string): SwarmRuntime | undefined;
	ensure(binding: CoordinatorBinding): SwarmRuntime | { error: string };
	refusal(sid: string): string | undefined;
}

const EXEC_ACTIONS: Readonly<Record<string, true>> = { add: true, revive: true, kill: true, finish: true };
const READ_ACTIONS: Readonly<Record<string, true>> = { status: true, models: true };

export function swarmApproval(cwd: () => string) {
	return (args: unknown): "read" | "write" | { tier: "exec"; reason: string } => {
		const a = args && typeof args === "object" ? (args as { action?: unknown; op?: unknown }) : {};
		const action = typeof a.action === "string" ? a.action : "";
		if (Object.hasOwn(READ_ACTIONS, action) || (action === "channel" && a.op === "list")) return "read";
		if (Object.hasOwn(EXEC_ACTIONS, action)) {
			const reason =
				action === "add" || action === "revive"
					? `starts unattended agents that run with all their tools auto-approved in ${cwd()}`
					: action === "kill"
						? "stops a member permanently and may remove its git worktree"
						: "ends the swarm's work and may cancel running members";
			return { tier: "exec", reason };
		}
		return "write";
	};
}

export function mainToolDefinitions(host: MainToolHost): MainTool[] {
	const run = async <P>(
		toolCallId: string,
		params: P,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		op: (o: OpsContext, p: P) => ToolResult | Promise<ToolResult>,
	): Promise<ToolResult> => {
		if (ctx.agent.kind !== "main") return fail(NOT_A_MEMBER);
		const binding = host.bind(ctx);
		const rt = host.runtime(binding.sessionId);
		if (!rt) {
			const refusal = host.refusal(binding.sessionId);
			if (refusal) return fail(refusal);
		} else rt.rebind(binding);
		const o: OpsContext = {
			rt: rt ?? null,
			caller: rt?.coordinator ?? null,
			ensure: () => host.ensure(binding),
			env: host.env,
			binding,
			caps: host.caps,
			toolCallId,
			signal,
			batch: rt?.coordinator.tracker.batchOf(toolCallId),
			isWorker: false,
		};
		return op(o, (params ?? {}) as P);
	};
	const render = (tool: string) => ({
		renderCall: (args: unknown) => lineComponent(callLine(tool, (args ?? {}) as Record<string, unknown>)),
		renderResult: (result: { details?: unknown }) => lineComponent(resultLine(tool, result.details as Record<string, unknown> | undefined)),
	});
	const define = <P>(
		name: "swarm" | "post_message" | "read_board" | "swarm_wait",
		parameters: unknown,
		approval: MainTool["approval"],
		op: (o: OpsContext, p: P) => ToolResult | Promise<ToolResult>,
		flags: Pick<AgentTool, "interruptible" | "concurrency"> = {},
	): MainTool => {
		const tool = {
			name,
			label: name,
			description: DESCRIPTIONS[name],
			parameters,
			loadMode: "essential" as const,
			defaultInactive: true,
			approval,
			...flags,
			...render(name),
			execute: (toolCallId: string, params: P, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) =>
				run(toolCallId, params, signal, ctx, op),
		};
		// ToolDefinition is generic over the host's schema type; ours is the pi.zod schema it accepts.
		return tool as unknown as MainTool;
	};
	return [
		// The approval prompt runs before execute: its cwd comes from the binding session_start set.
		define<SwarmParams>("swarm", host.schemas.swarm, swarmApproval(() => host.boundCwd() ?? process.cwd()), swarmOp),
		define<PostParams>("post_message", host.schemas.post_message, "write", postMessageOp),
		define<ReadParams>("read_board", host.schemas.read_board, "read", readBoardOp),
		define<WaitParams>("swarm_wait", host.schemas.swarm_wait, "read", swarmWaitOp, { interruptible: true, concurrency: "exclusive" }),
	];
}
