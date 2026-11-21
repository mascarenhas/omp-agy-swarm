// /swarm: full-screen, keyboard-only, read-only overlay with four views (§10.2). render() returns
// exactly terminal-rows lines; model changes coalesce into one requestRender per 100 ms.

import { TIMING } from "../../env.ts";
import { project, type SwarmReadModel } from "../model.ts";
import { fit, pad, sanitizeLine, width } from "../sanitize.ts";
import { type KeybindingMatcher, Keys, type ThemeLike } from "./keys.ts";
import type { OpenTarget, View, ViewHost, ViewId } from "./view.ts";
import { BoardView } from "./views/board.ts";
import { MembersView } from "./views/members.ts";
import { OverviewView } from "./views/overview.ts";
import { TranscriptView } from "./views/transcript.ts";

export interface TuiLike {
	terminal?: { rows?: number; columns?: number };
	requestRender(): void;
}

const ORDER: ViewId[] = ["overview", "board", "members", "transcript"];
const TAB_WIDE: Record<ViewId, string> = { overview: "1 Overview", board: "2 Board", members: "3 Members", transcript: "4 Transcript" };
const TAB_NARROW: Record<ViewId, string> = { overview: "1Ovw", board: "2Brd", members: "3Mem", transcript: "4Trn" };

const HELP = [
	"Global: 1-4 or Tab/Shift-Tab switch views · ? this help · q or Esc closes",
	"Overview: ↑↓ select · Enter opens the member or post",
	"Board: ↑↓ PgUp PgDn Home End · / search (Enter keeps, Esc clears) · n/N next/previous",
	"  # digits Enter jump to a post (filters are suspended; b restores them)",
	"  a author (A clears) · m mention · c channel · x clear filters · f follow · u first unread",
	"  Enter expand/collapse · o open the sender in Members",
	"Members: ↑↓ · Enter detail · t transcript · K show killed",
	"Transcript: PgUp/PgDn Home/End over the whole history · f follow · [ ] member · / search · Esc back",
	"The board is read-only here: nothing you do moves an agent's read cursor.",
];

export class SwarmOverlay implements ViewHost {
	readonly model: SwarmReadModel;
	readonly theme: ThemeLike;
	readonly keys: Keys;
	readonly #tui: TuiLike;
	readonly #done: () => void;
	readonly #views: Record<ViewId, View>;
	#active: ViewId;
	#stack: { view: ViewId; target?: OpenTarget }[] = [];
	#help = false;
	#unsubscribe: () => void;
	#renderTimer: Timer | undefined;
	#poll: Timer | undefined;
	#filesKey = "";

	constructor(model: SwarmReadModel, tui: TuiLike, theme: ThemeLike, kb: KeybindingMatcher | undefined, done: () => void, initial: ViewId, target?: OpenTarget) {
		this.model = model;
		this.#tui = tui;
		this.theme = theme;
		this.keys = new Keys(kb);
		this.#done = done;
		this.#views = {
			overview: new OverviewView(this),
			board: new BoardView(this),
			members: new MembersView(this),
			transcript: new TranscriptView(this),
		};
		this.#active = initial;
		this.#views[initial].show(target);
		this.#unsubscribe = model.onChange(() => this.requestRender());
		this.#poll = setInterval(() => {
			const key = model.files().key;
			if (key !== this.#filesKey) {
				this.#filesKey = key;
				this.requestRender();
			}
		}, TIMING.uiFilePollMs);
		this.#poll.unref?.();
	}

	requestRender(): void {
		if (this.#renderTimer) return;
		this.#renderTimer = setTimeout(() => {
			this.#renderTimer = undefined;
			this.#tui.requestRender();
		}, TIMING.uiRenderCoalesceMs);
		this.#renderTimer.unref?.();
	}

	/** Follows a link from the current view (Enter, o, t): Esc returns to where it came from. */
	open(view: ViewId, target?: OpenTarget): void {
		const from = this.#active;
		const sel = from === "members" ? { member: (this.#views.members as MembersView).selected() } : undefined;
		if (view !== from) this.#stack.push({ view: from, target: sel });
		this.#show(view, target);
	}

	#show(view: ViewId, target?: OpenTarget): void {
		this.#active = view;
		this.#views[view].show(target);
		this.requestRender();
	}

	/** Returns to the view (and selection) the current one was opened from; false at the top. */
	back(): boolean {
		const r = this.#stack.pop();
		if (!r) return false;
		this.#show(r.view, r.target);
		return true;
	}

	#header(width: number): string {
		const v = project(this.model);
		const c = v.counts;
		const title = sanitizeLine(this.model.title) || "untitled";
		return fit(`swarm ${title} · #${this.model.head} · ●${c.working} ○${c.waiting} ◌${c.stopped} ✗${c.failed} · ${sanitizeLine(v.stateLine)}`, width);
	}

	#tabs(cols: number): string {
		const wide = width(ORDER.map(id => TAB_WIDE[id]).join("  ")) + 2 <= cols;
		return fit(
			ORDER.map(id => {
				const label = wide ? TAB_WIDE[id] : TAB_NARROW[id];
				// Inverse alone can be a no-op (chalk colour level 0); the accent colour keeps the
				// active tab distinguishable wherever the theme colours render.
				return id === this.#active ? this.theme.fg("accent", this.theme.bold(this.theme.inverse(label))) : label;
			}).join(wide ? "  " : " "),
			cols,
		);
	}

	#hints(cols: number): string {
		const hints = this.#views[this.#active].hints();
		let out = "";
		for (const h of hints) {
			const next = out ? `${out}  ${h}` : h;
			if (width(next) > cols) break;
			out = next;
		}
		return this.theme.fg("dim", out);
	}

	render(width: number): string[] {
		const rows = Math.max(1, this.#tui.terminal?.rows ?? 24);
		const cols = width;
		if (rows < 6 || cols < 24) {
			const out = [fit(`swarm: terminal too small (${cols}x${rows})`, cols)];
			while (out.length < rows) out.push("");
			return out;
		}
		const out: string[] = [];
		const compact = rows < 10;
		if (compact) out.push(fit(`${this.#tabs(Math.floor(cols / 2))} ${this.#header(cols)}`, cols));
		else out.push(this.theme.bold(this.#header(cols)), this.#tabs(cols));
		const bottom = compact ? 1 : 2;
		const bodyRows = rows - out.length - bottom;
		const view = this.#views[this.#active];
		if (this.#help) {
			const lines = HELP.map(l => fit(l, cols));
			for (let i = 0; i < bodyRows; i++) out.push(lines[i] ?? "");
			out.push(fit("? or Esc closes the key list", cols));
		} else {
			const body = view.render(cols, bodyRows);
			for (let i = 0; i < bodyRows; i++) out.push(body[i] ?? "");
			out.push(this.theme.fg("muted", pad(view.status(cols), cols)));
		}
		if (!compact) out.push(this.#hints(cols));
		return out.slice(0, rows);
	}

	handleInput(data: string): void {
		const view = this.#views[this.#active];
		if (this.#help) {
			if (data === "?" || this.keys.cancel(data) || data === "q") this.#help = false;
			this.#tui.requestRender();
			return;
		}
		if (view.capturing()) {
			view.handleInput(data);
			this.#tui.requestRender();
			return;
		}
		if (view.handleInput(data)) {
			this.#tui.requestRender();
			return;
		}
		const idx = ORDER.indexOf(this.#active);
		// Switching views directly (digits, Tab) is not a link: it does not grow the back stack.
		if (data >= "1" && data <= "4") this.#show(ORDER[Number(data) - 1] as ViewId);
		else if (this.keys.tab(data)) this.#show(ORDER[(idx + 1) % ORDER.length] as ViewId);
		else if (this.keys.shiftTab(data)) this.#show(ORDER[(idx + ORDER.length - 1) % ORDER.length] as ViewId);
		else if (data === "?") this.#help = true;
		else if (data === "q") return this.#done();
		else if (this.keys.cancel(data) && !this.back()) return this.#done();
		this.#tui.requestRender();
	}

	dispose(): void {
		this.#unsubscribe();
		clearTimeout(this.#renderTimer);
		clearInterval(this.#poll);
	}
}

/** The no-swarm state shown when /swarm runs before any swarm exists. */
export class EmptyOverlay {
	readonly #tui: TuiLike;
	readonly #keys: Keys;
	readonly #done: () => void;
	readonly #reason: string | undefined;

	constructor(tui: TuiLike, kb: KeybindingMatcher | undefined, done: () => void, reason?: string) {
		this.#tui = tui;
		this.#keys = new Keys(kb);
		this.#done = done;
		this.#reason = reason;
	}

	render(width: number): string[] {
		const rows = Math.max(1, this.#tui.terminal?.rows ?? 24);
		const out = [
			fit("swarm · no swarm in this session", width),
			"",
			fit(this.#reason ? `The swarm could not attach: ${sanitizeLine(this.#reason)}` : 'The coordinator creates one with swarm{action:"add", …}.', width),
			"",
			fit("q or Esc closes", width),
		];
		while (out.length < rows) out.push("");
		return out.slice(0, rows);
	}

	handleInput(data: string): void {
		if (data === "q" || this.#keys.cancel(data)) this.#done();
	}

	dispose(): void {}
}
