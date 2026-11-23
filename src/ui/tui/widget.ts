// The status widget: one width-aware line under the editor, coalesced to ≤ 4 updates per second.

import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { countMembers, type SwarmReadModel } from "../model.ts";
import { fit, sanitizeLine, width } from "../sanitize.ts";
import { NativeCache, span, text } from "./native.ts";
import type { TuiLike } from "./overlay.ts";

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
	const label = `swarm · ${webUrl}`;
	if (columns === undefined) return `${label} · ${widgetDetail(model)}`;
	const room = columns - width(label);
	if (room < 0) return fit(webUrl, columns); // Drop the label before cutting the address.
	if (room < 5) return label; // No room for a separator and useful detail.
	const detailBudget = room - 3;
	return `${label} · ${fit(widgetDetail(model, detailBudget), detailBudget)}`;
}

export function widgetComponent(model: SwarmReadModel, tui: TuiLike, webUrl: () => string | undefined) {
	let timer: Timer | undefined;
	const native = new NativeCache();
	const unsubscribe = model.onChange(() => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			tui.requestRender();
		}, 250);
		timer.unref?.();
	});
	return {
		render(width: number): string[] {
			return [widgetLine(model, webUrl(), width)];
		},
		describe(cx: DescribeContext): NativeNode | null {
			if (!cx.supports("text")) return null;
			const link = webUrl();
			return native.get(`${model.version}|${link ?? ""}`, () => text("widget", [
				span("Swarm", "strong"), ...(link ? [span(` · ${link}`, "mono")] : []), span(` · ${widgetDetail(model, undefined, true)}`, "muted"),
			], undefined, "omp.swarm.widget"));
		},
		dispose(): void {
			unsubscribe();
			clearTimeout(timer);
		},
	};
}
