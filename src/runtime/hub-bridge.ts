// Presentation only: the board's delivery, receipts and spend never depend on these frames.
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task/session-observer-registry";
import { describeToolCall, oneLine } from "./activity.ts";

type Progress = SubagentProgressPayload["progress"];
type Finished = "completed" | "failed" | "aborted";
type ModelView = Pick<Progress, "resolvedModel" | "resolvedModelIdentity" | "resolvedThinkingLevel" | "resolvedModelIsFallback" | "contextWindow">;
type Tool = { tool: string; args: string; startedAt: number };
const INTERVAL = 150;
const OUTPUT_TAIL = 2048;
const WAITING = "waiting on board";
const finite = (n: number | undefined): number => n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;

interface BridgeOptions {
	id: string;
	name: string;
	role: string;
	brief: string;
	sessionFile: string | undefined;
	bus: { emit(channel: string, payload: unknown): void };
	ownsRef(): boolean;
	activity(text: string): void;
	model(): ModelView;
	occupiedContext(usage: unknown): number;
}

export class HubBridge {
	readonly #o: BridgeOptions;
	readonly #frame: Pick<SubagentProgressPayload, "index" | "agent" | "agentSource" | "sessionFile" | "detached">;
	readonly #task: string;
	readonly #description: string;
	readonly #calls = new Map<string, Tool>();
	#recentTools: Progress["recentTools"] = [];
	#output = "";
	#partial = "";
	#streaming: Progress["streaming"];
	#waiting: { id: string; startedAt: number } | undefined;
	#model: ModelView;
	#contextTokens: number | undefined;
	#requests = 0;
	#toolCount = 0;
	#tokens = 0;
	#cost = 0;
	#runStart: number | undefined;
	#endedAt: number | undefined;
	#status: Progress["status"] = "pending";
	#observerActive = false;
	#outcome: Finished = "completed";
	#lastFlush = -Infinity;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;

	constructor(options: BridgeOptions) {
		this.#o = options;
		this.#task = oneLine(options.brief.slice(0, 240), 160);
		this.#description = this.#task ? `swarm ${options.role}: ${this.#task}` : `swarm ${options.role}`;
		this.#frame = { index: 0, agent: options.name, agentSource: "project", sessionFile: options.sessionFile, detached: true };
		this.#model = options.model();
	}

	start(at: number): void {
		if (this.#closed || this.#status === "running" || !this.#o.ownsRef()) return;
		this.#runStart = at;
		this.#endedAt = undefined;
		this.#status = "running";
		this.#outcome = "completed";
		this.#toolCount = this.#requests = this.#tokens = this.#cost = 0;
		this.#contextTokens = undefined;
		this.#recentTools = [];
		this.#output = this.#partial = "";
		this.#model = this.#o.model();
		this.#lifecycle("started");
		this.#flush();
	}

	idle(): void {
		if (this.#status === "running") this.#finish(this.#outcome);
	}

	close(killed = false, removedIdVacant?: () => boolean): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#cancelFlush();
		if (this.#observerActive || killed) this.#finish("aborted", removedIdVacant);
	}

	setBoardWait(waitId: string, waiting: boolean): void {
		if (this.#closed || this.#status !== "running") return;
		if (waiting) this.#waiting = { id: waitId, startedAt: Date.now() };
		else if (this.#waiting?.id === waitId) this.#waiting = undefined;
		else return;
		this.#flush();
	}

	event(event: AgentSessionEvent): void {
		if (this.#closed || !this.#o.ownsRef()) return;
		switch (event.type) {
			case "model_changed":
			case "thinking_level_changed":
			case "retry_fallback_applied":
				if (this.#refreshModel() && this.#status !== "pending") this.#schedule();
				return;
		}
		if (this.#status !== "running") return;
		switch (event.type) {
			case "tool_execution_start": {
				const tool = oneLine(event.toolName.slice(0, 64), 48);
				const preview = describeToolCall(tool, event.args, true);
				const args = preview === tool ? "" : preview.slice(tool.length + 2);
				// Agent tool batches are normally small; never retain arbitrarily many previews.
				if (this.#calls.size === 64) {
					const oldest = this.#calls.keys().next().value;
					if (oldest !== undefined) this.#calls.delete(oldest);
				}
				this.#calls.set(event.toolCallId, { tool, args, startedAt: Date.now() });
				this.#streaming = undefined;
				this.#toolCount++;
				break;
			}
			case "tool_execution_end": {
				const call = this.#calls.get(event.toolCallId);
				this.#calls.delete(event.toolCallId);
				const tool = call?.tool ?? oneLine(event.toolName.slice(0, 64), 48);
				this.#recentTools = [{ tool, args: call?.args ?? "", endMs: Date.now(), isError: event.isError }, ...this.#recentTools.slice(0, 4)];
				break;
			}
			case "message_update": {
				if (event.message.role !== "assistant") return;
				const delta = event.assistantMessageEvent;
				if (delta.type === "text_delta") {
					this.#partial = (this.#partial + delta.delta.slice(-OUTPUT_TAIL)).slice(-OUTPUT_TAIL);
					this.#streaming = { kind: "text" };
				} else if (delta.type === "thinking_start" || delta.type === "thinking_delta") {
					this.#streaming = { kind: "thinking" };
				} else if (delta.type === "toolcall_end") {
					this.#streaming = { kind: "call", tool: oneLine(delta.toolCall.name.slice(0, 64), 48) };
				} else return;
				break;
			}
			case "message_end": {
				const m = event.message;
				if (m.role !== "assistant") return;
				this.#requests++;
				const usage = m.usage;
				if (usage) {
					this.#tokens += usage.input !== undefined || usage.output !== undefined || usage.cacheWrite !== undefined
						? finite(usage.input) + finite(usage.output) + finite(usage.cacheWrite) : finite(usage.totalTokens);
					this.#cost += finite(usage.cost?.total);
					const occupied = this.#o.occupiedContext(usage);
					if (occupied > 0) this.#contextTokens = occupied;
				}
				let tail = "";
				for (let i = m.content.length - 1; i >= Math.max(0, m.content.length - 16) && tail.length < OUTPUT_TAIL; i--) {
					const block = m.content[i];
					if (block?.type === "text") tail = block.text.slice(tail.length - OUTPUT_TAIL) + tail;
				}
				if (tail) this.#output = `${this.#output}\n${tail}`.slice(-OUTPUT_TAIL);
				this.#partial = "";
				this.#streaming = undefined;
				this.#outcome = m.stopReason === "aborted" ? "aborted" : m.stopReason === "error" ? "failed" : "completed";
				this.#refreshModel();
				break;
			}
			default:
				return;
		}
		this.#schedule();
	}

	#refreshModel(): boolean {
		const before = this.#model;
		const after = this.#o.model();
		if (before.resolvedModel === after.resolvedModel && before.resolvedModelIdentity === after.resolvedModelIdentity
			&& before.resolvedThinkingLevel === after.resolvedThinkingLevel && before.resolvedModelIsFallback === after.resolvedModelIsFallback
			&& before.contextWindow === after.contextWindow) return false;
		this.#model = after;
		return true;
	}

	#cancelFlush(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(): void {
		if (this.#timer) return;
		const delay = this.#lastFlush + INTERVAL - Date.now();
		if (delay <= 0) this.#flush();
		else {
			this.#timer = setTimeout(() => this.#flush(), delay);
			this.#timer.unref?.();
		}
	}

	#lifecycle(status: SubagentLifecyclePayload["status"], removedIdVacant?: () => boolean): void {
		if (removedIdVacant ? !removedIdVacant() : !this.#o.ownsRef()) return;
		this.#observerActive = status === "started";
		this.#o.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...this.#frame, id: this.#o.id, description: this.#description, status } satisfies SubagentLifecyclePayload);
	}

	#finish(outcome: Finished, removedIdVacant?: () => boolean): void {
		this.#status = outcome;
		this.#endedAt ??= Date.now();
		this.#calls.clear();
		this.#waiting = undefined;
		this.#streaming = undefined;
		// Exact removal can terminate the row without publishing progress or
		// activity. Ordinary finishes independently check ownership at both emits.
		if (!removedIdVacant) this.#flush();
		this.#lifecycle(outcome, removedIdVacant);
	}

	#flush(): void {
		this.#cancelFlush();
		if (!this.#o.ownsRef()) return;
		const now = this.#lastFlush = Date.now();
		let call: Tool | undefined;
		for (const active of this.#calls.values()) call = active;
		const waiting = this.#waiting;
		if (waiting) call = { tool: "swarm_wait", args: WAITING, startedAt: waiting.startedAt };
		if (this.#status === "running") {
			this.#o.activity(waiting ? WAITING : call ? (call.args ? `${call.tool}: ${call.args}` : call.tool) : this.#streaming?.kind === "thinking" ? "thinking" : this.#streaming ? "responding" : "working");
		}
		const lines = `${this.#output}\n${this.#partial}`.slice(-OUTPUT_TAIL).split(/\r?\n/);
		const recentOutput: string[] = [];
		for (let i = lines.length - 1; i >= 0 && recentOutput.length < 8; i--) {
			const line = oneLine(lines[i] ?? "", 160);
			if (line) recentOutput.push(line);
		}
		const progress: Progress = {
			index: this.#frame.index, agent: this.#frame.agent, agentSource: this.#frame.agentSource,
			id: this.#o.id, status: this.#status, task: this.#task,
			description: waiting ? `${this.#description} — ${WAITING}` : this.#description,
			currentTool: call?.tool, currentToolArgs: call?.args, currentToolStartMs: call?.startedAt,
			currentToolIntent: waiting ? WAITING : undefined,
			streaming: this.#streaming, recentTools: this.#recentTools, recentOutput,
			toolCount: this.#toolCount, requests: this.#requests, tokens: this.#tokens, cost: this.#cost,
			contextTokens: this.#contextTokens, ...this.#model,
			durationMs: this.#runStart === undefined ? 0 : Math.max(0, (this.#endedAt ?? now) - this.#runStart),
		};
		this.#o.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, { ...this.#frame, task: this.#task, progress } satisfies SubagentProgressPayload);
	}
}
