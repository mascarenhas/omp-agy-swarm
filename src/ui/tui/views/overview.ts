// Overview: goal and where it stands, outcome threads, attention, reel captions (§10.1).

import { project } from "../../model.ts";
import { fit, pad, sanitizeLine } from "../../sanitize.ts";
import { GLYPH, type OpenTarget, type View, type ViewHost } from "../view.ts";

interface Line {
	text: string;
	target?: OpenTarget;
}

export class OverviewView implements View {
	readonly #host: ViewHost;
	#sel = 0;
	#top = 0;

	constructor(host: ViewHost) {
		this.#host = host;
	}

	#lines(width: number): Line[] {
		const { model, theme } = this.#host;
		const v = project(model);
		const out: Line[] = [];
		const restored = model.restored();
		out.push({ text: theme.bold(`Goal: ${sanitizeLine(v.goal)}`) });
		if (v.empty) {
			out.push({ text: "No members yet. The coordinator adds workers with swarm{action:\"add\"}." });
			return out;
		}
		if (restored) out.push({ text: theme.fg("warning", `Restored after a restart: ${restored.stopped} stopped, ${restored.owed} with unread posts (swarm revive)`) });
		const files = model.files();
		if (!files.plan && !files.view) out.push({ text: theme.fg("muted", "No plan.json and no narrator: showing every task member.") });
		for (const t of v.threads) {
			out.push({ text: theme.fg("accent", `▸ ${sanitizeLine(t.title)}`) });
			const nameW = Math.min(16, Math.max(6, ...t.rows.map(r => r.owner.length)));
			for (const r of t.rows) {
				const glyph = GLYPH[r.state] ?? "·";
				const label = `  ${glyph} ${pad(sanitizeLine(r.owner), nameW)} `;
				const rest = r.result ? `${sanitizeLine(r.title)} — ${sanitizeLine(r.result)}` : sanitizeLine(r.title) || r.state;
				out.push({ text: fit(label + rest, width), target: { member: r.owner } });
			}
		}
		if (v.attention.length) {
			for (const a of v.attention) {
				const color = a.kind === "blocked" || a.kind === "unaddressed" || a.kind === "owed" ? "warning" : "error";
				out.push({
					text: theme.fg(color, `! ${sanitizeLine(a.text)}${a.detail ? ` — ${sanitizeLine(a.detail)}` : ""}`),
					target: a.seq ? { seq: a.seq } : a.member ? { member: a.member } : undefined,
				});
			}
		}
		for (const f of v.reel.slice(-8)) out.push({ text: theme.fg("muted", `▣ #${f.seq} ${sanitizeLine(f.caption || f.path)}`), target: f.seq ? { seq: f.seq } : undefined });
		out.push({ text: theme.fg(v.stateLine.startsWith("incomplete") ? "error" : "muted", sanitizeLine(v.stateLine)) });
		return out;
	}

	render(width: number, rows: number): string[] {
		const lines = this.#lines(width);
		const selectable = lines.map((l, i) => (l.target ? i : -1)).filter(i => i >= 0);
		if (this.#sel >= selectable.length) this.#sel = Math.max(0, selectable.length - 1);
		const selLine = selectable[this.#sel] ?? -1;
		if (selLine >= 0) {
			if (selLine < this.#top) this.#top = selLine;
			if (selLine >= this.#top + rows) this.#top = selLine - rows + 1;
		}
		this.#top = Math.max(0, Math.min(this.#top, Math.max(0, lines.length - rows)));
		const out: string[] = [];
		for (let i = this.#top; i < this.#top + rows; i++) {
			const l = lines[i];
			if (!l) out.push("");
			else out.push(i === selLine ? this.#host.theme.inverse(pad(sanitizeLine(l.text), width)) : fit(l.text, width));
		}
		return out;
	}

	status(): string {
		const n = project(this.#host.model).attention.length;
		return n ? `attention ${n} · Enter opens` : "Enter opens the selected row";
	}

	hints(): string[] {
		return ["↑↓", "Enter", "1-4", "?", "q"];
	}

	capturing(): boolean {
		return false;
	}

	show(): void {}

	handleInput(data: string): boolean {
		const { keys } = this.#host;
		if (keys.up(data)) {
			this.#sel = Math.max(0, this.#sel - 1);
			return true;
		}
		if (keys.down(data)) {
			this.#sel++;
			return true;
		}
		if (keys.confirm(data)) {
			const lines = this.#lines(200);
			const target = lines.filter(l => l.target)[this.#sel]?.target;
			if (target?.seq) this.#host.open("board", { seq: target.seq });
			else if (target?.member) this.#host.open("members", { member: target.member });
			return true;
		}
		return false;
	}
}
