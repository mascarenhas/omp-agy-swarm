// Pure projections for the native TUI. All untrusted content becomes literal text, never markup.
import type { DescribeContext, NativeNode, NativeUiEvent, TspSpan } from "@oh-my-pi/pi-tui/native/node";
import type { TspTone } from "@oh-my-pi/pi-wire";
import type { BoardMessage } from "../../board/types.ts";
import type { MemberView } from "../model.ts";
import { sanitize, sanitizeLine } from "../sanitize.ts";

const KINDS = ["col", "row", "text", "kv", "badge", "tabs", "button", "list", "item", "card", "section", "input", "overlay"] as const;
export function nativeKey(cx: DescribeContext): number {
	let key = 0;
	for (const kind of KINDS) key = (key << 1) | Number(cx.supports(kind));
	return key;
}

export function semantic(cx: DescribeContext): boolean {
	return cx.supports("text") && (cx.supports("col") || cx.supports("row"));
}

export class NativeCache {
	#key: string | number | undefined;
	#node: NativeNode | undefined;
	#dependency: NativeNode | undefined;

	get node(): NativeNode | undefined { return this.#node; }

	get(key: string | number, build: () => NativeNode, dependency?: NativeNode): NativeNode {
		if (this.#node && this.#key === key && this.#dependency === dependency) return this.#node;
		this.#key = key;
		this.#dependency = dependency;
		return this.#node = build();
	}
}

/** The host routes by owner even for removed descendants. Require a control we actually described. */
export function presentedEvent(root: NativeNode | undefined, event: NativeUiEvent): boolean {
	let node = root;
	for (const key of event.key.split("/")) {
		node = node?.c?.find((child): child is NativeNode => "k" in child && child.key === key);
		if (!node) return false;
	}
	switch (event.type) {
		case "action": return node?.k === "button" && !node.p?.disabled && node.p?.actions?.click === event.act;
		case "edit":
		case "undo": return node?.k === "input";
		case "toggle": return node?.k === "card" && node.p?.collapsible === true;
		case "select":
		case "activate":
			if (node?.k === "tabs") return node.p?.items.some(item => item.id === event.item) ?? false;
			return node?.k === "list" && (node.c?.some(c => "k" in c && c.k === "item" && c.key === event.item && !c.p?.disabled) ?? false);
		default: return false;
	}
}

export function span(value: unknown, s?: string): TspSpan {
	return { t: sanitize(value), s };
}

export function text(key: string, value: string | readonly TspSpan[], style?: string, role?: string): NativeNode {
	return { k: "text", key, p: { role, spans: typeof value === "string" ? [span(value, style)] : value, wrap: "word" } };
}

export function group(cx: DescribeContext, key: string, c: readonly NativeNode[], role?: string): NativeNode {
	return cx.supports("col") ? { k: "col", key, p: { role, gap: "sm" }, c } : { k: "row", key, p: { role, gap: "sm", wrap: true }, c };
}

export function strip(cx: DescribeContext, key: string, c: readonly NativeNode[], role?: string): NativeNode {
	return cx.supports("row") ? { k: "row", key, p: { role, gap: "sm", align: "center", wrap: true }, c } : group(cx, key, c, role);
}

export function section(cx: DescribeContext, key: string, head: string, c: readonly NativeNode[]): NativeNode {
	return cx.supports("section") ? { k: "section", key, p: { head: [{ t: sanitizeLine(head), s: "strong" }] }, c } : group(cx, key, [text("heading", head, "strong"), ...c]);
}

export function card(cx: DescribeContext, key: string, head: string, c: readonly NativeNode[], collapsed?: boolean): NativeNode {
	if (cx.supports("card")) return { k: "card", key, p: { head: [{ t: sanitizeLine(head), s: "strong" }], collapsible: collapsed !== undefined, collapsed, preview: collapsed ? { lines: 6 } : undefined }, c };
	return section(cx, key, head, c);
}

export function facts(cx: DescribeContext, key: string, entries: readonly (readonly [string, string, string?])[], inline = false): NativeNode {
	if (cx.supports("kv")) return { k: "kv", key, p: { layout: inline ? "inline" : "grid", items: entries.map(([k, v, style]) => ({ k: sanitizeLine(k), v: [span(v, style)] })) } };
	return text(key, entries.map(([k, v]) => `${sanitizeLine(k)}: ${sanitize(v)}`).join(inline ? " · " : "\n"));
}

export function badge(cx: DescribeContext, key: string, label: string, tone: TspTone): NativeNode {
	return cx.supports("badge") ? { k: "badge", key, p: { text: sanitizeLine(label), tone } } : text(key, label, tone);
}

export function button(cx: DescribeContext, id: string, label: string, key?: string, options?: { primary?: boolean; on?: boolean; disabled?: boolean }): NativeNode {
	return cx.supports("button")
		? { k: "button", key: id, p: { text: sanitizeLine(label), keys: key ? [key] : undefined, size: "sm", variant: options?.primary ? "primary" : "quiet", actions: { click: `swarm.${id}` }, on: options?.on, disabled: options?.disabled } }
		: text(id, key ? `${key} ${label}` : label, options?.on ? "strong" : "muted");
}

export type ListItem = Extract<NativeNode, { k: "item" }> & { key: string; p: NonNullable<Extract<NativeNode, { k: "item" }>["p"]> };

export function item(key: string, label: readonly TspSpan[], detail?: readonly TspSpan[], tone?: TspTone): ListItem {
	return { k: "item", key, p: { label, detail, tone } };
}

export function list(cx: DescribeContext, key: string, items: readonly ListItem[], selected: string | undefined, empty: string, maxLines?: number): NativeNode {
	if (!items.length) return text(key, empty, "muted");
	if (cx.supports("list") && cx.supports("item")) return { k: "list", key, p: { selected, max: maxLines === undefined ? undefined : { lines: maxLines }, virtual: items.length > 24 }, c: items };
	return group(cx, key, items.map(({ key, p }) => {
		const label = typeof p.label === "string" ? p.label : p.label.map(s => s.t).join("");
		const detail = typeof p.detail === "string" ? p.detail : p.detail?.map(s => s.t).join("");
		return p.disabled ? text(key, label, "accent strong") : button(cx, key, `${label}${detail ? ` · ${detail}` : ""}`, undefined, { on: key === selected });
	}));
}

/** Domain identifiers are not displayed or interpreted as paths. */
export function id(value: string): string {
	return encodeURIComponent(value.replace(/\p{Surrogate}/gu, "\ufffd"));
}

export function stateTone(state: string): TspTone {
	switch (state) {
		case "working": return "accent";
		case "waiting": return "info";
		case "stopped": return "warning";
		case "failed": return "error";
		case "killed": return "muted";
		default: return "neutral";
	}
}

export function memberFacts(cx: DescribeContext, m: MemberView, swarmDir: string): NativeNode {
	return facts(cx, "member-facts", [
		["Role", m.role], ["State", `${m.failure ? "failed · " : ""}${m.state} · ${m.detail}`],
		["Model", `${m.model || "?"}${m.effort ? ` · ${m.effort}` : ""}`, "mono"], ["Added by", m.addedBy || "—"],
		["Channels", m.channels.join(", ")], ["Activity", m.activity || "—"], ["Wakes on", m.wakeMode],
		["Workspace", `${m.workspace.mode}: ${m.workspace.path}${m.workspace.branch ? ` (${m.workspace.branch})` : ""}${m.workspace.state ? ` [${m.workspace.state}]` : ""}`, "path"],
		...(m.role === "coordinator" ? [["Swarm directory", swarmDir, "path"] as const] : []),
		...(m.workspace.reason ? [["Retained", m.workspace.reason] as const] : []),
		...(m.workspace.cleanup ? [["Cleanup", m.workspace.cleanup] as const] : []),
		["Read cursor", `#${m.lastReadSeq} · ${m.unread} unread · ${m.owed.length} owed${m.owed.length ? `: ${m.owed.map(s => `#${s}`).join(" ")}` : ""}`, "num"],
		["Work", `${m.steps} steps · ${m.posts} posts${m.lastPostSeq ? ` · last #${m.lastPostSeq}` : ""}`, "num"],
		["Spend", `${m.tokens} tokens · $${m.cost.toFixed(4)}`, "num"],
		...(m.briefSeq ? [["Brief", `#${m.briefSeq}`, "num"] as const] : []),
		...(m.task ? [["Task", m.task] as const] : []),
		...(m.sessionFile ? [["Transcript", m.sessionFile, "path"] as const] : []),
		...(m.failure ? [["Failure", `${m.failure.kind}: ${m.failure.text}`, "error"] as const] : []),
	]);
}

export function postSummary(m: BoardMessage): ListItem {
	const fragment = sanitizeLine(m.text.slice(0, 240)).slice(0, 160).replace(/[\ud800-\udbff]$/, "");
	return item(`post:${m.seq}`, [
		span(`#${m.seq} `, "num"), span(m.agent, "strong"), span(` · #${m.channel || "main"}`, "muted"),
		...(m.control ? [span(" · control", "muted")] : []),
	], [span(`${fragment}${m.text.length > 160 ? "…" : ""}`, m.control ? "muted" : undefined)], m.control ? "muted" : undefined);
}

/** The caller sanitizes the full body before shortening or styling it. */
export function postText(clean: string, muted = false): TspSpan[] {
	const spans: TspSpan[] = [];
	let at = 0;
	for (const m of clean.matchAll(/(?<![\w@])(?:@#?[\w-]+|#\d+)/g)) {
		if (m.index > at) spans.push({ t: clean.slice(at, m.index), s: muted ? "muted" : undefined });
		spans.push({ t: m[0], s: muted ? "muted mono" : "accent mono" });
		at = m.index + m[0].length;
	}
	if (at < clean.length) spans.push({ t: clean.slice(at), s: muted ? "muted" : undefined });
	return spans;
}
