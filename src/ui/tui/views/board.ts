// Board: posts with search, author/mention/channel filters, #seq jump with return, follow, unread
// divider and expandable long posts (§10.2). Only blocks in view are laid out (5 000+ posts).

import type { BoardMessage } from "../../../board/types.ts";
import { fit, pad, sanitize, sanitizeLine, wrap } from "../../sanitize.ts";
import { printable } from "../keys.ts";
import type { OpenTarget, View, ViewHost } from "../view.ts";

interface Filters {
	search: string;
	author: string;
	mention: "off" | "coordinator" | "author";
	mentionOf: string;
	channel: string;
}

const NO_FILTERS: Filters = { search: "", author: "", mention: "off", mentionOf: "", channel: "" };
const COLLAPSE = 6;

export class BoardView implements View {
	readonly #host: ViewHost;
	#f: Filters = { ...NO_FILTERS };
	#saved: { filters: Filters; sel: number; follow: boolean } | undefined;
	#follow = true;
	#sel = 0;
	#top = 0;
	#expanded = new Set<number>();
	#input: { kind: "search" | "jump"; text: string; before: Filters } | undefined;
	#cacheKey = "";
	#list: BoardMessage[] = [];
	#lastRange = { from: 0, to: 0 };

	constructor(host: ViewHost) {
		this.#host = host;
	}

	#filtered(): BoardMessage[] {
		const model = this.#host.model;
		const f = this.#f;
		const key = `${model.version}|${f.search}|${f.author}|${f.mention}|${f.mentionOf}|${f.channel}`;
		if (key === this.#cacheKey) return this.#list;
		const q = f.search.toLowerCase();
		this.#list = model.messages().filter(m => {
			if (f.channel && (m.channel || "main") !== f.channel) return false;
			if (f.author && m.agent !== f.author) return false;
			if (f.mention !== "off") {
				const who = f.mention === "coordinator" ? "coordinator" : f.mentionOf;
				// The ring decided at the post: direct, group-prefix, @all and @#channel addressees.
				if (!m.ring.mentions.has(who)) return false;
			}
			if (q && !sanitize(m.text).toLowerCase().includes(q) && !m.agent.toLowerCase().includes(q)) return false;
			return true;
		});
		this.#cacheKey = key;
		return this.#list;
	}

	#selIndex(list: BoardMessage[]): number {
		if (!list.length) return -1;
		if (this.#follow || !this.#sel) return list.length - 1;
		let lo = 0;
		let hi = list.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((list[mid]?.seq ?? 0) < this.#sel) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	#block(m: BoardMessage, width: number, selected: boolean): string[] {
		const { theme, model } = this.#host;
		const clock = m.time.split(" ")[1] ?? m.time;
		if (m.control) {
			const line = fit(`#${m.seq} ${sanitizeLine(m.agent)} · ${sanitizeLine(m.text)} · ${clock}`, width);
			return [selected ? theme.inverse(pad(line, width)) : theme.fg("dim", line)];
		}
		const a = model.addressees(m);
		const to = [...a.mentions.map(n => `@${n}`), ...(a.all ? ["@all"] : []), ...a.channels.map(c => `@#${c}`)];
		const head = `#${m.seq} ${sanitizeLine(m.agent)}${to.length ? ` → ${to.join(" ")}` : ""}${m.channel && m.channel !== "main" ? ` · #${sanitizeLine(m.channel)}` : ""} · ${clock}`;
		const headLine = selected ? theme.inverse(pad(head, width)) : theme.bold(fit(head, width));
		const text = sanitize(m.text).replace(/(^|[^\w])(@#?[\w-]+|#\d+)/g, (_s, pre: string, tok: string) => `${pre}${theme.fg("accent", tok)}`);
		let body = wrap(text, Math.max(1, width - 2)).map(l => `  ${l}`);
		if (!this.#expanded.has(m.seq) && body.length > COLLAPSE) {
			const extra = body.length - COLLAPSE;
			body = [...body.slice(0, COLLAPSE), theme.fg("muted", `  … ${extra} more lines (Enter expands)`)];
		}
		return [headLine, ...body.map(l => fit(l, width))];
	}

	render(width: number, rows: number): string[] {
		const list = this.#filtered();
		const out: string[] = [];
		if (!list.length) {
			out.push(this.#host.model.messages().length ? "No posts match the filters (x clears them)." : "The board is empty.");
			while (out.length < rows) out.push("");
			return out;
		}
		const s = this.#selIndex(list);
		this.#sel = list[s]?.seq ?? 0;
		const cursor = this.#host.model.coordinatorCursor();
		const heights = new Map<number, string[]>();
		const blockAt = (i: number): string[] => {
			let b = heights.get(i);
			if (!b) {
				const m = list[i] as BoardMessage;
				b = this.#block(m, width, i === s);
				const prev = list[i - 1];
				if (m.seq > cursor && (!prev || prev.seq <= cursor)) b = [this.#host.theme.fg("warning", fit("── new ──", width)), ...b];
				heights.set(i, b);
			}
			return b;
		};
		let top = Math.min(Math.max(0, this.#top), s);
		if (this.#follow) {
			top = s;
			let used = blockAt(s).length;
			while (top > 0 && used + blockAt(top - 1).length <= rows) used += blockAt(--top).length;
		} else {
			let used = 0;
			for (let i = top; i <= s; i++) used += blockAt(i).length;
			while (top < s && used > rows) used -= blockAt(top++).length;
		}
		this.#top = top;
		let last = top;
		for (let i = top; i < list.length && out.length < rows; i++) {
			for (const line of blockAt(i)) {
				if (out.length >= rows) break;
				out.push(line);
			}
			last = i;
		}
		this.#lastRange = { from: top + 1, to: last + 1 };
		while (out.length < rows) out.push("");
		return out;
	}

	#describeFilters(): string {
		const f = this.#f;
		const parts: string[] = [];
		if (f.search) parts.push(`/${f.search}`);
		if (f.author) parts.push(`from ${f.author}`);
		if (f.mention === "coordinator") parts.push("to coordinator");
		if (f.mention === "author") parts.push(`to ${f.mentionOf}`);
		if (f.channel) parts.push(`#${f.channel}`);
		return parts.join(" ");
	}

	status(width: number): string {
		if (this.#input) return fit(`${this.#input.kind === "search" ? "/" : "#"}${this.#input.text}▏`, width);
		const list = this.#filtered();
		const parts = [list.length ? `${this.#lastRange.from}–${this.#lastRange.to} of ${list.length}` : "0 posts"];
		if (this.#follow) parts.push("follow");
		const f = this.#describeFilters();
		if (f) parts.push(f);
		if (this.#saved) parts.push(`#${this.#sel} · filters off · b back`);
		return fit(parts.join(" · "), width);
	}

	hints(): string[] {
		if (this.#input) return ["Enter keep", "Esc clear"];
		return ["↑↓", "/ search", "# jump", "a m c filter", "f follow", "u unread", "x clear", "Enter expand", "o sender", "b back", "?", "q"];
	}

	capturing(): boolean {
		return !!this.#input;
	}

	show(target?: OpenTarget): void {
		if (target?.seq) this.#jump(target.seq);
	}

	#jump(seq: number): void {
		const list = this.#filtered();
		if (list.some(m => m.seq === seq)) {
			this.#follow = false;
			this.#sel = seq;
			return;
		}
		if (seq < 1 || seq > this.#host.model.head) return;
		this.#saved = { filters: this.#f, sel: this.#sel, follow: this.#follow };
		this.#f = { ...NO_FILTERS };
		this.#follow = false;
		this.#sel = seq;
	}

	#move(delta: number): void {
		const list = this.#filtered();
		if (!list.length) return;
		const s = this.#selIndex(list);
		const n = Math.max(0, Math.min(list.length - 1, s + delta));
		this.#follow = n === list.length - 1 && delta > 0 ? this.#follow : false;
		this.#sel = list[n]?.seq ?? 0;
		if (n === list.length - 1 && delta > 0) this.#follow = true;
	}

	#selected(): BoardMessage | undefined {
		const list = this.#filtered();
		return list[this.#selIndex(list)];
	}

	handleInput(data: string): boolean {
		const { keys, model } = this.#host;
		const inp = this.#input;
		if (inp) {
			if (keys.cancel(data)) {
				if (inp.kind === "search") this.#f = { ...inp.before, search: "" };
				this.#input = undefined;
				return true;
			}
			if (keys.confirm(data)) {
				this.#input = undefined;
				if (inp.kind === "jump") {
					const seq = Number(inp.text);
					if (Number.isInteger(seq)) this.#jump(seq);
				}
				return true;
			}
			if (keys.backspace(data)) {
				inp.text = inp.text.slice(0, -1);
				if (inp.kind === "search") this.#f = { ...this.#f, search: inp.text };
				return true;
			}
			const ch = printable(data);
			if (ch) {
				if (inp.kind === "jump" && !/[0-9]/.test(ch)) return true;
				inp.text += ch;
				if (inp.kind === "search") {
					this.#f = { ...this.#f, search: inp.text };
					this.#follow = true;
				}
			}
			return true;
		}
		if (keys.up(data)) {
			this.#move(-1);
			return true;
		}
		if (keys.down(data)) {
			this.#move(1);
			return true;
		}
		if (keys.pageUp(data)) {
			this.#move(-5);
			return true;
		}
		if (keys.pageDown(data)) {
			this.#move(5);
			return true;
		}
		if (keys.home(data)) {
			const list = this.#filtered();
			this.#follow = false;
			this.#sel = list[0]?.seq ?? 0;
			this.#top = 0;
			return true;
		}
		if (keys.end(data)) {
			this.#follow = true;
			return true;
		}
		if (keys.confirm(data)) {
			const m = this.#selected();
			if (m) {
				if (this.#expanded.has(m.seq)) this.#expanded.delete(m.seq);
				else this.#expanded.add(m.seq);
				this.#follow = false;
				this.#sel = m.seq;
			}
			return true;
		}
		switch (data) {
			case "/":
				this.#input = { kind: "search", text: this.#f.search, before: { ...this.#f } };
				return true;
			case "#":
				this.#input = { kind: "jump", text: "", before: { ...this.#f } };
				return true;
			case "n":
				this.#move(1);
				return true;
			case "N":
				this.#move(-1);
				return true;
			case "f":
				this.#follow = !this.#follow;
				if (!this.#follow) this.#sel = this.#selected()?.seq ?? 0;
				return true;
			case "u": {
				const cursor = model.coordinatorCursor();
				const first = this.#filtered().find(m => m.seq > cursor);
				if (first) {
					this.#follow = false;
					this.#sel = first.seq;
				}
				return true;
			}
			case "x":
				this.#f = { ...NO_FILTERS };
				this.#saved = undefined;
				return true;
			case "b":
				if (this.#saved) {
					this.#f = this.#saved.filters;
					this.#sel = this.#saved.sel;
					this.#follow = this.#saved.follow;
					this.#saved = undefined;
				}
				return true;
			case "a": {
				const names = model.members().map(m => m.name);
				const i = names.indexOf(this.#f.author);
				this.#f = { ...this.#f, author: names[i + 1] ?? "" };
				return true;
			}
			case "A":
				this.#f = { ...this.#f, author: "" };
				return true;
			case "m": {
				const sel = this.#selected();
				const next = this.#f.mention === "off" ? "coordinator" : this.#f.mention === "coordinator" && sel ? "author" : "off";
				this.#f = { ...this.#f, mention: next, mentionOf: next === "author" ? sel?.agent ?? "" : "" };
				return true;
			}
			case "c": {
				const chans = ["main", ...model.channels().map(c => c.name)];
				const i = chans.indexOf(this.#f.channel);
				this.#f = { ...this.#f, channel: this.#f.channel === "" ? "main" : chans[i + 1] ?? "" };
				return true;
			}
			case "o": {
				const m = this.#selected();
				if (m) this.#host.open("members", { member: m.agent });
				return true;
			}
		}
		return false;
	}
}
