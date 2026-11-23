// One-line renderCall/renderResult for the main-session tools (§10.3).

import { fit, sanitizeLine } from "../ui/sanitize.ts";

export interface LineComponent {
	render(width: number): string[];
}

export function lineComponent(text: string): LineComponent {
	const line = sanitizeLine(text);
	return { render: (w: number) => [fit(line, w)] };
}

function shortModel(m: unknown): string {
	const s = typeof m === "string" ? m : "";
	return s.includes("/") ? s.slice(s.indexOf("/") + 1) : s;
}

export function callLine(tool: string, args: Record<string, unknown>): string {
	const name = typeof args.name === "string" ? args.name.trim() : "";
	const channel = typeof args.channel === "string" ? args.channel.trim() : "";
	switch (tool) {
		case "swarm": {
			const a = String(args.action ?? "");
			const effort = args.effort === "omit" ? undefined : args.effort;
			if (a === "add") {
				const bits = [shortModel(args.model), effort, args.workspace !== "inherit" && args.workspace !== "omit" && args.workspace]
					.filter(Boolean)
					.join(" · ");
				const who = args.role && args.role !== "worker" && args.role !== "omit" ? String(args.role) : name;
				return `swarm add ${who}${bits ? ` (${bits})` : ""}`;
			}
			if (a === "model") return `swarm model ${name || "self"} → ${shortModel(args.model) || ""}${effort ? ` · ${effort}` : ""}`;
			if (a === "channel") return `swarm channel ${args.op === "omit" ? "" : args.op ?? ""} ${channel ? `#${channel}` : ""}`;
			return `swarm ${a}${name ? ` ${name}` : ""}`;
		}
		case "post_message": {
			const text = String(args.text ?? "");
			const to = text.match(/^\s*(@[#\w-]+)/)?.[1] ?? "";
			return `post${to ? ` → ${to}` : ""}${channel ? ` · #${channel}` : ""}`;
		}
		case "read_board":
			return args.status ? "read_board status" : `read_board${channel ? ` #${channel}` : ""}${typeof args.since === "number" ? ` after #${args.since}` : ""}`;
		case "swarm_wait":
			return `swarm_wait${args.mentions_only === false ? " (any post)" : ""}${args.timeout_seconds ? ` ≤${args.timeout_seconds}s` : ""}`;
		default:
			return tool;
	}
}

export function resultLine(tool: string, details: Record<string, unknown> | undefined): string {
	if (!details) return "";
	if (typeof details.error === "string") return `error: ${details.error}`;
	switch (tool) {
		case "post_message": {
			const woke = Array.isArray(details.woke) && details.woke.length ? ` woke ${details.woke.join(", ")}` : "";
			return `post #${details.seq}${woke}${details.completion ? ` · ${details.completion}` : ""}`;
		}
		case "read_board": {
			const msgs = Array.isArray(details.messages) ? (details.messages as { seq: number }[]) : [];
			if (Array.isArray(details.members)) return `${details.members.length} members`;
			if (!msgs.length) return "no new posts";
			return `read_board #${msgs[0]?.seq}–#${msgs[msgs.length - 1]?.seq}${details.more ? " (more)" : ""}`;
		}
		case "swarm_wait": {
			const msgs = Array.isArray(details.messages) ? (details.messages as { seq: number }[]) : [];
			const by = msgs.length ? ` by #${msgs[msgs.length - 1]?.seq}` : "";
			return `swarm_wait … woke${by} (${details.woke})`;
		}
		case "swarm": {
			if (Array.isArray(details.added)) return `added ${(details.added as { name: string }[]).map(a => a.name).join(", ") || "nobody"}`;
			if (Array.isArray(details.killed)) return `killed ${(details.killed as string[]).join(", ")}`;
			if (Array.isArray(details.members)) return `${details.members.length} members · ${details.completion ?? ""}`;
			if (details.completion) return String(details.completion);
			return "";
		}
		default:
			return "";
	}
}
