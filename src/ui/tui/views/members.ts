// Members: coordinator, task workers (groups, helpers under their adder), role workers; killed
// hidden until K. Detail in place, or in a right-hand column on wide terminals (§10.2).

import type { MemberView } from "../../model.ts";
import { fit, pad, sanitizeLine } from "../../sanitize.ts";
import { GLYPH, type OpenTarget, type View, type ViewHost } from "../view.ts";

interface Row {
	member?: MemberView;
	text: string;
	indent: number;
}

export class MembersView implements View {
	readonly #host: ViewHost;
	#selName = "";
	#top = 0;
	#detail = false;
	#showKilled = false;

	constructor(host: ViewHost) {
		this.#host = host;
	}

	selected(): string {
		return this.#selName;
	}

	#ordered(): Row[] {
		const all = this.#host.model.members().filter(m => this.#showKilled || !m.killed);
		const rows: Row[] = [];
		const coord = all.find(m => m.role === "coordinator");
		if (coord) rows.push({ member: coord, text: "", indent: 0 });
		const workers = all.filter(m => m.role === "worker");
		const byAdder = new Map<string, MemberView[]>();
		for (const w of workers) {
			const k = w.addedBy && w.addedBy !== "coordinator" && workers.some(x => x.name === w.addedBy) ? w.addedBy : "";
			byAdder.set(k, [...(byAdder.get(k) ?? []), w]);
		}
		const emit = (m: MemberView, indent: number): void => {
			rows.push({ member: m, text: "", indent });
			for (const h of byAdder.get(m.name) ?? []) emit(h, indent + 1);
		};
		const top = byAdder.get("") ?? [];
		const groups = new Map<string, MemberView[]>();
		for (const m of top) {
			const g = /^(.+)-\d+$/.exec(m.name)?.[1] ?? "";
			const key = g && top.filter(x => x.name.startsWith(`${g}-`)).length > 1 ? g : `\0${m.name}`;
			groups.set(key, [...(groups.get(key) ?? []), m]);
		}
		for (const [key, ms] of groups) {
			if (!key.startsWith("\0")) rows.push({ text: this.#host.theme.fg("accent", `${key}-* (${ms.length})`), indent: 0 });
			for (const m of ms) emit(m, key.startsWith("\0") ? 0 : 1);
		}
		for (const m of all.filter(x => x.role === "narrator" || x.role === "monitor")) rows.push({ member: m, text: "", indent: 0 });
		return rows;
	}

	#line(m: MemberView, width: number, indent: number): string[] {
		const { theme } = this.#host;
		const glyph = m.failure ? GLYPH.failed : (GLYPH[m.state] ?? "·");
		const pre = "  ".repeat(indent);
		const head = `${pre}${glyph} ${sanitizeLine(m.name)} · ${m.state}${m.role !== "worker" ? ` · ${m.role}` : ""} · ${sanitizeLine(m.model) || "?"}${m.effort ? ` · ${m.effort}` : ""}`;
		// Failure and stopped lines carry their own colour; only the plain lines are muted.
		let second: string;
		if (m.failure) second = theme.fg("error", `${pre}  failed (${m.failure.kind}): ${sanitizeLine(m.failure.text)}`);
		else if (m.state === "stopped") second = theme.fg("warning", `${pre}  stopped — swarm revive brings it back${m.owed.length ? ` (${m.owed.length} owed)` : ""}`);
		else if (m.state === "working") second = theme.fg("muted", `${pre}  ${sanitizeLine(m.activity) || m.detail}`);
		else if (m.killed) second = theme.fg("muted", `${pre}  killed${m.workspace.state === "retained" ? " · workspace retained (see reason)" : ""}`);
		else second = theme.fg("muted", `${pre}  ${m.detail} · wakes on ${m.wakeMode === "anything" ? "any post" : "@mention"}`);
		const counts = `${m.steps} steps · ${m.posts} posts · ${m.unread} unread · ${m.owed.length} owed`;
		return [fit(head, width), fit(second, width), fit(theme.fg("dim", `${pre}  ${counts}`), width)];
	}

	#detailLines(m: MemberView, width: number): string[] {
		const kv = (k: string, v: string): string => fit(`${k.padEnd(10)} ${sanitizeLine(v)}`, width);
		const lines = [
			this.#host.theme.bold(fit(sanitizeLine(m.name), width)),
			kv("role", m.role),
			kv("state", `${m.state} (${m.detail})`),
			kv("model", `${m.model}${m.effort ? ` · ${m.effort}` : ""}`),
			kv("added by", m.addedBy || "—"),
			kv("channels", m.channels.join(", ")),
			kv("workspace", `${m.workspace.mode}: ${m.workspace.path}${m.workspace.branch ? ` (${m.workspace.branch})` : ""}${m.workspace.state ? ` [${m.workspace.state}]` : ""}`),
		];
		if (m.workspace.reason) lines.push(kv("kept", m.workspace.reason));
		if (m.workspace.cleanup) lines.push(kv("cleanup", m.workspace.cleanup));
		lines.push(
			kv("cursor", `#${m.lastReadSeq} · ${m.unread} unread · owed ${m.owed.map(s => `#${s}`).join(" ") || "none"}`),
			kv("posts", `${m.posts}${m.lastPostSeq ? ` · last #${m.lastPostSeq}` : ""}`),
			kv("spend", `${m.tokens} tokens · $${m.cost.toFixed(4)}`),
			kv("brief", m.briefSeq ? `#${m.briefSeq}` : "—"),
		);
		if (m.task) lines.push(kv("slice", m.task));
		if (m.sessionFile) lines.push(kv("transcript", m.sessionFile));
		if (m.failure) lines.push(this.#host.theme.fg("error", kv("failure", `${m.failure.kind}: ${m.failure.text}`)));
		lines.push(fit("t opens the transcript · Esc closes the detail", width));
		return lines;
	}

	render(width: number, rows: number): string[] {
		const ordered = this.#ordered();
		const sel = this.#selName ? ordered.findIndex(r => r.member?.name === this.#selName) : -1;
		const selIdx = sel >= 0 ? sel : ordered.findIndex(r => r.member);
		const selMember = ordered[selIdx]?.member;
		this.#selName = selMember?.name ?? "";
		const wide = width >= 110;
		if (this.#detail && selMember && !wide) {
			const d = this.#detailLines(selMember, width);
			while (d.length < rows) d.push("");
			return d.slice(0, rows);
		}
		const listW = wide ? Math.floor(width * 0.55) : width;
		const lines: { text: string; sel: boolean }[] = [];
		let selStart = 0;
		ordered.forEach((r, i) => {
			if (!r.member) {
				lines.push({ text: fit(r.text, listW), sel: false });
				return;
			}
			if (i === selIdx) selStart = lines.length;
			for (const l of this.#line(r.member, listW, r.indent)) lines.push({ text: l, sel: i === selIdx });
		});
		if (selStart < this.#top) this.#top = selStart;
		if (selStart + 3 > this.#top + rows) this.#top = selStart + 3 - rows;
		this.#top = Math.max(0, Math.min(this.#top, Math.max(0, lines.length - rows)));
		const left = lines.slice(this.#top, this.#top + rows).map(l => (l.sel ? this.#host.theme.inverse(pad(sanitizeLine(l.text), listW)) : pad(l.text, listW)));
		while (left.length < rows) left.push(" ".repeat(listW));
		if (!wide) return left.map(l => fit(l, width));
		const right = selMember ? this.#detailLines(selMember, width - listW - 2) : [];
		return left.map((l, i) => fit(`${l}  ${right[i] ?? ""}`, width));
	}

	status(width: number): string {
		const m = this.#host.model.members().find(x => x.name === this.#selName);
		return fit(m ? `${m.name} · ${m.state}${this.#showKilled ? " · killed shown" : ""}` : "no members", width);
	}

	hints(): string[] {
		return ["↑↓", "Enter detail", "t transcript", "K killed", "1-4", "?", "q"];
	}

	capturing(): boolean {
		return this.#detail;
	}

	show(target?: OpenTarget): void {
		if (target?.member) {
			this.#selName = target.member;
			if (this.#host.model.members().find(m => m.name === target.member)?.killed) this.#showKilled = true;
		}
	}

	handleInput(data: string): boolean {
		const { keys } = this.#host;
		const names = this.#ordered().filter(r => r.member).map(r => r.member?.name ?? "");
		const i = Math.max(0, names.indexOf(this.#selName));
		if (this.#detail && keys.cancel(data)) {
			this.#detail = false;
			return true;
		}
		if (keys.up(data)) {
			this.#selName = names[Math.max(0, i - 1)] ?? this.#selName;
			return true;
		}
		if (keys.down(data)) {
			this.#selName = names[Math.min(names.length - 1, i + 1)] ?? this.#selName;
			return true;
		}
		if (keys.pageUp(data)) {
			this.#selName = names[Math.max(0, i - 5)] ?? this.#selName;
			return true;
		}
		if (keys.pageDown(data)) {
			this.#selName = names[Math.min(names.length - 1, i + 5)] ?? this.#selName;
			return true;
		}
		if (keys.confirm(data)) {
			this.#detail = !this.#detail;
			return true;
		}
		if (data === "t" && this.#selName) {
			this.#host.open("transcript", { member: this.#selName });
			return true;
		}
		if (data === "K") {
			this.#showKilled = !this.#showKilled;
			return true;
		}
		return false;
	}
}
