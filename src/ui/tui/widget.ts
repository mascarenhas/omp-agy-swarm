// The status widget: one width-aware line under the editor, coalesced to ≤ 4 updates per second.

import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import { nativeRendering, onCleanup, signal, type Signal, type UiNode } from "@oh-my-pi/pi-tui";
import { countMembers, type SwarmReadModel } from "../model.ts";
import { fit, sanitizeLine, width } from "../sanitize.ts";
import { col, node, span, text } from "./native.ts";

export type WidgetLink = Signal<string | undefined>;
export const createWidgetLink = signal<string | undefined>;

function widgetDetail(model: SwarmReadModel, budget?: number, native = false): string {
	if (model.stalled()) return "stalled — waiting for you · /swarm";
	const outcome = model.outcome();
	if (outcome?.value === "complete" || outcome?.value === "complete_with_abandonment") return `complete · #${model.head} · /swarm`;
	if (outcome?.value === "incomplete") return `incomplete · #${model.head} · /swarm`;
	const restored = model.restored();
	const members = model.members();
	const c = countMembers(members);
	if (restored && c.working === 0) return `restored: ${restored.stopped} stopped, ${restored.owed} owed · /swarm`;
	const counts = native
		? [`${c.working} working`, `${c.waiting} waiting`, c.stopped ? `${c.stopped} stopped` : "", c.failed ? `${c.failed} failed` : ""].filter(Boolean).join(" · ")
		: [`●${c.working}`, `○${c.waiting}`, c.stopped ? `◌${c.stopped}` : "", c.failed ? `✗${c.failed}` : ""].filter(Boolean).join(" ");
	const unread = members.find(m => m.role === "coordinator")?.unread ?? 0;
	const state = `${counts} · #${model.head}${unread ? ` · ${unread} unread` : ""} · /swarm`;
	let title = sanitizeLine(model.title);
	if (title && budget !== undefined) {
		// Shorten or drop the title before cutting the counts, progress, and command hint.
		const titleBudget = budget - width(state) - 3;
		title = titleBudget >= 2 ? fit(title, titleBudget) : "";
	}
	return title ? `${title} · ${state}` : state;
}

export function widgetLine(model: SwarmReadModel, webUrl?: string, columns?: number): string {
	if (webUrl === undefined) {
		const line = `swarm · ${widgetDetail(model)}`;
		return columns === undefined ? line : fit(line, columns);
	}
	webUrl = sanitizeLine(webUrl);
	const label = `swarm · ${webUrl}`;
	if (columns === undefined) return `${label} · ${widgetDetail(model)}`;
	const room = columns - width(label);
	if (room < 0) return fit(webUrl, columns); // Drop the label before cutting the address.
	if (room < 5) return label; // No room for a separator and useful detail.
	const detailBudget = room - 3;
	return `${label} · ${fit(widgetDetail(model, detailBudget), detailBudget)}`;
}

export function widgetComponent(
	model: SwarmReadModel,
	_ui: ExtensionUiHost,
	webUrl: () => string | undefined,
): UiNode {
	let timer: Timer | undefined;
	const revision = signal(0);
	const unsubscribe = model.onChange(() => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			revision.update(n => n + 1);
		}, 250);
		timer.unref?.();
	});
	const widget = col("swarm-status", () => nativeRendering()
		? text("widget", () => {
			revision();
			const link = sanitizeLine(webUrl());
			return [span("Swarm", "strong"), ...(link ? [span(` · ${link}`, "mono")] : []), span(` · ${widgetDetail(model, undefined, true)}`, "muted")];
		}, undefined, "omp.swarm.widget")
		: node("canvas", "widget", { paint: width => { revision(); return [widgetLine(model, webUrl(), width)]; } }));
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		clearTimeout(timer);
	};
	onCleanup(dispose);
	widget.onDispose(dispose);
	return widget;
}
