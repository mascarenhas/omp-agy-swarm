// omp-agy-swarm extension factory. Only the main session acts: every hook returns immediately
// unless ctx.agent.kind === "main" (the host also rebinds this factory into native subagents).

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { MEMBER_TOOL_NAMES, readEnv, SUPPORTED_HOST, TIMING } from "./env.ts";
import { CoordinatorBinding } from "./runtime/coordinator.ts";
import { stopGate } from "./runtime/gate.ts";
import { applyPreSwarmSwitch } from "./runtime/models.ts";
import { createSessionFactory, HOST_VERSION, mainCanResume, scopedSettings, thinkingCaps } from "./runtime/omp-adapter.ts";
import type { HostMessage } from "./runtime/ports.ts";
import { registry } from "./runtime/registry.ts";
import type { RuntimeDeps, SwarmRuntime } from "./runtime/runtime.ts";
import { defaultGit } from "./runtime/workspace.ts";
import { mainToolDefinitions } from "./tools/main-tools.ts";
import { makeMemberTools } from "./tools/member-tools.ts";
import { buildSchemas } from "./tools/schemas.ts";
import { registerCommands, type UiHost } from "./ui/commands.ts";

const PACKAGE_DIR = join(import.meta.dir, "..");

let warnedVersion = false;

export default function swarmExtension(pi: ExtensionAPI): void {
	if (!SUPPORTED_HOST.includes(HOST_VERSION) && !warnedVersion) {
		warnedVersion = true;
		process.stderr.write(`omp-agy-swarm: tested with omp ${SUPPORTED_HOST.join(", ")}; this host is ${HOST_VERSION}\n`);
	}
	const env = readEnv();
	const schemas = buildSchemas(pi.zod);
	let binding: CoordinatorBinding | undefined;
	const log = (line: string): void => {
		process.stderr.write(`${line}\n`);
	};

	const bind = (ctx: ExtensionContext): CoordinatorBinding => {
		const settings = scopedSettings();
		if (!binding) binding = new CoordinatorBinding(pi, ctx, settings);
		else binding.update(ctx, settings);
		return binding;
	};

	const deps = (b: CoordinatorBinding): RuntimeDeps => ({
		makeFactory: () => createSessionFactory(b, pi.events, log),
		caps: thinkingCaps,
		makeMemberTools: (rt, m, gen) => makeMemberTools(rt, m, gen, { schemas, caps: thinkingCaps, binding: () => rt.binding }),
		packageDir: PACKAGE_DIR,
		defaultsDir: join(getAgentDir(), "swarm"),
		env,
		git: defaultGit,
		log,
	});

	const current = (ctx: ExtensionContext): SwarmRuntime | undefined => {
		if (ctx.agent.kind !== "main") return undefined;
		return registry.get(ctx.sessionManager.getSessionId());
	};

	const ui: UiHost = {
		runtime: sid => registry.get(sid),
		refusal: sid => registry.refusal(sid),
		bind,
		env,
		packageDir: PACKAGE_DIR,
	};

	for (const tool of mainToolDefinitions({
		schemas,
		caps: thinkingCaps,
		env,
		bind,
		boundCwd: () => binding?.cwd,
		runtime: sid => registry.get(sid),
		ensure: b => registry.ensure(b, deps(b)),
		refusal: sid => registry.refusal(sid),
	})) {
		pi.registerTool(tool);
	}
	const commands = registerCommands(pi, ui);
	registry.onCreated(rt => commands.onRuntime(rt));

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.agent.kind !== "main") return;
		await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...MEMBER_TOOL_NAMES])]);
		const b = bind(ctx);
		registry.attach(b, deps(b));
		const refusal = registry.refusal(b.sessionId);
		if (refusal) b.notify(`omp-agy-swarm: ${refusal}`, "warning");
	});

	if (env.maxCostUsd > 0) pi.on("before_subagent_spawn", (_event, ctx) => {
		const refusal = current(ctx)?.spendRefusal();
		if (refusal) return {
			block: true,
			reason: `${refusal.message} To resume native delegation, restart without OMP_SWARM_MAX_COST_USD or switch to a session without this swarm.`,
		};
	});

	pi.on("agent_start", (_e, ctx) => {
		const rt = current(ctx);
		if (!rt) return;
		rt.rebind(bind(ctx));
		rt.onMainAgentStart();
	});

	pi.on("turn_start", (_e, ctx) => {
		const rt = current(ctx);
		if (!rt) return;
		rt.rebind(bind(ctx));
		rt.onMainTurnStart();
	});

	pi.on("message_end", (e, ctx) => {
		current(ctx)?.onMainMessageEnd(e.message as unknown as HostMessage);
	});

	pi.on("auto_retry_end", (e, ctx) => {
		current(ctx)?.onMainAutoRetryEnd(e.success);
	});

	pi.on("tool_execution_end", (e, ctx) => {
		current(ctx)?.onMainToolEnd(e.toolCallId, e.isError === true);
	});

	pi.on("agent_end", (e, ctx) => {
		const rt = current(ctx);
		if (!rt) {
			// No swarm: a self switch requested before one existed applies at this boundary.
			if (ctx.agent.kind !== "main" || e.willContinue) return;
			const b = bind(ctx);
			if (b.headless || !b.pendingSelfSwitch) return;
			void applyPreSwarmSwitch(b, TIMING.coordinatorSwitchMs).then(res => {
				if (res && res.state !== "ok") b.notify(`omp-agy-swarm: ${res.text.replace(/^\[swarm\] /, "")}`, "warning");
			});
			return;
		}
		rt.rebind(bind(ctx));
		const last = rt.binding.headless && !e.willContinue ? e.messages.findLast(message => message.role === "assistant") : undefined;
		rt.onMainAgentEnd({
			willContinue: e.willContinue,
			awaitingAsyncWork: e.awaitingAsyncWork,
			mayResume: last?.role === "assistant" && last.stopReason !== "aborted" && last.stopReason !== "error" && mainCanResume(rt.sid),
		});
	});

	pi.on("session_stop", async (e, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const rt = current(ctx);
		const b = bind(ctx);
		if (!rt) {
			// Headless, no swarm: apply a pending self switch inside this stop and continue on the
			// new model; a switch that does not finish in time fails closed (no further turn).
			if (!b.headless || !b.pendingSelfSwitch) return;
			const res = await applyPreSwarmSwitch(b, TIMING.gateSwitchMs);
			if (!res || res.state === "pending" || e.signal.aborted) return;
			return { decision: "block", reason: res.text };
		}
		rt.rebind(b);
		if (!b.headless) return;
		rt.onMainStopHook();
		const last = e.last_assistant_message as unknown as HostMessage | undefined;
		return stopGate(rt, { signal: e.signal, lastStopReason: last?.stopReason });
	});

	pi.on("session_compact", (_e, ctx) => {
		current(ctx)?.onMainCompact();
	});

	pi.on("session_clear", (_e, ctx) => {
		const rt = current(ctx);
		if (!rt) return;
		rt.rebind(bind(ctx));
		rt.onSessionClear();
	});

	pi.on("session_switch", async (_e, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const b = bind(ctx);
		// A pre-swarm self switch belonged to the session we left.
		b.pendingSelfSwitch = undefined;
		const sid = b.sessionId;
		// Resuming the same session file can replace its transcript without changing the id.
		registry.get(sid)?.onMainTranscriptReset();
		for (const rt of registry.all()) {
			if (rt.sid !== sid) {
				commands.onShutdown(rt);
				await registry.drop(rt.sid);
			}
		}
		registry.attach(b, deps(b));
		const refusal = registry.refusal(sid);
		if (refusal) b.notify(`omp-agy-swarm: ${refusal}`, "warning");
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		if (ctx.agent.kind !== "main") return;
		for (const rt of registry.all()) {
			commands.onShutdown(rt);
			await registry.drop(rt.sid);
		}
	});
}
