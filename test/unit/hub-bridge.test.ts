import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import type { Effort, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { usageContextTokens } from "@oh-my-pi/pi-coding-agent/session/messages";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	SessionObserverRegistry,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL as LIFE,
	TASK_SUBAGENT_PROGRESS_CHANNEL as PROGRESS,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { HubBridge } from "../../src/runtime/hub-bridge.ts";

const ID = "swarm~parser";
const FILE = "/tmp/hub-test/swarm/sessions/conv.jsonl";

function setup(registry = new AgentRegistry(), id = ID) {
	const bus = new EventBus();
	const observer = new SessionObserverRegistry();
	observer.subscribeToEventBus(bus, bus);
	const frames: (SubagentProgressPayload | SubagentLifecyclePayload)[] = [];
	bus.on(PROGRESS, frame => frames.push(frame as SubagentProgressPayload));
	bus.on(LIFE, frame => frames.push(frame as SubagentLifecyclePayload));
	const ref = registry.register({ id, displayName: "parser", kind: "sub", session: null, status: "running", sessionFile: FILE });
	const model = { resolvedModel: "mock/parser:low", resolvedModelIdentity: "mock/parser", resolvedThinkingLevel: "low" as Effort, contextWindow: 1000 };
	const bridge = new HubBridge({
		id, name: "parser", role: "worker", brief: "Parse\x1b safely", sessionFile: FILE, bus,
		ownsRef: () => registry.get(id) === ref,
		activity: text => registry.setActivity(id, text, ref),
		model: () => ({ ...model }), occupiedContext: usageContextTokens,
	});
	return { bridge, observer, frames, ref, registry, model, bus };
}

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant", api: "openai-completions", provider: "openai", model: "parser", stopReason, timestamp: Date.now(),
		content: [{ type: "thinking", thinking: "INTERNAL-REASONING" }, { type: "text", text }],
		usage: { input: 5, output: 4, cacheWrite: 3, cacheRead: 320, totalTokens: 332, contextTokens: 115,
			cost: { input: 0, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
	};
}

beforeEach(() => vi.useFakeTimers({ now: 10_000 }));
afterEach(() => vi.useRealTimers());

test("native observer sees honest park transitions and correlated parallel tool activity", () => {
	const { bridge, observer, frames, ref, registry } = setup();
	bridge.start(Date.now());
	expect(frames[0]).toMatchObject({ id: ID, status: "started", description: "swarm worker: Parse safely", agent: "parser", agentSource: "project", index: 0, detached: true, sessionFile: FILE });
	expect(frames[1]).toMatchObject({ task: "Parse safely", progress: { id: ID, status: "running", toolCount: 0, requests: 0, tokens: 0, cost: 0, recentOutput: [], recentTools: [], durationMs: 0 } });
	expect(frames[1]).not.toHaveProperty("id");
	bridge.event({ type: "tool_execution_start", toolCallId: "fast-wait", toolName: "swarm_wait", args: {} });
	vi.advanceTimersByTime(150);
	expect(observer.getSession(ID)?.progress?.currentTool).toBe("swarm_wait");
	expect(observer.getSession(ID)?.description).not.toContain("waiting on board");
	bridge.event({ type: "tool_execution_end", toolCallId: "fast-wait", toolName: "swarm_wait", result: "not_parked" });
	bridge.event({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "\x1b\u202eevidence.txt" } });
	bridge.event({ type: "tool_execution_start", toolCallId: "wait", toolName: "swarm_wait", args: {} });
	bridge.setBoardWait("wait", true);
	const parked = observer.getSession(ID)?.progress;
	expect(parked).toMatchObject({ status: "running", currentTool: "swarm_wait", currentToolArgs: "waiting on board", currentToolIntent: "waiting on board", currentToolStartMs: 10_150 });
	expect(ref.activity).toBe("waiting on board");
	expect(observer.getSession(ID)?.status).toBe("active");
	bridge.event({ type: "tool_execution_end", toolCallId: "read", toolName: "read", result: "PRIVATE-TOOL-RESULT", isError: true });
	bridge.setBoardWait("old-wait", false);
	vi.advanceTimersByTime(150);
	expect(observer.getSession(ID)?.progress).toMatchObject({ currentToolArgs: "waiting on board", recentTools: [{ tool: "read", args: "evidence.txt", isError: true, endMs: 10_150 }, { tool: "swarm_wait" }] });
	bridge.setBoardWait("wait", false);
	expect(observer.getSession(ID)?.description).toBe("swarm worker: Parse safely");
	expect(ref.activity).not.toBe("waiting on board");
	bridge.event({ type: "tool_execution_end", toolCallId: "wait", toolName: "swarm_wait", result: "woke" });
	registry.setStatus(ID, "idle", ref);
	bridge.idle();
	expect(observer.getSession(ID)?.status).toBe("completed");
	expect(frames.at(-2)).toMatchObject({ progress: { status: "completed", durationMs: 300, toolCount: 3 } });
	expect(frames.at(-1)).toMatchObject({ status: "completed" });
	expect(parked?.recentTools.map(t => t.tool)).toEqual(["swarm_wait"]);
	expect(JSON.stringify(frames)).not.toContain("PRIVATE-TOOL-RESULT");
	expect(vi.getTimerCount()).toBe(0);
});

test("frames are bounded, coalesced, per-run and fenced by exact ownership", () => {
	const { bridge, observer, frames, ref, registry, model } = setup();
	const sibling = setup(registry, "swarm~parser~2");
	bridge.start(Date.now());
	const message = assistant("unused");
	for (let i = 0; i < 50; i++) {
		bridge.event({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", partial: message, contentIndex: 1, delta: `stream ${i}\n` } });
	}
	vi.advanceTimersByTime(149);
	expect(frames).toHaveLength(2);
	vi.advanceTimersByTime(1);
	expect(frames).toHaveLength(3);
	const streaming = observer.getSession(ID)?.progress;
	expect(streaming).toMatchObject({ streaming: { kind: "text" }, recentOutput: ["stream 49", "stream 48", "stream 47", "stream 46", "stream 45", "stream 44", "stream 43", "stream 42"] });
	for (let i = 0; i < 7; i++) {
		bridge.event({ type: "tool_execution_start", toolCallId: `p${i}`, toolName: "edit", args: { patch: "PATCH-BODY", text: "EDIT-BODY" } });
		bridge.event({ type: "tool_execution_end", toolCallId: `p${i}`, toolName: "edit", result: {} });
	}
	bridge.event({ type: "message_end", message: assistant("first assistant") });
	model.resolvedModel = "mock/parser:high";
	model.resolvedThinkingLevel = "high" as Effort;
	bridge.event({ type: "thinking_level_changed", thinkingLevel: model.resolvedThinkingLevel });
	bridge.event({ type: "message_end", message: assistant(`line one\n${"z".repeat(900)}\x1b\n last\u202e line `, "error") });
	bridge.event({ type: "agent_pause", messages: [], yielded: true, awaiting: true });
	expect(observer.getSession(ID)?.status).toBe("active");
	bridge.idle();
	const finished = observer.getSession(ID)?.progress;
	expect(finished).toMatchObject({ status: "failed", requests: 2, tokens: 24, cost: 0.04, contextTokens: 115, contextWindow: 1000, durationMs: 150,
		resolvedModel: "mock/parser:high", resolvedThinkingLevel: "high", toolCount: 7 });
	expect(finished?.recentTools).toHaveLength(5);
	expect(finished?.recentOutput[0]).toBe("last line");
	expect(finished?.recentOutput[1]).toHaveLength(160);
	expect(streaming?.tokens).toBe(0);
	expect(JSON.stringify(frames)).not.toMatch(/INTERNAL-REASONING|PATCH-BODY|EDIT-BODY|\\u001b|\u202e/);
	expect(observer.getSession(ID)?.status).toBe("failed");
	vi.advanceTimersByTime(500);
	bridge.start(Date.now());
	expect(observer.getSession(ID)?.status).toBe("active");
	expect(observer.getSession(ID)?.progress).toMatchObject({ status: "running", tokens: 0, cost: 0, recentOutput: [], durationMs: 0 });
	bridge.event({ type: "message_end", message: assistant("not published") });
	sibling.bridge.start(Date.now());
	expect(sibling.observer.getSession(ID)).toBeUndefined();
	expect(observer.getSession(sibling.ref.id)).toBeUndefined();
	const count = frames.length;
	registry.unregister(ID, ref);
	registry.register({ id: ID, displayName: "replacement", session: null, kind: "sub", status: "idle" });
	bridge.close(false, () => registry.get(ID) === undefined);
	vi.advanceTimersByTime(150);
	expect(frames).toHaveLength(count);
	expect(vi.getTimerCount()).toBe(0);
	sibling.bridge.close();
});

test("removal during final progress still terminates the observer exactly once", () => {
	const { bridge, observer, frames, registry, ref, bus } = setup();
	bridge.start(Date.now());
	bus.on(PROGRESS, data => {
		if ((data as SubagentProgressPayload).progress.status !== "completed") return;
		registry.unregister(ID, ref);
		bridge.close(false, () => registry.get(ID) === undefined);
	});
	bridge.idle();
	expect(observer.getSession(ID)?.status).toBe("aborted");
	expect(frames.filter(frame => "status" in frame).map(frame => frame.status)).toEqual(["started", "aborted"]);
	expect(vi.getTimerCount()).toBe(0);
});
