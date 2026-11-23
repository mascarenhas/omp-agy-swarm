// Members: coordinator, task workers (groups, helpers under their adder), role workers; killed
// hidden until K. Detail in place, or in a right-hand column on wide terminals (§10.2).

import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { MemberView } from "../../model.ts";
import { fit, pad, sanitizeLine } from "../../sanitize.ts";
import { button, card, group, id, item, list, memberFacts, NativeCache, nativeKey, span, stateTone, strip } from "../native.ts";
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
	readonly #native = new NativeCache();
	#orderedKey = "";
	#rows: Row[] = [];

	constructor(host: ViewHost) {
		this.#host = host;
	}

	selected(): string {
		this.#selection(this.#ordered());
		return this.#selName;
	}

	#ordered(): Row[] {
		const cache = `${this.#host.model.version}|${this.#showKilled}`;
		if (this.#orderedKey === cache) return this.#rows;
		const all = this.#host.model.members().filter(m => this.#showKilled || !m.killed);
		const rows: Row[] = [];
		const coord = all.find(m => m.role === "coordinator");
		if (coord) rows.push({ member: coord, text: "", indent: 0 });
		const workers = all.filter(m => m.role === "worker");
		const workerNames = new Set(workers.map(w => w.name));
		const byAdder = new Map<string, MemberView[]>();
		for (const w of workers) {
			const k = workerNames.has(w.addedBy) ? w.addedBy : "";
			const existing = byAdder.get(k);
			if (existing) existing.push(w);
			else byAdder.set(k, [w]);
		}
		const emit = (m: MemberView, indent: number): void => {
			rows.push({ member: m, text: "", indent });
			for (const h of byAdder.get(m.name) ?? []) emit(h, indent + 1);
		};
		const top = byAdder.get("") ?? [];
		const groups = new Map<string, MemberView[]>();
		const groupCounts = new Map<string, number>();
		for (const m of top) {
			const dash = m.name.lastIndexOf("-");
			for (let at = m.name.indexOf("-"); at !== -1 && at <= dash; at = m.name.indexOf("-", at + 1)) {
				const prefix = m.name.slice(0, at);
				groupCounts.set(prefix, (groupCounts.get(prefix) ?? 0) + 1);
			}
		}
		for (const m of top) {
			const g = /^(.+)-\d+$/.exec(m.name)?.[1] ?? "";
			const key = g && (groupCounts.get(g) ?? 0) > 1 ? g : `\0${m.name}`;
			const existing = groups.get(key);
			if (existing) existing.push(m);
			else groups.set(key, [m]);
		}
		for (const [key, ms] of groups) {
			if (!key.startsWith("\0")) rows.push({ text: `${key}-* (${ms.length})`, indent: 0 });
			for (const m of ms) emit(m, key.startsWith("\0") ? 0 : 1);
		}
		for (const m of all.filter(x => x.role === "narrator" || x.role === "monitor")) rows.push({ member: m, text: "", indent: 0 });
		this.#orderedKey = cache;
		return this.#rows = rows;
	}

	#selection(ordered: readonly Row[]): number {
		const found = this.#selName ? ordered.findIndex(r => r.member?.name === this.#selName) : -1;
		const index = found >= 0 ? found : ordered.findIndex(r => r.member);
		this.#selName = ordered[index]?.member?.name ?? "";
		return index;
	}

	#openTranscript(member: MemberView | undefined): boolean {
		if (!member) return false;
		this.#host.open("transcript", { member: member.name });
		return true;
	}

	describe(cx: DescribeContext): NativeNode {
		const ordered = this.#ordered();
		const selected = ordered[this.#selection(ordered)]?.member;
		return this.#native.get(`${nativeKey(cx)}|${this.#orderedKey}|${this.#selName}`, () => {
			const nodes = ordered.map(({ member: m, text: groupLabel, indent }) => {
				if (!m) {
					const row = item(`group:${id(groupLabel.split(" ")[0]!)}`, [span(groupLabel, "accent strong")]);
					return { ...row, p: { ...row.p, disabled: true } };
				}
				const state = m.failure ? "failed" : m.state;
				return item(`member:${id(m.name)}`, [span(m.name, "strong"), span(` · ${state}`, stateTone(state))],
					[span(`${m.role === "worker" && indent && m.addedBy !== "coordinator" ? `Helper of ${m.addedBy} · ` : ""}${m.role} · `, "muted"),
						span(`${m.model || "?"}${m.effort ? ` · ${m.effort}` : ""}`, "mono"),
						span(` · ${m.unread} unread · ${m.owed.length} owed`, "num")], stateTone(state));
			});
			const left = list(cx, "roster", nodes, selected ? `member:${id(selected.name)}` : undefined, "No members.");
			const content = selected ? strip(cx, "roster-pane", [
				left,
				card(cx, `detail:${id(selected.name)}`, selected.name, [
					memberFacts(cx, selected, this.#host.model.swarmDir),
					button(cx, "transcript", "View transcript", "Enter", { primary: true }),
				]),
			]) : strip(cx, "roster-pane", [left]);
			return group(cx, "members", [button(cx, "killed", this.#showKilled ? "Hide killed" : "Show killed", "K", { on: this.#showKilled }), content], "omp.swarm.members");
		});
	}

	handleNativeEvent(event: NativeUiEvent, key: string): boolean {
		const rows = this.#ordered();
		const selected = rows[this.#selection(rows)]?.member;
		if (event.type === "action" && key === "killed" && event.act === "swarm.killed") return this.handleInput("K");
		if (event.type === "action" && selected && key === `roster-pane/detail:${id(selected.name)}/transcript` && event.act === "swarm.transcript") return this.#openTranscript(selected);
		const roster = "roster-pane/roster";
		const pick = event.type === "select" || event.type === "activate" ? key === roster ? event.item : ""
			: event.type === "action" && key.startsWith(`${roster}/`) ? key.slice(roster.length + 1) : "";
		if (!pick) return false;
		const member = rows.find(r => r.member && pick === `member:${id(r.member.name)}`)?.member;
		if (!member || (event.type === "action" && event.act !== `swarm.${pick}`)) return false;
		const changed = this.#selName !== member.name;
		this.#selName = member.name;
		if (event.type === "activate") return this.#openTranscript(member);
		return changed;
	}

	nativeStatus(): string {
		const rows = this.#ordered();
		const m = rows[this.#selection(rows)]?.member;
		return m ? `${m.name} · ${m.state}${this.#showKilled ? " · killed shown" : ""}` : "no members";
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
		const selIdx = this.#selection(ordered);
		const selMember = ordered[selIdx]?.member;
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
				lines.push({ text: this.#host.theme.fg("accent", fit(r.text, listW)), sel: false });
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

	hints(native = false): string[] {
		return ["↑↓", ...(native ? ["Enter / t transcript"] : ["Enter detail", "t transcript"]), "K killed", "1-4", "?", "q"];
	}

	capturing(native = false): boolean {
		return !native && this.#detail;
	}

	show(target?: OpenTarget): void {
		if (target?.member) {
			this.#selName = target.member;
			if (this.#host.model.members().find(m => m.name === target.member)?.killed) this.#showKilled = true;
		}
	}

	handleInput(data: string, native = false): boolean {
		const { keys } = this.#host;
		const rows = this.#ordered();
		const selected = rows[this.#selection(rows)]?.member;
		const names = rows.flatMap(r => r.member ? [r.member.name] : []);
		const i = Math.max(0, names.indexOf(this.#selName));
		if (!native && this.#detail && keys.cancel(data)) {
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
			if (native) return this.#openTranscript(selected);
			this.#detail = !this.#detail;
			return true;
		}
		if (data === "t") return this.#openTranscript(selected);
		if (data === "K") {
			this.#showKilled = !this.#showKilled;
			return true;
		}
		return false;
	}
}
