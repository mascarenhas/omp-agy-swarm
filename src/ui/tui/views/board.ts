// Board: posts with search, author/mention/channel filters, #seq jump with return, follow, unread
// divider and expandable long posts (§10.2). Only blocks in view are laid out (5 000+ posts).

import type { Accessor, KeyEvent, UiNode } from "@oh-my-pi/pi-tui";
import type { BoardMessage } from "../../../board/types.ts";
import { fit, pad, sanitize, sanitizeLine, wrap } from "../../sanitize.ts";
import { printable } from "../keys.ts";
import { button, card, col, item, list, postSummary, postText, row, span, text } from "../native.ts";
import { Capture, type OpenTarget, type View, type ViewHost } from "../view.ts";

interface Filters {
	search: string;
	author: string;
	mention: "off" | "coordinator" | "author";
	mentionOf: string;
	channel: string;
}

const NO_FILTERS: Filters = { search: "", author: "", mention: "off", mentionOf: "", channel: "" };
const COLLAPSE = 6;
const WINDOW = 50;
const PREVIEW = 640;
type ButtonOptions = Parameters<typeof button>[4];

export class BoardView implements View {
	readonly #host: ViewHost;
	#f: Filters = { ...NO_FILTERS };
	#saved: { filters: Filters; sel: number; follow: boolean; windowStart: number } | undefined;
	#follow = true;
	#sel = 0;
	#top = 0;
	#windowStart: number | undefined;
	#expanded = new Set<number>();
	#input: { kind: "search" | "jump"; field: Capture; before: Filters } | undefined;
	#captures = 0;
	#cacheKey = "";
	#list: readonly BoardMessage[] = [];
	#lastRange = { from: 0, to: 0 };

	constructor(host: ViewHost) {
		this.#host = host;
	}

	#filtered(): readonly BoardMessage[] {
		const model = this.#host.model;
		const f = this.#f;
		const key = JSON.stringify([model.version, f.search, f.author, f.mention, f.mentionOf, f.channel]);
		if (key === this.#cacheKey) return this.#list;
		const q = f.search.toLowerCase();
		const posts = model.messages();
		this.#list = !(q || f.channel || f.author || f.mention !== "off") ? posts : posts.filter(m => {
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

	#selIndex(list: readonly BoardMessage[]): number {
		if (!list.length) return -1;
		if (this.#follow || !this.#sel) return list.length - 1;
		return Math.min(list.length - 1, this.#lowerBound(list, this.#sel));
	}

	#lowerBound(list: readonly BoardMessage[], seq: number): number {
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (list[mid]!.seq < seq) lo = mid + 1;
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
			out.push(fit(this.#host.model.messages().length ? "No posts match the filters (x clears them)." : "The board is empty.", width));
			while (out.length < rows) out.push("");
			return out;
		}
		const s = this.#selIndex(list);
		if (!this.#follow) this.#sel = list[s]?.seq ?? 0;
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

	#window(size: number, index: number): number {
		const tail = Math.max(0, size - WINDOW);
		let start = this.#follow ? tail : Math.min(this.#windowStart ?? tail, tail);
		if (index < start) start = Math.max(0, index);
		else if (index >= start + WINDOW) start = index - WINDOW + 1;
		this.#windowStart = start;
		return start;
	}

	nativeStatus(): string {
		const posts = this.#filtered();
		const i = this.#selIndex(posts);
		const start = this.#window(posts.length, i);
		return [posts.length ? `${start + 1}–${Math.min(posts.length, start + WINDOW)} of ${posts.length} · #${posts[i]?.seq}` : "0 posts",
			this.#follow ? "follow" : "", this.#describeFilters(), this.#saved ? "filters off · b back" : ""].filter(Boolean).join(" · ");
	}

	field(): Capture | undefined {
		return this.#input?.field;
	}

	#updateSearch(follow: boolean): void {
		const input = this.#input;
		if (input?.kind !== "search" || this.#f.search === input.field.value) return;
		this.#f = { ...this.#f, search: input.field.value };
		if (follow) this.#follow = true;
	}

	native(revision: Accessor<number>): UiNode {
		return col("board", () => { revision(); return this.#nativeContent(); }, "omp.swarm.board");
	}

	#nativeContent(): UiNode[] {
		const posts = this.#filtered();
		const i = this.#selIndex(posts);
		const selected = posts[i];
		const start = this.#window(posts.length, i);
		const end = Math.min(start + WINDOW, posts.length);
		const cursor = this.#host.model.coordinatorCursor();
		const expanded = !!selected && this.#expanded.has(selected.seq);
		const action = (id: string, label: string, shortcut: string, options?: ButtonOptions) =>
			button(id, label, shortcut, () => this.#host.interact(this, () => this.#shortcut(shortcut)), options);
		const toolbar = row("tools", [
			action("search", "Search", "/", { on: !!this.#f.search }),
			action("jump", "Jump to #", "#"),
			action("author", this.#f.author ? `From ${this.#f.author}` : "Any author", "a"),
			...(this.#f.author ? [action("clear-author", "Clear author", "A")] : []),
			action("mention", this.#f.mention === "off" ? "Any mention" : `To ${this.#f.mention === "author" ? this.#f.mentionOf : "coordinator"}`, "m"),
			action("channel", this.#f.channel ? `#${this.#f.channel}` : "All channels", "c"),
			action("clear", "Clear filters", "x"),
			action("follow", "Follow", "f", { on: this.#follow }),
			action("unread", "First unread", "u", { disabled: !posts.length || (posts.at(-1)?.seq ?? 0) <= cursor }),
			...(this.#saved ? [action("restore", "Restore filters", "b")] : []),
		]);
		const items: UiNode<"item">[] = [];
		for (let j = start; j < end; j++) {
			const post = posts[j]!;
			if (post.seq > cursor && (posts[j - 1]?.seq ?? 0) <= cursor) {
				items.push(item("new-divider", [span(`New · after #${cursor}`, "warning strong")], undefined, "warning", true));
			}
			items.push(postSummary(post));
		}
		const out: UiNode[] = [];
		if (selected) {
			const addressees = this.#host.model.addressees(selected);
			const to = [...addressees.mentions.map(n => `@${n}`), ...(addressees.all ? ["@all"] : []), ...addressees.channels.map(c => `@#${c}`)];
			const time = Number.isFinite(selected.ts)
				? new Date(selected.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
				: selected.time.split(" ")[1] ?? selected.time;
			const head = `#${selected.seq} · ${selected.agent}${selected.control ? " · control" : ""}`;
			const clean = sanitize(selected.text);
			const long = clean.length > PREVIEW || clean.split("\n", COLLAPSE + 1).length > COLLAPSE;
			const preview = !expanded && long ? `${clean.split("\n", COLLAPSE).join("\n").slice(0, PREVIEW).replace(/[\ud800-\udbff]$/, "")}…` : clean;
			const toggle = (collapsed: boolean) => this.#host.interact(this, () => this.#expand(selected, !collapsed));
			out.push(card(`detail:post:${selected.seq}`, head, [
				text("metadata", [span(`#${selected.channel || "main"} · ${time}`, "muted mono"), ...(to.length ? [span(` · ${to.join(" ")}`, "accent mono")] : [])]),
				text("content", postText(preview, !!selected.control)),
			], long ? { collapsed: !expanded, toggle } : undefined));
			out.push(row(`actions:post:${selected.seq}`, [
				...(long ? [button("expand", expanded ? "Collapse post" : "Expand post", "Enter", () => toggle(expanded))] : []),
				action("sender", "Inspect sender", "o", { disabled: !this.#host.model.members().some(m => m.name === selected.agent) }),
			]));
		}
		out.push(toolbar);
		if (posts.length && (start || end < posts.length)) {
			const page = (delta: number) => this.#host.interact(this, () => {
				this.#move(delta);
				this.#windowStart = Math.max(0, Math.min(posts.length - WINDOW, start + delta));
			});
			out.push(row("pages", [
				button("older", "Older posts", undefined, () => page(-WINDOW), { disabled: !start }),
				text("window", `${start + 1}–${end} of ${posts.length}`, "num"),
				button("newer", "Newer posts", undefined, () => page(WINDOW), { disabled: end === posts.length }),
			]));
		}
		out.push(list("posts", items, selected ? `post:${selected.seq}` : undefined,
			this.#host.model.head ? "No posts match the filters (x clears them)." : "The board is empty.",
			(pick, activate) => this.#host.interact(this, () => {
				for (let j = start; j < end; j++) {
					const post = posts[j]!;
					if (pick !== `post:${post.seq}`) continue;
					if (activate) this.#expand(post, !this.#expanded.has(post.seq));
					else if (this.#sel !== post.seq || this.#follow) this.#select(post);
					break;
				}
			}), 8));
		return out;
	}

	status(width: number): string {
		if (this.#input) return fit(`${this.#input.kind === "search" ? "/" : "#"}${this.#input.field.value}▏`, width);
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

	#select(post: BoardMessage): void {
		this.#pinFollowWindow();
		this.#follow = false;
		this.#sel = post.seq;
	}

	#pinFollowWindow(): void {
		if (this.#follow) this.#windowStart = Math.max(0, this.#filtered().length - WINDOW);
	}

	#expand(post: BoardMessage, expanded: boolean): boolean {
		const changed = this.#expanded.has(post.seq) !== expanded || this.#follow || this.#sel !== post.seq;
		if (!changed) return false;
		if (expanded) this.#expanded.add(post.seq);
		else this.#expanded.delete(post.seq);
		this.#select(post);
		return true;
	}

	#jump(seq: number): void {
		if (!Number.isSafeInteger(seq) || seq < 1) return;
		const post = this.#host.model.messages()[seq - 1];
		if (!post || post.seq !== seq) return;
		const posts = this.#filtered();
		if (posts[this.#lowerBound(posts, seq)]?.seq !== seq) {
			this.#saved ??= {
				filters: this.#f, sel: this.#sel, follow: this.#follow,
				windowStart: this.#window(posts.length, this.#selIndex(posts)),
			};
			this.#f = NO_FILTERS;
		}
		this.#select(post);
	}

	#move(delta: number): void {
		const list = this.#filtered();
		if (!list.length) return;
		const s = this.#selIndex(list);
		const n = Math.max(0, Math.min(list.length - 1, s + delta));
		const next = list[n]!;
		this.#pinFollowWindow();
		this.#follow = n === list.length - 1 && delta > 0;
		this.#sel = next.seq;
	}

	#selected(): BoardMessage | undefined {
		const list = this.#filtered();
		return list[this.#selIndex(list)];
	}

	handleInput(data: KeyEvent): boolean {
		const { keys } = this.#host;
		const inp = this.#input;
		if (inp) {
			if (keys.cancel(data)) {
				if (inp.kind === "search") this.#f = { ...inp.before, search: "" };
				this.#input = undefined;
				return true;
			}
			if (keys.confirm(data)) {
				this.#input = undefined;
				if (inp.kind === "jump") this.#jump(Number(inp.field.value));
				return true;
			}
			if (inp.field.handleKey(keys, data)) this.#updateSearch(!keys.backspace(data));
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
			const first = list[0];
			if (first) this.#select(first);
			this.#top = 0;
			return true;
		}
		if (keys.end(data)) {
			this.#follow = true;
			return true;
		}
		if (keys.confirm(data)) {
			const m = this.#selected();
			if (m) this.#expand(m, !this.#expanded.has(m.seq));
			return true;
		}
		return this.#shortcut(printable(data));
	}

	#shortcut(data: string | undefined): boolean {
		const { model } = this.#host;
		switch (data) {
			case "/":
				this.#input = { kind: "search", before: this.#f, field: new Capture(`board-search:${++this.#captures}`, "Search posts", this.#f.search, false, inserted => {
					this.#updateSearch(inserted);
					this.#host.requestRender();
				}) };
				return true;
			case "#":
				this.#input = { kind: "jump", field: new Capture(`board-jump:${++this.#captures}`, "Jump to post #", "", true), before: this.#f };
				return true;
			case "n":
				this.#move(1);
				return true;
			case "N":
				this.#move(-1);
				return true;
			case "f": {
				const selected = this.#selected();
				if (this.#follow && selected) this.#select(selected);
				else this.#follow = !this.#follow;
				return true;
			}
			case "u": {
				const cursor = model.coordinatorCursor();
				const first = this.#filtered().find(m => m.seq > cursor);
				if (first) this.#select(first);
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
					this.#windowStart = this.#saved.windowStart;
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
				const chans = [...new Set(["main", ...model.channels().map(c => c.name)])];
				const i = chans.indexOf(this.#f.channel);
				this.#f = { ...this.#f, channel: this.#f.channel === "" ? "main" : chans[i + 1] ?? "" };
				return true;
			}
			case "o": {
				const m = this.#selected();
				if (m && model.members().some(member => member.name === m.agent)) this.#host.open("members", { member: m.agent });
				return true;
			}
		}
		return false;
	}
}
