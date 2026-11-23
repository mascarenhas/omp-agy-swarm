// Read-only fullscreen /swarm. Native surfaces split the page and dock; ANSI keeps cell rendering.

import type { Component } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode, NativeScreen, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { basename } from "node:path";
import { TIMING } from "../../env.ts";
import { project, type SwarmReadModel, type ViewFiles } from "../model.ts";
import { fit, pad, sanitizeLine, width } from "../sanitize.ts";
import { type KeybindingMatcher, Keys, type ThemeLike } from "./keys.ts";
import { badge, button, facts, group, NativeCache, nativeKey, presentedEvent, semantic, span, strip, text } from "./native.ts";
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
const TABS = ORDER.map(id => ({ id, label: TAB_WIDE[id] }));

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
const NATIVE_HELP = HELP.map(line => line.startsWith("Members:") ? "Members: ↑↓ · Enter or t opens the transcript · K show killed" : line).join("\n");
// Bound free-form reasons as well as the count-based completion/status badges.
const HEADER_REASON_CHARS = 160;

function headerReason(value: string): string {
	const line = sanitizeLine(value);
	if (line.length <= HEADER_REASON_CHARS) return line;
	return `${line.slice(0, HEADER_REASON_CHARS - 1).replace(/[\ud800-\udbff]$/, "")}…`;
}

export class SwarmOverlay implements ViewHost {
	readonly model: SwarmReadModel;
	readonly theme: ThemeLike;
	readonly keys: Keys;
	readonly #tui: TuiLike;
	readonly #done: () => void;
	readonly #views: Record<ViewId, View>;
	readonly #body: Component = {
		render: width => this.render(width),
		describe: cx => this.#describeBody(cx),
		handleNativeEvent: event => this.#bodyEvent(event),
	};
	readonly #screen: NativeScreen = { role: "omp.swarm", main: [this.#body], dock: [this] };
	readonly #fallback: NativeScreen = { role: "omp.swarm", main: [this], dock: [] };
	readonly #nativeHeader = new NativeCache();
	readonly #nativeTabs = new NativeCache();
	readonly #nativeBody = new NativeCache();
	readonly #nativeDock = new NativeCache();
	#nativeMode = false;
	#disposed = false;
	#active: ViewId;
	#stack: { view: ViewId; target?: OpenTarget }[] = [];
	#help = false;
	#unsubscribe: () => void;
	#renderTimer: Timer | undefined;
	#poll: Timer | undefined;
	#viewFiles: ViewFiles;

	constructor(model: SwarmReadModel, tui: TuiLike, theme: ThemeLike, kb: KeybindingMatcher | undefined, done: () => void, initial: ViewId, target?: OpenTarget) {
		this.model = model;
		this.#tui = tui;
		this.theme = theme;
		this.keys = new Keys(kb);
		this.#done = done;
		this.#viewFiles = model.files();
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
			const files = model.files();
			if (files.key === this.#viewFiles.key) return;
			this.#viewFiles = files;
			this.requestRender();
		}, TIMING.uiFilePollMs);
		this.#poll.unref?.();
	}

	get viewFiles(): ViewFiles { return this.#viewFiles; }

	describeScreen(cx: DescribeContext): NativeScreen {
		this.#nativeMode = semantic(cx);
		return this.#nativeMode ? this.#screen : this.#fallback;
	}

	#describeBody(cx: DescribeContext): NativeNode | null {
		if (!semantic(cx)) return null;
		const profile = nativeKey(cx);
		const version = this.model.version;
		const files = this.#viewFiles;
		const header = this.#nativeHeader.get(`${profile}|${cx.hour12}|${version}|${files.key}`, () => {
			const v = project(this.model, files, { hour12: cx.hour12 });
			const { working, waiting, stopped, failed } = v.counts;
			const spend = this.model.spend();
			const spent = spend.unknown ? "unknown" : `$${spend.cost.toFixed(4)}`;
			const counts = facts(cx, "counts", [
				["Working", String(working), "num"], ["Waiting", String(waiting), "num"], ["Stopped", String(stopped), "num"],
				["Spend", `${spent}${spend.ceiling === null ? "" : ` / $${spend.ceiling}`}`, spend.unknown ? "warning" : "num"],
			], true);
			return group(cx, "header", [
				strip(cx, "title-row", [
					text("title", [span("Swarm  ", "strong"), span(sanitizeLine(this.model.title) || "untitled", "title strong")]),
					badge(cx, "mode", this.model.mode, "info"), text("head", `#${this.model.head}`, "num"),
				]),
				{ k: "text", key: "directory", p: { spans: [span(`…/${basename(this.model.swarmDir)}`, "muted path")], wrap: "none", truncate: "middle" } },
				counts,
				strip(cx, "state", [
					badge(cx, "outcome", headerReason(v.stateLine), v.stateLine.startsWith("incomplete") ? "error" : v.stateLine.startsWith("complete") ? "success" : "neutral"),
					...(failed ? [badge(cx, "failed", `${failed} failed`, "error")] : []),
					badge(cx, "attention", `${v.attention.length} attention`, v.attention.length ? "warning" : "muted"),
				]),
				...(spend.unknown ? [text("unpriced", headerReason(spend.unknown), "warning")] : []),
			], "omp.swarm.header");
		});
		// Tern can paint a patched `tabs.active` one frame late. Remount just
		// this control on tab switches so its initial state agrees with the view.
		const tabs = this.#nativeTabs.get(`${profile}|${this.#active}`, () => cx.supports("tabs")
			? { k: "tabs", key: `tabs:${this.#active}`, p: { items: TABS, active: this.#active, variant: "underline" } }
			: strip(cx, "tabs", TABS.map((tab, i) => button(cx, tab.id, tab.label.slice(2), String(i + 1), { on: tab.id === this.#active }))));
		const helpInline = this.#help && !cx.supports("overlay");
		const view = helpInline ? undefined : this.#views[this.#active].describe(cx);
		return this.#nativeBody.get(`${profile}|${cx.hour12}|${version}|${files.key}|${this.#active}|${helpInline}`, () => group(cx, "page", [
			header, tabs, view ?? text("inline-help", `Swarm keys\n${NATIVE_HELP}`, undefined, "omp.swarm.help"),
		], "omp.swarm.page"), view);
	}

	describe(cx: DescribeContext): NativeNode | null {
		if (!semantic(cx)) return null;
		const view = this.#views[this.#active];
		const field = this.#help ? undefined : view.describeField?.(cx);
		const status = this.#help ? "Read-only keyboard reference" : view.nativeStatus(cx);
		return this.#nativeDock.get(`${nativeKey(cx)}|${this.#active}|${this.#help}|${!!this.#stack.length}|${status}`, () => {
			const legend = text("keys", (this.#help ? ["? or Esc closes help"] : view.hints(true)).flatMap((hint, i) => [
				...(i ? [span("  ")] : []), span(hint, "key"),
			]));
			const commands = this.#help
				? cx.supports("overlay") ? [] : [button(cx, "close-help", "Close help", "Esc")]
				: field ? [] : [
					button(cx, "help", "Keys", "?"),
					...(this.#stack.length ? [button(cx, "back", "Back", "Esc")] : []),
					button(cx, "close", "Close", "q"),
				];
			const dock: NativeNode[] = [text("status", status, "muted")];
			if (field) dock.push(field);
			dock.push(strip(cx, "commands", [legend, ...commands]));
			if (this.#help && cx.supports("overlay")) dock.push({
				k: "overlay", key: "help", p: { role: "omp.swarm.help", modal: true, head: [span("Swarm keys", "strong")], size: "lg", anchor: "center" },
				c: [text("instructions", NATIVE_HELP), button(cx, "close-help", "Close help", "Esc")],
			});
			return group(cx, "dock", dock, "omp.swarm.dock");
		}, field);
	}

	#bodyEvent(event: NativeUiEvent): void {
		const view = this.#views[this.#active];
		if (this.#disposed || !this.#nativeMode || this.#help || view.capturing(true)) return;
		if (!presentedEvent(this.#nativeBody.node, event)) return;
		const tab = (event.type === "select" || event.type === "activate") && event.key === `tabs:${this.#active}`
			? ORDER.find(id => id === event.item)
			: event.type === "action" ? ORDER.find(id => event.key === `tabs/${id}` && event.act === `swarm.${id}`) : undefined;
		if (tab) {
			if (tab !== this.#active) this.#show(tab);
			return;
		}
		const prefix = `${this.#active}/`;
		if (event.key.startsWith(prefix) && view.handleNativeEvent(event, event.key.slice(prefix.length))) this.#tui.requestRender();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed || !this.#nativeMode || !presentedEvent(this.#nativeDock.node, event)) return;
		if (this.#help) {
			if (event.type === "action" && event.act === "swarm.close-help" && (event.key === "help/close-help" || event.key === "commands/close-help")) this.#setHelp(false);
			return;
		}
		const view = this.#views[this.#active];
		if (view.capturing(true)) {
			if (view.handleFieldEvent?.(event)) this.#tui.requestRender();
			return;
		}
		if (event.type !== "action") return;
		if (event.key === "commands/help" && event.act === "swarm.help") this.#setHelp(true);
		if (event.key === "commands/back" && event.act === "swarm.back" && this.#stack.length) this.handleInput("\x1b");
		if (event.key === "commands/close" && event.act === "swarm.close") this.handleInput("q");
	}

	#setHelp(show: boolean): void {
		this.#help = show;
		this.#tui.requestRender();
	}

	requestRender(): void {
		if (this.#disposed || this.#renderTimer) return;
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
		const v = project(this.model, this.#viewFiles);
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
		this.#nativeMode = false;
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
		if (this.#disposed) return;
		const view = this.#views[this.#active];
		if (this.#help) {
			if (data === "?" || this.keys.cancel(data) || data === "q") this.#setHelp(false);
			return;
		}
		if (view.capturing(this.#nativeMode)) {
			view.handleInput(data, this.#nativeMode);
			this.#tui.requestRender();
			return;
		}
		if (view.handleInput(data, this.#nativeMode)) {
			this.#tui.requestRender();
			return;
		}
		const idx = ORDER.indexOf(this.#active);
		// Switching views directly (digits, Tab) is not a link: it does not grow the back stack.
		if (/^[1-4]$/.test(data)) this.#show(ORDER[Number(data) - 1]!);
		else if (this.keys.tab(data)) this.#show(ORDER[(idx + 1) % ORDER.length] as ViewId);
		else if (this.keys.shiftTab(data)) this.#show(ORDER[(idx + ORDER.length - 1) % ORDER.length] as ViewId);
		else if (data === "?") return this.#setHelp(true);
		else if (data === "q" || (this.keys.cancel(data) && !this.back())) {
			this.dispose();
			return this.#done();
		}
		this.#tui.requestRender();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
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
	readonly #screen: NativeScreen = { role: "omp.swarm", main: [this], dock: [] };
	readonly #native = new NativeCache();
	#closed = false;

	constructor(tui: TuiLike, kb: KeybindingMatcher | undefined, done: () => void, reason?: string) {
		this.#tui = tui;
		this.#keys = new Keys(kb);
		this.#done = done;
		this.#reason = reason;
	}

	describeScreen(): NativeScreen { return this.#screen; }

	describe(cx: DescribeContext): NativeNode | null {
		if (!semantic(cx)) return null;
		return this.#native.get(nativeKey(cx), () => group(cx, "empty", [
			text("title", this.#reason ? "Swarm could not attach" : "No swarm in this session", "title strong"),
			text("reason", this.#reason ?? 'The coordinator creates one with swarm{action:"add", …}.', this.#reason ? "warning" : "muted"),
			button(cx, "close", "Close", "q"),
			text("keys", "q or Esc closes", "key"),
		], this.#reason ? "omp.swarm.refused" : "omp.swarm.empty"));
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.key === "close" && event.act === "swarm.close") this.handleInput("q");
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
		if (this.#closed || data !== "q" && !this.#keys.cancel(data)) return;
		this.#closed = true;
		this.#done();
	}

	dispose(): void { this.#closed = true; }
}
