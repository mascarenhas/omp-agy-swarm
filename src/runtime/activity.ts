// Session events → steps, activity line, last response's tool-call ids (batch rule) and spend.
// No transcript polling: everything comes from host events (§3.6).

import { LIMITS } from "../env.ts";
import type { ContentBlock, HostMessage } from "./ports.ts";

function oneLine(s: string, max: number): string {
	// Strip control characters (C0/C1, ESC) and bidi overrides; collapse whitespace.
	const clean = s
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const KEY_ARGS = ["command", "path", "file_path", "pattern", "query", "url", "text", "action", "name", "code"];

/** `<tool>: <key argument>` (≤ 96 characters, sanitized). */
export function describeToolCall(toolName: string, args: unknown): string {
	let key = "";
	if (args && typeof args === "object") {
		const a = args as Record<string, unknown>;
		for (const k of KEY_ARGS) {
			const v = a[k];
			if (typeof v === "string" && v.trim()) {
				key = v;
				break;
			}
		}
	}
	return oneLine(key ? `${toolName}: ${key}` : toolName, LIMITS.activityChars);
}

export function messageText(m: HostMessage | undefined): string {
	if (!m) return "";
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter((c: ContentBlock) => c.type === "text" && typeof c.text === "string")
		.map(c => c.text)
		.join("");
}

export function toolCallIds(m: HostMessage): string[] {
	if (!Array.isArray(m.content)) return [];
	return m.content.filter((c: ContentBlock) => c.type === "toolCall" && typeof c.id === "string").map(c => c.id as string);
}

export class ActivityTracker {
	steps = 0;
	activity = "";
	activityKind: "" | "tool" | "thinking" = "";
	lastEventAt = 0;
	/** Tool-call ids of the newest assistant response, in emitted order (H12). */
	lastResponse: string[] = [];
	/** Recent responses (id → its call list) so a late lookup still finds its batch. */
	readonly #responses = new Map<string, string[]>();

	touch(now = Date.now()): void {
		this.lastEventAt = now;
	}

	onAssistant(message: HostMessage): void {
		const ids = toolCallIds(message);
		this.lastResponse = ids;
		for (const id of ids) this.#responses.set(id, ids);
		if (this.#responses.size > 256) {
			const drop = [...this.#responses.keys()].slice(0, this.#responses.size - 256);
			for (const k of drop) this.#responses.delete(k);
		}
		if (ids.length === 0 && Array.isArray(message.content)) {
			const thinking = message.content.find((c: ContentBlock) => c.type === "thinking" && typeof c.thinking === "string");
			if (thinking?.thinking) {
				this.activity = oneLine(thinking.thinking.split("\n")[0] ?? "", LIMITS.activityChars);
				this.activityKind = "thinking";
			}
		}
	}

	onToolStart(toolName: string, args: unknown): void {
		this.activity = describeToolCall(toolName, args);
		this.activityKind = "tool";
	}

	onRetry(attempt: number, max: number, error: string): void {
		this.activity = oneLine(`retrying ${attempt}/${max}: ${error}`, LIMITS.activityChars);
		this.activityKind = "tool";
	}

	onRunEnd(): void {
		this.activity = "";
		this.activityKind = "";
	}

	/** The batch (tool-call ids in emitted order) a call belongs to, if known. */
	batchOf(toolCallId: string): string[] | undefined {
		return this.#responses.get(toolCallId);
	}
}
