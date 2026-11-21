// The status widget: one width-aware line under the editor, coalesced to ≤ 4 updates per second.

import { project, type SwarmReadModel } from "../model.ts";
import { fit, sanitizeLine } from "../sanitize.ts";
import type { TuiLike } from "./overlay.ts";

export function widgetLine(model: SwarmReadModel): string {
	if (model.stalled()) return "swarm · stalled — waiting for you · /swarm";
	const outcome = model.outcome();
	if (outcome?.value === "complete" || outcome?.value === "complete_with_abandonment") return `swarm · complete · #${model.head} · /swarm`;
	if (outcome?.value === "incomplete") return `swarm · incomplete · #${model.head} · /swarm`;
	const restored = model.restored();
	const v = project(model);
	if (restored && v.counts.working === 0) return `swarm · restored: ${restored.stopped} stopped, ${restored.owed} owed · /swarm`;
	const c = v.counts;
	const counts = [`●${c.working}`, `○${c.waiting}`, c.stopped ? `◌${c.stopped}` : "", c.failed ? `✗${c.failed}` : ""].filter(Boolean).join(" ");
	const unread = model.members().find(m => m.role === "coordinator")?.unread ?? 0;
	const title = sanitizeLine(model.title);
	return `swarm${title ? ` · ${title}` : ""} · ${counts} · #${model.head}${unread ? ` · ${unread} unread` : ""} · /swarm`;
}

export function widgetComponent(model: SwarmReadModel, tui: TuiLike) {
	let timer: Timer | undefined;
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
			return [fit(widgetLine(model), width)];
		},
		dispose(): void {
			unsubscribe();
			clearTimeout(timer);
		},
	};
}
