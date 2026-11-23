// Overview: goal and where it stands, outcome threads, attention, reel captions (§10.1).

import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { createHash } from "node:crypto";
import { project } from "../../model.ts";
import { fit, pad, sanitizeLine } from "../../sanitize.ts";
import { button, card, group, id, item, list, NativeCache, nativeKey, section, span, stateTone, text } from "../native.ts";
import { GLYPH, type OpenTarget, type View, type ViewHost } from "../view.ts";

interface Line {
	key: string;
	label: string;
	detail?: string;
	target?: OpenTarget;
	state?: string;
}

interface Block {
	key: string;
	label: string;
	rows: Line[];
}

interface Choice {
	key: string;
	block: string;
	row: Line;
}

const UNADDRESSED_LIMIT = 50;

function keyDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function selectionKey(block: string, row: string): string {
	return `${block}/${row}`;
}

function unique(keys: Map<string, number>, key: string): string {
	const n = (keys.get(key) ?? 0) + 1;
	keys.set(key, n);
	return n === 1 ? key : `${key}:${n}`;
}

export class OverviewView implements View {
	readonly #host: ViewHost;
	#sel = "";
	readonly #native = new NativeCache();
	#blocksKey = "";
	#hour12: boolean | undefined;
	#blocks: Block[] = [];
	#choices: Choice[] = [];
	#omittedUnaddressed = 0;
	#top = 0;

	constructor(host: ViewHost) {
		this.#host = host;
	}

	#snapshot(absoluteTime?: { hour12?: boolean }) {
		const { model, viewFiles } = this.#host;
		const view = project(model, viewFiles, absoluteTime);
		const blockKey = `${model.version}|${viewFiles.key}|${absoluteTime !== undefined}`;
		if (this.#blocksKey !== blockKey) {
			const blockKeys = new Map<string, number>();
			const names = new Set(model.members().map(m => m.name));
			const posts = model.messages();
			const target = (seq?: number, member?: string): OpenTarget | undefined =>
				seq && posts[seq - 1]?.seq === seq ? { seq } : member && names.has(member) ? { member } : undefined;
			this.#blocks = view.threads.map(t => {
				const key = unique(blockKeys, `thread:${keyDigest(t.id || t.title)}`);
				const rowKeys = new Map<string, number>();
				return { key, label: t.title, rows: t.rows.map(r => ({
					key: unique(rowKeys, `owner:${names.has(r.owner) ? id(r.owner) : keyDigest(r.owner)}`),
					label: r.owner, state: r.state,
					detail: r.result ? `${r.title} — ${r.result}` : r.title || r.state,
					target: target(undefined, r.owner),
				})) };
			});
			const attention: Line[] = [];
			const attentionKeys = new Map<string, number>();
			let unaddressed = 0;
			this.#omittedUnaddressed = 0;
			// Only projected unaddressed posts have both this kind and a sequence.
			// Walk backwards to retain the newest such posts, never dropping other notices.
			for (let i = view.attention.length - 1; i >= 0; i--) {
				const a = view.attention[i]!;
				if (absoluteTime && a.kind === "unaddressed" && a.seq !== undefined && ++unaddressed > UNADDRESSED_LIMIT) {
					this.#omittedUnaddressed++;
					continue;
				}
				attention.push({
					key: unique(attentionKeys, `notice:${a.seq ?? ""}:${keyDigest(`${a.kind}\0${a.member ?? ""}`)}`),
					label: a.text, detail: a.detail, target: target(a.seq, a.member),
					state: a.kind === "blocked" || a.kind === "unaddressed" || a.kind === "owed" ? "stopped" : "failed",
				});
			}
			this.#blocks.push({ key: "attention", label: "Attention", rows: attention.reverse() });
			const reelKeys = new Map<string, number>();
			this.#blocks.push({ key: "reel", label: "Screenshot reel", rows: view.reel.slice(-8).map(f => ({
				key: unique(reelKeys, `frame:${f.seq}:${keyDigest(f.path)}`), label: `#${f.seq} ${f.caption || f.path}`,
				detail: f.caption ? f.path : undefined, target: target(f.seq),
			})) });
			this.#choices = this.#blocks.flatMap(block => block.rows.flatMap(row =>
				row.target ? [{ key: selectionKey(block.key, row.key), block: block.key, row }] : []));
			this.#blocksKey = blockKey;
		}
		return view;
	}

	#selected(): Choice | undefined {
		const choice = this.#choices.find(c => c.key === this.#sel) ?? this.#choices[0];
		this.#sel = choice?.key ?? "";
		return choice;
	}

	#activate(target: OpenTarget | undefined): boolean {
		if (target?.seq) this.#host.open("board", { seq: target.seq });
		else if (target?.member) this.#host.open("members", { member: target.member });
		else return false;
		return true;
	}

	describe(cx: DescribeContext): NativeNode {
		this.#hour12 = cx.hour12;
		const v = this.#snapshot({ hour12: cx.hour12 });
		const selected = this.#selected();
		const { model, viewFiles: files } = this.#host;
		return this.#native.get(`${nativeKey(cx)}|${v.key}|${this.#sel}`, () => {
			const out: NativeNode[] = [text("goal", [span("Goal: ", "strong"), span(v.goal)])];
			if (v.empty) out.push(text("empty", 'No members yet. The coordinator adds workers with swarm{action:"add"}.'));
			const restored = model.restored();
			if (restored) out.push(text("restored", `Restored after a restart: ${restored.stopped} stopped, ${restored.owed} with unread posts (swarm revive)`, "warning"));
			if (!files.plan && !files.view) out.push(text("no-plan", "No plan.json and no narrator: showing every task member.", "muted"));
			for (const [key, error] of [["plan", files.planError], ["narrator", files.viewError], ["narrator-html", files.htmlError]] as const) {
				if (error) out.push(text(`warning:${key}`, `${key}: ${error}`, "warning"));
			}
			for (const block of this.#blocks) {
				if (!block.rows.length && block.key !== "attention") continue;
				const rows = block.rows.filter(r => r.target).map(r => item(r.key,
					[span(r.label, "strong"), ...(block.key.startsWith("thread:") ? [span(` · ${r.state}`, stateTone(r.state ?? ""))] : [])],
					r.detail ? [span(r.detail, "muted")] : undefined, stateTone(r.state ?? "")));
				const detail = block.rows.filter(r => !r.target).map(r => text(r.key, `${r.label}${r.detail ? ` — ${r.detail}` : ""}`, stateTone(r.state ?? "")));
				if (rows.length || !detail.length) detail.unshift(list(cx, "choices", rows, selected?.block === block.key ? selected.row.key : undefined, "No attention items."));
				if (block.key === "attention" && this.#omittedUnaddressed) detail.push(text("omitted", `${this.#omittedUnaddressed} more unaddressed posts not shown.`, "muted"));
				out.push(section(cx, block.key, block.label, detail));
			}
			if (selected?.row.target) {
				const { target, label, detail } = selected.row;
				out.push(card(cx, `detail:${selected.block}:${selected.row.key}`, label, [
					text("detail", detail || (target.seq ? `Board post #${target.seq}` : `Member ${target.member}`)),
					button(cx, "open", target.seq ? `Open post #${target.seq}` : "Inspect member", "Enter", { primary: true }),
				]));
			}
			return group(cx, "overview", out, "omp.swarm.overview");
		});
	}

	handleNativeEvent(event: NativeUiEvent, key: string): boolean {
		this.#snapshot({ hour12: this.#hour12 });
		const selected = this.#selected();
		if (event.type === "action" && event.act === "swarm.open") {
			return !!selected && key === `detail:${selected.block}:${selected.row.key}/open` && this.#activate(selected.row.target);
		}
		for (const block of this.#blocks) {
			const prefix = `${block.key}/choices`;
			const pick = event.type === "select" || event.type === "activate"
				? key === prefix ? event.item : ""
				: event.type === "action" && key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : "";
			const row = pick && block.rows.find(r => r.key === pick && r.target);
			if (!row || (event.type === "action" && event.act !== `swarm.${row.key}`)) continue;
			const selection = selectionKey(block.key, row.key);
			if (event.type === "activate") { this.#sel = selection; return this.#activate(row.target); }
			if (selection === this.#sel) return false;
			this.#sel = selection;
			return true;
		}
		return false;
	}

	render(width: number, rows: number): string[] {
		const { theme } = this.#host;
		const v = this.#snapshot();
		const selected = this.#selected();
		const lines = [{ key: "goal", text: theme.bold(`Goal: ${sanitizeLine(v.goal)}`) }];
		if (v.empty) lines.push({ key: "empty", text: 'No members yet. The coordinator adds workers with swarm{action:"add"}.' });
		else {
			const restored = this.#host.model.restored();
			if (restored) lines.push({ key: "restored", text: theme.fg("warning", `Restored after a restart: ${restored.stopped} stopped, ${restored.owed} with unread posts (swarm revive)`) });
			if (!this.#host.viewFiles.plan && !this.#host.viewFiles.view) lines.push({ key: "no-plan", text: theme.fg("muted", "No plan.json and no narrator: showing every task member.") });
			for (const block of this.#blocks) {
				const thread = block.key.startsWith("thread:");
				if (thread) lines.push({ key: block.key, text: theme.fg("accent", `▸ ${sanitizeLine(block.label)}`) });
				const nameW = thread ? Math.min(16, Math.max(6, ...block.rows.map(r => r.label.length))) : 0;
				for (const row of block.rows) {
					const title = sanitizeLine(row.label);
					const detail = sanitizeLine(row.detail);
					const line = thread ? `  ${GLYPH[row.state ?? ""] ?? "·"} ${pad(title, nameW)} ${detail}` :
						block.key === "attention" ? theme.fg(row.state === "failed" ? "error" : "warning", `! ${title}${detail ? ` — ${detail}` : ""}`) : theme.fg("muted", `▣ ${title}`);
					lines.push({ key: selectionKey(block.key, row.key), text: line });
				}
			}
			lines.push({ key: "state", text: theme.fg(v.stateLine.startsWith("incomplete") ? "error" : "muted", sanitizeLine(v.stateLine)) });
		}
		const selLine = selected ? lines.findIndex(l => l.key === this.#sel) : -1;
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
		return this.#status(this.#snapshot().attention.length);
	}

	nativeStatus(cx: DescribeContext): string {
		return this.#status(this.#snapshot({ hour12: cx.hour12 }).attention.length);
	}

	#status(n: number): string {
		return n ? `attention ${n} · Enter opens` : "Enter opens the selected row";
	}

	hints(): string[] {
		return ["↑↓", "Enter", "1-4", "?", "q"];
	}

	capturing(): boolean {
		return false;
	}

	show(): void {}

	handleInput(data: string, native = false): boolean {
		const { keys } = this.#host;
		const delta = keys.up(data) ? -1 : keys.down(data) ? 1 : 0;
		if (!delta && !keys.confirm(data)) return false;
		this.#snapshot(native ? { hour12: this.#hour12 } : undefined);
		const selected = this.#selected();
		if (delta) {
			const at = selected ? this.#choices.indexOf(selected) : 0;
			const next = Math.max(0, Math.min(this.#choices.length - 1, at + delta));
			this.#sel = this.#choices[next]?.key ?? "";
		} else this.#activate(selected?.row.target);
		return true;
	}
}
