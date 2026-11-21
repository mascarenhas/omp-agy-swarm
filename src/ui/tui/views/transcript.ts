// Transcript: a member's conversation as compact items, paged over the whole current branch
// (older pages load on demand), follow, member cycling and search over loaded items (§10.2).

import type { TranscriptItem, TranscriptSource } from "../../model.ts";
import { fit, sanitizeLine, wrap } from "../../sanitize.ts";
import { printable } from "../keys.ts";
import type { OpenTarget, View, ViewHost } from "../view.ts";

const LABEL: Record<TranscriptItem["kind"], [string, string]> = {
	user: ["user", "accent"],
	wake: ["wake", "warning"],
	assistant: ["assistant", "success"],
	thinking: ["thinking", "dim"],
	tool_call: ["→", "toolTitle"],
	tool_result: ["←", "muted"],
	system: ["system", "muted"],
};

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
	#input: string | undefined;
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
		if (target?.member && target.member !== this.#member) {
			this.#member = target.member;
			this.#src = this.#host.model.transcript(target.member);
			this.#follow = true;
			this.#search = "";
			this.#loadTail();
		} else if (!this.#src && this.#member) {
			this.#src = this.#host.model.transcript(this.#member);
			this.#loadTail();
		}
	}

	#loadTail(): void {
		const p = this.#src?.page({ limit: 200 });
		this.#items = p?.items ?? [];
		this.#first = p?.first;
		this.#last = p?.last;
		this.#moreBefore = p?.more_before ?? false;
		this.#moreAfter = p?.more_after ?? false;
		this.#epoch = p?.epoch ?? "";
		this.#seenVersion = this.#host.model.version;
		this.#top = Number.MAX_SAFE_INTEGER;
	}

	/** The start of the branch as one page (no walk over every page in between). */
	#loadHead(): void {
		const p = this.#src?.page({ head: true, limit: 200 });
		this.#items = p?.items ?? [];
		this.#first = p?.first;
		this.#last = p?.last;
		this.#moreBefore = p?.more_before ?? false;
		this.#moreAfter = p?.more_after ?? false;
		this.#epoch = p?.epoch ?? "";
		this.#seenVersion = this.#host.model.version;
		this.#top = 0;
	}

	#lineCount(width: number): number {
		let n = 0;
		for (const it of this.#visibleItems()) n += this.#itemLines(it, width).length;
		return n;
	}

	/** Loads the previous page; returns the number of lines prepended. */
	#older(width: number): number {
		if (!this.#src || !this.#moreBefore || !this.#first) return 0;
		const p = this.#src.page({ before: this.#first, limit: 200 });
		if (p.epoch !== this.#epoch) {
			this.#loadTail();
			return 0;
		}
		if (!p.items.length) {
			this.#moreBefore = false;
			return 0;
		}
		this.#items = [...p.items, ...this.#items];
		this.#first = p.first;
		this.#moreBefore = p.more_before;
		return p.items.reduce((n, it) => n + this.#itemLines(it, width).length, 0);
	}

	#newer(): void {
		if (!this.#src || !this.#last) return;
		const p = this.#src.page({ after: this.#last, limit: 200 });
		if (p.epoch !== this.#epoch) return this.#loadTail();
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

	#visibleItems(): TranscriptItem[] {
		if (!this.#search) return this.#items;
		const q = this.#search.toLowerCase();
		return this.#items.filter(it => it.text.toLowerCase().includes(q) || (it.tool ?? "").toLowerCase().includes(q));
	}

	render(width: number, rows: number): string[] {
		this.#rows = rows;
		if (!this.#member) return ["Select a member in Members and press t.", ...Array(Math.max(0, rows - 1)).fill("")];
		if (this.#follow && this.#host.model.version !== this.#seenVersion) {
			this.#seenVersion = this.#host.model.version;
			if (this.#last) this.#newer();
			else this.#loadTail();
		}
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
		if (this.#input !== undefined) return fit(`/${this.#input}▏`, width);
		const parts = [`${this.#items.length} items loaded`];
		if (this.#follow) parts.push("follow");
		if (this.#search) parts.push(`/${this.#search}`);
		return fit(parts.join(" · "), width);
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
		const next = names[(i + delta + names.length) % names.length];
		if (next) this.show({ member: next });
	}

	handleInput(data: string): boolean {
		const { keys } = this.#host;
		const width = this.#cacheWidth || 80;
		if (this.#input !== undefined) {
			if (keys.cancel(data)) {
				this.#input = undefined;
				this.#search = "";
			} else if (keys.confirm(data)) {
				this.#search = this.#input;
				this.#input = undefined;
			} else if (keys.backspace(data)) this.#input = this.#input.slice(0, -1);
			else {
				const ch = printable(data);
				if (ch) this.#input += ch;
			}
			return true;
		}
		const page = Math.max(1, this.#rows - 2);
		if (keys.up(data) || keys.pageUp(data)) {
			this.#follow = false;
			const step = keys.up(data) ? 1 : page;
			if (this.#top - step < 0 && this.#moreBefore) this.#top += this.#older(width);
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
			this.#follow = false;
			this.#loadHead();
			return true;
		}
		if (keys.end(data)) {
			this.#loadTail();
			this.#follow = true;
			return true;
		}
		switch (data) {
			case "f":
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
				this.#input = this.#search;
				return true;
		}
		return false;
	}
}
