// Explicitly loaded by the paid harness (and its loopback self-test). Observation only:
// no tools, model calls, settings writes, simulated lifecycle events, or result injection.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRegistry, AgentSession, type AgentRef, type AgentSessionEvent, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TASK_SUBAGENT_EVENT_CHANNEL, type SubagentEventPayload } from "@oh-my-pi/pi-coding-agent/task";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload, type SubagentProgressPayload,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { getAgentDbPath, getAgentDir, getTerminalSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { contentText, type TraceBody, usageTokens } from "./paid-evidence.ts";

export default function observe(pi: ExtensionAPI): void {
	const path = process.env.OMP_SWARM_PAID_TRACE;
	if (!path) return;
	const write = (record: TraceBody): void => appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...record })}\n`);
	const registry = AgentRegistry.global();
	const subscriptions = new Map<string, () => void>();
	// Keep the exact local session until shutdown so we can observe its jobs after detachment.
	const sessions = new Map<string, { identity: { id: string; generation: number; parentId?: string }; session: AgentSession; last?: string }>();
	let cleanup: (() => void) | undefined;
	const key = (ref: AgentRef): string => `${ref.id}:${ref.generation}`;
	const sample = (): void => {
		for (const holder of sessions.values()) {
			const snapshot = holder.session.getAsyncJobSnapshot();
			if (!snapshot) continue;
			const jobs = [...snapshot.running, ...snapshot.recent].map(({ id, ownerId, agentId, type, status, startTime, endTime }) =>
				({ id, ownerId, agentId, type, status, startTime, endTime }));
			const next = JSON.stringify(jobs);
			if (next === holder.last) continue;
			holder.last = next;
			write({ kind: "jobs", ...holder.identity, jobs });
		}
	};
	const record = (id: string, source: "session" | "task", ev: AgentSessionEvent): void => {
		const event = ev.type;
		const base = { kind: "event", id, source, event } as const;
		switch (event) {
			case "agent_start": case "agent_end":
				write(base);
				break;
			case "agent_pause":
				write({ ...base, awaiting: ev.awaiting });
				break;
			case "tool_execution_start": {
				const args = ev.toolName === "swarm" ? ev.args as Record<string, unknown> | undefined : undefined;
				const swarmArgs = args && { action: args.action, name: args.name, n: args.n, fork: args.fork,
					tasks: Array.isArray(args.tasks) ? args.tasks.length : undefined,
					channels: Array.isArray(args.channels) ? args.channels.length : undefined };
				write({ ...base, tool: ev.toolName, callId: ev.toolCallId, swarmArgs });
				break;
			}
			case "tool_execution_end":
				write({ ...base, tool: ev.toolName, callId: ev.toolCallId, isError: ev.isError,
					text: contentText(ev.result?.content).slice(0, 8000) });
				break;
			case "message_end": {
				const m = ev.message;
				if (m.role === "assistant") {
					write({ kind: "usage", id, source, model: `${m.provider}/${m.model}`, cost: m.usage?.cost?.total,
						tokens: usageTokens(m.usage), timestamp: m.timestamp });
					if (id === "Main" && process.env.OMP_SWARM_PAID_HUB === "1") {
						const marker = /\bR9-MAIN-(?:READY|COMPLETE)\b/.exec(contentText(m.content))?.[0];
						if (marker) write({ kind: "response", id, text: marker });
					}
				} else if (m.role === "custom") {
					write({ ...base, customType: m.customType, text: contentText(m.content).slice(0, 8000) });
				}
				break;
			}
			default: return;
		}
		sample();
	};
	const observeRef = (ref: AgentRef, change: string): void => {
		const { id, generation, parentId, status, session, sessionFile } = ref;
		const identity = { id, generation, parentId };
		const k = key(ref);
		if (session && change !== "removed" && !subscriptions.has(k)) {
			subscriptions.set(k, session.subscribe(ev => record(id, "session", ev)));
			if (session instanceof AgentSession) sessions.set(k, { identity, session });
		}
		if (change !== "metadata_changed") write({ kind: "ref", ...identity, change, status,
			attached: session !== null, sessionFile, model: session?.model && `${session.model.provider}/${session.model.id}`,
			effort: session?.thinkingLevel });
		if (change === "removed") {
			subscriptions.get(k)?.();
			subscriptions.delete(k);
		}
		sample();
	};

	pi.on("session_start", (_e, ctx) => {
		if (ctx.agent.kind !== "main" || cleanup) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const artifacts = ctx.sessionManager.getArtifactsDir();
		write({ kind: "root", sessionFile, swarm: sessionFile && artifacts ? join(artifacts, "swarm") : undefined,
			agentDir: getAgentDir(), agentDb: getAgentDbPath(), terminalSessionsDir: getTerminalSessionsDir() });
		const stops = [
			registry.onChange(({ ref, type }) => observeRef(ref, type)),
			pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data: unknown) => {
				const { id, agent, status } = data as SubagentLifecyclePayload;
				write({ kind: "life", id, agent, status });
			}),
			pi.events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data: unknown) => {
				const { progress: p } = data as SubagentProgressPayload;
				if (p.id) write({ kind: "progress", id: p.id, agent: p.agent, status: p.status, tool: p.currentTool,
					intent: p.currentToolIntent, model: p.resolvedModel, effort: p.resolvedThinkingLevel });
			}),
			pi.events.on(TASK_SUBAGENT_EVENT_CHANNEL, (data: unknown) => {
				const { id, event } = data as SubagentEventPayload;
				record(id, "task", event);
			}),
		];
		for (const ref of registry.list()) observeRef(ref, "initial");
		const timer = setInterval(sample, 50);
		timer.unref();
		cleanup = () => {
			sample();
			clearInterval(timer);
			for (const stop of stops) stop();
			for (const stop of subscriptions.values()) stop();
			subscriptions.clear();
			sessions.clear();
		};
	});
	pi.on("session_stop", (_e, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const main = registry.get(ctx.agent.id)?.session;
		write({ kind: "stop", pending: main instanceof AgentSession ? main.wakeSources?.jobs ?? [] : [] });
	});
	pi.on("session_shutdown", () => cleanup?.());
}
