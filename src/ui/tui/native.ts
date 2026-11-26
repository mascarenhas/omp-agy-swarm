// Pure projections for the native TUI. All untrusted content becomes literal text, never markup.
import { jsx, type JSX, type JSXNode, nativeSupports, type UiKind, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { BoardMessage } from "../../board/types.ts";
import { type MemberView, spendText } from "../model.ts";
import { sanitize, sanitizeLine } from "../sanitize.ts";

export function node<K extends UiKind>(kind: K, key: string, props: JSX.IntrinsicElements[K]): UiNode<K> {
	// The JSX runtime always returns a UiNode of this kind for a lowercase tag.
	return jsx(kind, { ...props }, key) as UiNode<K>;
}

export function span(value: unknown, s?: string): TspSpan {
	return { t: sanitize(value), s };
}

export function text(key: string, value: string | readonly TspSpan[] | (() => readonly TspSpan[]), style?: string, role?: string): UiNode<"text"> {
	return node("text", key, { role, spans: typeof value === "string" ? [span(value, style)] : value, wrap: "word" });
}

export function col(key: string, children: JSXNode, role?: string, reveal?: JSX.IntrinsicElements["col"]["reveal"]): UiNode<"col"> {
	return node("col", key, { role, gap: "sm", children, reveal });
}

export function row(key: string, children: JSXNode): UiNode {
	return nativeSupports("row") ? node("row", key, { gap: "sm", align: "center", wrap: true, children }) : col(key, children);
}

export function section(key: string, head: string, children: JSXNode): UiNode {
	return nativeSupports("section") ? node("section", key, { head: [span(sanitizeLine(head), "strong")], children }) : col(key, [text("heading", sanitizeLine(head), "strong"), children]);
}

export function card(key: string, head: string, children: JSXNode, fold?: { collapsed: boolean; toggle: (collapsed: boolean) => void }): UiNode {
	return nativeSupports("card")
		? node("card", key, { head: [span(sanitizeLine(head), "strong")], children, collapsible: !!fold, collapsed: fold?.collapsed, preview: fold?.collapsed ? { lines: 6 } : undefined, onToggle: fold?.toggle })
		: section(key, head, children);
}

export function facts(key: string, entries: readonly (readonly [string, string, string?])[], inline = false): UiNode {
	return nativeSupports("kv")
		? node("kv", key, { layout: inline ? "inline" : "grid", items: entries.map(([k, v, style]) => ({ k: sanitizeLine(k), v: [span(v, style)] })) })
		: text(key, entries.map(([k, v]) => `${sanitizeLine(k)}: ${sanitize(v)}`).join(inline ? " · " : "\n"));
}

export function badge(key: string, label: string, tone: TspTone): UiNode {
	return nativeSupports("badge") ? node("badge", key, { text: sanitizeLine(label), tone }) : text(key, label, tone);
}

export function button(key: string, label: string, shortcut: string | undefined, click: () => void, options?: { primary?: boolean; on?: boolean; disabled?: boolean }): UiNode {
	const act = `swarm.${key}`;
	return nativeSupports("button")
		? node("button", key, { text: sanitizeLine(label), keys: shortcut ? [shortcut] : undefined, size: "sm",
			variant: options?.primary ? "primary" : "quiet", actions: { click: act }, on: options?.on, disabled: options?.disabled,
			onAction: action => { if (!options?.disabled && action === act) click(); } })
		: text(key, shortcut ? `${shortcut} ${label}` : label, options?.on ? "strong" : "muted");
}

export function item(key: string, label: readonly TspSpan[], detail?: readonly TspSpan[], tone?: TspTone, disabled?: boolean): UiNode<"item"> {
	return node("item", key, { label, detail, tone, disabled });
}

export function list(key: string, items: readonly UiNode<"item">[], selected: string | undefined, empty: string, choose: (item: string, activate: boolean) => void, maxLines?: number): UiNode {
	if (!items.length) return text(key, empty, "muted");
	const pick = (item: string, activate: boolean): void => {
		if (items.some(n => n.key() === item && !n.props().disabled)) choose(item, activate);
	};
	if (nativeSupports("list") && nativeSupports("item")) return node("list", key, {
		selected, max: maxLines === undefined ? undefined : { lines: maxLines }, virtual: items.length > 24,
		children: items, onSelect: item => pick(item, false), onActivate: item => pick(item, true),
	});
	return col(key, items.map(n => {
		const { label, detail, disabled } = n.props();
		const plain = (value: string | readonly TspSpan[]) => typeof value === "string" ? value : value.map(s => s.t).join("");
		const id = n.key()!;
		return disabled ? text(id, plain(label), "accent strong")
			: button(id, `${plain(label)}${detail ? ` · ${plain(detail)}` : ""}`, undefined, () => pick(id, false), { on: id === selected });
	}));
}

export function tabs<Key extends string>(items: readonly { id: Key; label: string }[], active: Key, select: (key: Key) => void): UiNode {
	const pick = (id: string): void => {
		const tab = items.find(item => item.id === id);
		if (tab) select(tab.id);
	};
	// Tern paints a patched active tab one frame late. Remount only the tabs on a switch.
	return nativeSupports("tabs") ? node("tabs", `tabs:${active}`, {
		items, active, variant: "underline", onSelect: pick, onActivate: pick,
	}) : row("tabs", items.map((tab, i) => button(tab.id, tab.label.slice(2), String(i + 1), () => select(tab.id), { on: tab.id === active })));
}

export function input(key: string, props: JSX.IntrinsicElements["input"]): UiNode<"input"> {
	return node("input", key, props);
}

export function overlay(key: string, props: JSX.IntrinsicElements["overlay"]): UiNode<"overlay"> {
	return node("overlay", key, props);
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

export function memberFacts(m: MemberView, swarmDir: string): UiNode {
	return facts("member-facts", [
		["Role", m.role], ["State", `${m.failure ? "failed · " : ""}${m.state} · ${m.detail}`],
		["Model", `${m.model || "?"}${m.effort ? ` · ${m.effort}` : ""}`, "mono"], ["Added by", m.addedBy || "—"],
		["Channels", m.channels.join(", ")], ["Activity", m.activity || "—"], ["Wakes on", m.wakeMode],
		["Workspace", `${m.workspace.mode}: ${m.workspace.path}${m.workspace.branch ? ` (${m.workspace.branch})` : ""}${m.workspace.state ? ` [${m.workspace.state}]` : ""}`, "path"],
		...(m.role === "coordinator" ? [["Swarm directory", swarmDir, "path"] as const] : []),
		...(m.workspace.reason ? [["Retained", m.workspace.reason] as const] : []),
		...(m.workspace.cleanup ? [["Cleanup", m.workspace.cleanup] as const] : []),
		["Read cursor", `#${m.lastReadSeq} · ${m.unread} unread · ${m.owed.length} owed${m.owed.length ? `: ${m.owed.map(s => `#${s}`).join(" ")}` : ""}`, "num"],
		["Work", `${m.steps} steps · ${m.posts} posts${m.lastPostSeq ? ` · last #${m.lastPostSeq}` : ""}`, "num"],
		["Spend", spendText(m), "num"],
		...(m.briefSeq ? [["Brief", `#${m.briefSeq}`, "num"] as const] : []),
		...(m.task ? [["Task", m.task] as const] : []),
		...(m.sessionFile ? [["Transcript", m.sessionFile, "path"] as const] : []),
		...(m.failure ? [["Failure", `${m.failure.kind}: ${m.failure.text}`, "error"] as const] : []),
	]);
}

export function postSummary(m: BoardMessage): UiNode<"item"> {
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
