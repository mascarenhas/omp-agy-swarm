// Transcript: a member's conversation as compact items, paged over the whole current branch
// (older pages load on demand), follow, member cycling and search over loaded items (§10.2).

import { structural, type Accessor, type KeyEvent, type UiNode } from "@oh-my-pi/pi-tui";
import type { MemberView, TranscriptItem, TranscriptPage, TranscriptSource } from "../../model.ts";
import { fit, sanitize, sanitizeLine, wrap } from "../../sanitize.ts";
import { printable } from "../keys.ts";
import { button, col, id, row, section, span, text } from "../native.ts";
import { Capture, type OpenTarget, type View, type ViewHost } from "../view.ts";

const LABEL: Record<TranscriptItem["kind"], [string, string]> = {
	user: ["user", "accent"],
	wake: ["wake", "warning"],
	assistant: ["assistant", "success"],
	thinking: ["thinking", "dim"],
	tool_call: ["→", "toolTitle"],
	tool_result: ["←", "muted"],
	system: ["system", "muted"],
};

// The peer owns viewport geometry. Keep a bounded tail large enough for tall
// panes: up to 40 short entries, or fewer for long entries (at least one).
const WINDOW_COST = 80;
const PAGE = 200;
const NATIVE_LABEL: Record<TranscriptItem["kind"], string> = {
	user: "User", wake: "Swarm wake", assistant: "Assistant", thinking: "Thinking",
	tool_call: "Tool call", tool_result: "Tool result", system: "System",
};

function itemCost(item: TranscriptItem, budget: number): number {
	let cost = item.model ? 3 : 2; // heading, body, and optional model
	let start = 0;
	for (let end = item.text.indexOf("\n"); end >= 0; end = item.text.indexOf("\n", start)) {
		cost += Math.max(1, Math.ceil((end - start) / 64));
		start = end + 1;
		if (cost >= budget) return cost;
	}
	return cost + Math.max(0, Math.ceil((item.text.length - start) / 64) - 1);
}

function windowEdge(items: readonly TranscriptItem[], anchor: number, direction: -1 | 1): number {
	let cursor = anchor;
	let cost = itemCost(items[cursor]!, WINDOW_COST);
	while (cost < WINDOW_COST && cursor + direction >= 0 && cursor + direction < items.length) {
		cost += itemCost(items[cursor + direction]!, WINDOW_COST - cost);
		if (cost > WINDOW_COST) break;
		cursor += direction;
	}
	return cursor;
}

export class TranscriptView implements View {
	readonly #host: ViewHost;
	#member = "";
	#src: TranscriptSource | undefined;
	#items: TranscriptItem[] = [];
	#first: string | undefined;
	#last: string | undefined;
	#moreBefore = false;
	#moreAfter = false;
	#epoch = "";
	#top = 0;
	#follow = true;
	#seenVersion = -1;
	#search = "";
	#input: Capture | undefined;
	#captures = 0;
	#epochGeneration = 0;
	#nativeAnchor: TranscriptItem | "head" | undefined;
	#reveal = 0;
	#searchSnapshot: { items: TranscriptItem[]; search: string; hits: TranscriptItem[]; positions: number[] } | undefined;
	#readError: string | undefined;
	#lineCache = new Map<string, string[]>();
	#cacheWidth = 0;
	#rows = 10;

	constructor(host: ViewHost) {
		this.#host = host;
	}

	member(): string {
		return this.#member;
	}

	show(target?: OpenTarget): void {
		if (target?.member && target.member !== this.#member && this.#host.model.members().some(m => m.name === target.member)) {
			this.#member = target.member;
			this.#src = this.#host.model.transcript(target.member);
			this.#follow = true;
			this.#search = "";
			this.#input = undefined;
			this.#resetEntries();
			this.#loadTail();
		} else this.#refresh();
	}

	#resetEntries(): void {
		this.#epochGeneration++;
		this.#lineCache.clear();
	}

	#read(opts: Parameters<TranscriptSource["page"]>[0]): TranscriptPage | undefined {
		try {
			const page = this.#src?.page(opts);
			this.#readError = undefined;
			return page;
		} catch (err) {
			this.#readError = err instanceof Error ? err.message : String(err);
			return undefined;
		}
	}

	#replacePage(p: TranscriptPage | undefined, head: boolean, reset = p?.cursor_reset === true): void {
		if (reset || (p?.epoch ?? "") !== this.#epoch) this.#resetEntries();
		this.#items = p?.items ?? [];
		this.#first = p?.first;
		this.#last = p?.last;
		this.#moreBefore = p?.more_before ?? false;
		this.#moreAfter = p?.more_after ?? false;
		this.#epoch = p?.epoch ?? "";
		this.#seenVersion = this.#host.model.version;
		this.#top = head ? 0 : Number.MAX_SAFE_INTEGER;
		this.#nativeAnchor = head ? "head" : undefined;
	}

	#loadTail(): void {
		this.#replacePage(this.#read({ limit: PAGE }), false);
	}

	/** The start of the branch as one page (no walk over every page in between). */
	#loadHead(): void {
		this.#replacePage(this.#read({ head: true, limit: PAGE }), true);
	}

	#refresh(): void {
		if (!this.#member || this.#seenVersion === this.#host.model.version) return;
		const src = this.#host.model.transcript(this.#member);
		if (src !== this.#src) {
			this.#src = src;
			this.#resetEntries();
			this.#loadTail();
			return;
		}
		this.#seenVersion = this.#host.model.version;
		if (this.#follow) {
			if (this.#last) this.#newer();
			else this.#loadTail();
		} else if (this.#last) {
			// Paused views still have to discard turns removed from the active branch.
			const p = this.#read({ after: this.#last, limit: 1 });
			if (p?.cursor_reset) this.#replacePage(this.#read({ limit: PAGE }) ?? p, false, true);
			else if (p && p.epoch !== this.#epoch) this.#loadTail();
			else if (p) this.#moreAfter = p.items.length > 0 || p.more_after;
		} else if (src) this.#loadTail();
	}

	#lineCount(width: number): number {
		let n = 0;
		for (const it of this.#visibleItems()) n += this.#itemLines(it, width).length;
		return n;
	}

	#older(): readonly TranscriptItem[] {
		if (!this.#moreBefore || !this.#first) return [];
		const p = this.#read({ before: this.#first, limit: PAGE });
		if (!p) return [];
		if (p.cursor_reset) {
			this.#replacePage(p, false);
			return [];
		}
		if (p.epoch !== this.#epoch) {
			this.#loadTail();
			return [];
		}
		this.#moreBefore = p.more_before;
		if (p.items.length) {
			this.#items = [...p.items, ...this.#items];
			this.#first = p.first;
		}
		return p.items;
	}

	#newer(): void {
		if (!this.#src || !this.#last) return;
		const p = this.#read({ after: this.#last, limit: PAGE });
		if (!p) return;
		if (p.cursor_reset) return this.#replacePage(p, false);
		if (p.epoch !== this.#epoch || (this.#follow && p.more_after)) return this.#loadTail();
		if (p.items.length) {
			this.#items = [...this.#items, ...p.items];
			this.#last = p.last;
		}
		this.#moreAfter = p.more_after;
	}

	#itemLines(it: TranscriptItem, width: number): string[] {
		if (width !== this.#cacheWidth) {
			this.#lineCache.clear();
			this.#cacheWidth = width;
		}
		const cached = this.#lineCache.get(it.id);
		if (cached) return cached;
		const { theme } = this.#host;
		const [label, color] = LABEL[it.kind];
		const tool = it.tool ? ` ${sanitizeLine(it.tool)}` : "";
		const ok = it.kind === "tool_result" ? (it.ok === false ? " error" : " ok") : "";
		const head = theme.fg(color, `${label}${tool}${ok}`);
		const body = wrap(it.text, Math.max(1, width - 2)).map(l => fit(`  ${l}`, width));
		const lines = [fit(head, width), ...(body.length ? body : [])];
		this.#lineCache.set(it.id, lines);
		return lines;
	}

	#matches(it: TranscriptItem, lower: string): boolean {
		return sanitize(it.text).toLowerCase().includes(lower) || sanitize(it.tool).toLowerCase().includes(lower);
	}

	#visibleItems(): TranscriptItem[] {
		if (!this.#search) return this.#items;
		const cached = this.#searchSnapshot;
		if (cached?.items === this.#items && cached.search === this.#search) return cached.hits;
		const q = this.#search.toLowerCase();
		const hits: TranscriptItem[] = [];
		const positions: number[] = [];
		this.#items.forEach((it, i) => {
			if (!this.#matches(it, q)) return;
			hits.push(it);
			positions.push(i);
		});
		this.#searchSnapshot = { search: this.#search, items: this.#items, hits, positions };
		return hits;
	}

	#window(items: readonly TranscriptItem[]): { start: number; end: number } {
		if (!items.length) return { start: 0, end: 0 };
		let last = items.length - 1;
		const anchor = this.#nativeAnchor;
		if (!this.#follow && anchor) {
			if (anchor === "head") return { start: 0, end: windowEdge(items, 0, 1) + 1 };
			const i = items.indexOf(anchor);
			if (i >= 0) last = i;
			else if (this.#search && this.#searchSnapshot) {
				// Pick the nearest earlier match without moving the reader's saved
				// anchor, so clearing the filter brings the original item back.
				const position = this.#items.indexOf(anchor);
				const { positions } = this.#searchSnapshot;
				let lo = 0, hi = positions.length;
				while (lo < hi) {
					const mid = (lo + hi) >>> 1;
					if (positions[mid]! <= position) lo = mid + 1;
					else hi = mid;
				}
				last = Math.max(0, lo - 1);
			}
		}
		return { start: windowEdge(items, last, -1), end: last + 1 };
	}

	#stepNative(direction: -1 | 1, page: boolean): void {
		const items = this.#visibleItems();
		const { start, end } = this.#window(items);
		if (direction < 0 && page && start === 0 && !this.#moreBefore) return;
		const generation = this.#epochGeneration;
		this.#follow = false;
		let index = (direction < 0 && page ? start : end - 1) + direction;
		if (direction < 0 && index < 0 && this.#moreBefore) {
			const added = this.#older();
			const q = this.#search.toLowerCase();
			index += q ? added.filter(it => this.#matches(it, q)).length : added.length;
		} else if (direction > 0 && index >= items.length && this.#moreAfter) this.#newer();
		if (this.#epochGeneration !== generation) return;
		const next = this.#visibleItems();
		if (!next.length) return;
		index = Math.max(0, Math.min(index, next.length - 1));
		if (direction > 0 && page) index = windowEdge(next, index, 1);
		if (this.#nativeAnchor === next[index]) return;
		this.#nativeAnchor = next[index];
		this.#reveal++;
	}

	field(): Capture | undefined { return this.#input; }

	native(revision: Accessor<number>): UiNode {
		const snapshot = structural(() => {
			revision();
			this.#refresh();
			const member = this.#host.model.members().find(m => m.name === this.#member);
			const visible = this.#visibleItems();
			return { member, visible, ...this.#window(visible) };
		});
		const history = col("history", () => {
			const { member, visible, start, end } = snapshot();
			return member && this.#nativeEntries(member.name, visible, start, end);
		}, undefined, () => {
			revision();
			return this.#reveal ? { at: "start", n: this.#reveal } : undefined;
		});
		return col("transcript", () => {
			const { member, visible, start, end } = snapshot();
			return this.#nativeContent(member, visible, start, end, history);
		}, "omp.swarm.transcript");
	}

	#nativeContent(member: MemberView | undefined, visible: readonly TranscriptItem[], start: number, end: number, history: UiNode): UiNode[] {
		const tool = (id: string, label: string, shortcut: string, options?: Parameters<typeof button>[4]) =>
			button(id, label, shortcut, () => this.#host.interact(this, () => this.#shortcut(shortcut, true)), options);
		const tools = row("tools", [
			tool("previous-member", "Previous member", "["),
			tool("next-member", "Next member", "]"),
			tool("search", "Search loaded items", "/", { on: !!this.#search, disabled: !member }),
			tool("follow", "Follow", "f", { on: this.#follow, disabled: !member }),
		]);
		if (!member) return [text("empty", "Select a member in Members and press t, or use [ / ] here.", "muted"), tools];
		const out: UiNode[] = [];
		const historical = member.killed || member.state === "killed" || member.state === "stopped";
		const live = !historical && !!this.#src && (!!member.liveAgentId || member.role === "coordinator");
		out.push(text("member", [span(member.name, "strong"), span(historical ? ` · ${member.state} · read-only history` : live ? " · live" : " · read-only transcript", "muted"),
			...(visible.length ? [span(" · newest first", "muted")] : [])]));
		if (end > start) out.push(history);
		if (this.#readError) out.push(text("read-error", `Could not read transcript: ${this.#readError}`, "error"));
		else if (!this.#src) out.push(text("unavailable", "Transcript unavailable for this member.", "muted"));
		else if (!visible.length) out.push(text("no-items", this.#search && this.#items.length ? "No matches in the loaded transcript items." : "No transcript items available.", "muted"));
		if (this.#src) out.push(row("pages", [
			button("head", "Start of history", "Home", () => this.#host.interact(this, () => this.#boundary(true))),
			button("older", "Older entries", "PgUp", () => this.#host.interact(this, () => this.#stepNative(-1, true)), { disabled: !start && !this.#moreBefore }),
			button("newer", "Newer entries", "PgDn", () => this.#host.interact(this, () => this.#stepNative(1, true)), { disabled: end >= visible.length && !this.#moreAfter }),
			button("tail", "Latest entries", "End", () => this.#host.interact(this, () => this.#boundary(false))),
		]));
		out.push(tools);
		if (live && member.liveAgentId && member.role !== "coordinator") out.push(text("live-focus", [
			span("For omp’s live transcript: close "), span("/swarm", "key"), span(", open "), span("/hub", "key"),
			span(", press "), span("1", "key"), span(" (Agents), select "), span(member.liveAgentId, "mono strong"),
			span(", press "), span("Enter", "key"), span(". Or select its Tern Tray card."),
		]));
		return out;
	}

	#nativeEntries(member: string, visible: readonly TranscriptItem[], start: number, end: number): UiNode[] {
		const entries: UiNode[] = [];
		// Tern shows the beginning of an over-tall page. Keep the newest entries first.
		const key = `entry:${id(member)}:${this.#epochGeneration}:`;
		for (let index = end - 1; index >= start; index--) {
			const it = visible[index]!;
			const label = `${NATIVE_LABEL[it.kind]}${it.tool ? ` · ${it.tool}` : ""}${it.kind === "tool_result" ? it.ok === false ? " · error" : " · ok" : ""}`;
			entries.push(section(`${key}${id(it.id)}`, label, [
				...(it.model ? [text("model", it.model, "muted mono")] : []),
				text("body", it.text, it.kind === "tool_call" || it.kind === "tool_result" ? "mono" : undefined),
				...(it.truncated ? [text("truncated", "Excerpt truncated", "muted")] : []),
			]));
		}
		return entries;
	}

	#boundary(head: boolean): void {
		this.#follow = !head;
		if (head) this.#loadHead();
		else this.#loadTail();
		this.#reveal++;
	}

	render(width: number, rows: number): string[] {
		this.#rows = rows;
		if (!this.#member) return [fit("Select a member in Members and press t.", width), ...Array(Math.max(0, rows - 1)).fill("")];
		this.#refresh();
		const lines: string[] = [];
		const header = this.#host.theme.bold(fit(`${sanitizeLine(this.#member)}${this.#moreBefore ? " · older above (PgUp)" : " · start of conversation"}`, width));
		for (const it of this.#visibleItems()) lines.push(...this.#itemLines(it, width));
		const body = rows - 1;
		const maxTop = Math.max(0, lines.length - body);
		if (this.#follow || this.#top > maxTop) this.#top = maxTop;
		const out = [header, ...lines.slice(this.#top, this.#top + body)];
		while (out.length < rows) out.push("");
		return out;
	}

	status(width: number): string {
		if (this.#input !== undefined) return fit(`/${this.#input.value}▏`, width);
		return fit(this.nativeStatus(), width);
	}

	nativeStatus(): string {
		const parts = [`${this.#items.length} items loaded`];
		if (this.#follow) parts.push("follow");
		if (this.#search) parts.push(`/${this.#search}`);
		return parts.join(" · ");
	}

	hints(): string[] {
		if (this.#input !== undefined) return ["Enter keep", "Esc clear"];
		return ["PgUp/PgDn", "Home/End", "f follow", "[ ] member", "/ search", "Esc back", "q"];
	}

	capturing(): boolean {
		return this.#input !== undefined;
	}

	#cycle(delta: number): void {
		const names = this.#host.model.members().filter(m => !m.killed || m.name === this.#member).map(m => m.name);
		const i = names.indexOf(this.#member);
		const next = names[(i < 0 ? (delta > 0 ? 0 : names.length - 1) : (i + delta + names.length) % names.length)];
		if (next) this.show({ member: next });
	}

	handleInput(data: KeyEvent, native = false): boolean {
		const { keys } = this.#host;
		const width = this.#cacheWidth || 80;
		if (this.#input !== undefined) {
			if (keys.cancel(data)) {
				this.#input = undefined;
				this.#search = "";
			} else if (keys.confirm(data)) {
				this.#search = this.#input.value;
				this.#input = undefined;
			} else this.#input.handleKey(keys, data);
			return true;
		}
		this.#refresh();
		if (native && (keys.up(data) || keys.pageUp(data) || keys.down(data) || keys.pageDown(data))) {
			this.#stepNative(keys.up(data) || keys.pageUp(data) ? -1 : 1, keys.pageUp(data) || keys.pageDown(data));
			return true;
		}
		const page = Math.max(1, this.#rows - 2);
		if (keys.up(data) || keys.pageUp(data)) {
			this.#follow = false;
			const step = keys.up(data) ? 1 : page;
			if (this.#top - step < 0 && this.#moreBefore) {
				for (const it of this.#older()) this.#top += this.#itemLines(it, width).length;
			}
			this.#top = Math.max(0, this.#top - step);
			return true;
		}
		if (keys.down(data) || keys.pageDown(data)) {
			const step = keys.down(data) ? 1 : page;
			this.#top += step;
			// Load the next page only when the view reaches the end of what is loaded.
			if (this.#moreAfter && this.#top + this.#rows - 1 >= this.#lineCount(width)) this.#newer();
			return true;
		}
		if (keys.home(data)) {
			this.#boundary(true);
			return true;
		}
		if (keys.end(data)) {
			this.#boundary(false);
			return true;
		}
		return this.#shortcut(printable(data), native);
	}

	#shortcut(data: string | undefined, native: boolean): boolean {
		switch (data) {
			case "f":
				if (native && this.#follow) this.#nativeAnchor = this.#visibleItems().at(-1);
				this.#follow = !this.#follow;
				if (this.#follow) this.#loadTail();
				return true;
			case "[":
				this.#cycle(-1);
				return true;
			case "]":
				this.#cycle(1);
				return true;
			case "/":
				this.#input = new Capture(`transcript-search:${++this.#captures}`, "Search loaded transcript", this.#search);
				return true;
		}
		return false;
	}
}
