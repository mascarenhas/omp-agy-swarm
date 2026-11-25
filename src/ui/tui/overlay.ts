// Read-only fullscreen /swarm. Native surfaces split the page and dock; ANSI keeps cell rendering.

import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import { createRoot, nativeRendering, nativeSupports, signal, structural, type KeyEvent, type PasteEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { basename } from "node:path";
import { TIMING } from "../../env.ts";
import { project, type SwarmReadModel, type ViewFiles } from "../model.ts";
import { fit, pad, sanitizeLine, width } from "../sanitize.ts";
import { type KeybindingMatcher, Keys, printable, type ThemeLike } from "./keys.ts";
import { badge, button, col, facts, node, overlay, row, span, tabs, text } from "./native.ts";
import type { OpenTarget, View, ViewHost, ViewId } from "./view.ts";
import { BoardView } from "./views/board.ts";
import { MembersView } from "./views/members.ts";
import { OverviewView } from "./views/overview.ts";
import { TranscriptView } from "./views/transcript.ts";

type ViewSize = Pick<ExtensionUiHost, "size">;

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
	readonly #ui: ViewSize;
	readonly #done: () => void;
	readonly #views: Record<ViewId, View> & { members: MembersView };
	readonly #revision = signal(0);
	#disposeNodes: (() => void) | undefined;
	#disposed = false;
	#active: ViewId;
	#stack: { view: ViewId; target?: OpenTarget }[] = [];
	#help = false;
	#unsubscribe: () => void;
	#renderTimer: Timer | undefined;
	#poll: Timer | undefined;
	#viewFiles: ViewFiles;

	constructor(model: SwarmReadModel, ui: ViewSize, theme: ThemeLike, kb: KeybindingMatcher | undefined, done: () => void, initial: ViewId, target?: OpenTarget) {
		this.model = model;
		this.#ui = ui;
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
		this.#unsubscribe = model.onChange(() => this.#scheduleUpdate());
		this.#poll = setInterval(() => {
			const files = model.files();
			if (files.key === this.#viewFiles.key) return;
			this.#viewFiles = files;
			this.#scheduleUpdate();
		}, TIMING.uiFilePollMs);
		this.#poll.unref?.();
	}

	get viewFiles(): ViewFiles { return this.#viewFiles; }

	component(): UiNode {
		return createRoot(dispose => {
			this.#disposeNodes = dispose;
			if (nativeRendering()) return this.#nativePage();
			return node("canvas", "swarm", {
				paint: width => { this.#revision(); return this.render(width); },
				onKey: key => this.#handleKey(key, false),
				onPaste: paste => this.#paste(paste),
			});
		});
	}

	#nativePage(): UiNode {
		const revision = this.#revision;
		const active = structural(() => { revision(); return this.#active; });
		const help = structural(() => { revision(); return this.#help; });
		const headerKey = structural(() => { revision(); return `${this.model.version}|${this.#viewFiles.key}`; });
		const field = structural(() => { revision(); return this.#help ? undefined : this.#views[this.#active].field?.(); });
		const content = col("page", [
			() => { headerKey(); return this.#nativeHeader(); },
			() => tabs(TABS, active(), view => {
				if (view !== this.#active) this.interact(this.#views[this.#active], () => this.#show(view));
			}),
			// The host focuses this page. TSP focuses its first input without changing program focus.
			() => field()?.native(),
			() => !nativeSupports("overlay") && help()
				? text("inline-help", `Swarm keys\n${NATIVE_HELP}`, undefined, "omp.swarm.help")
				: this.#views[active()].native(revision),
		], "omp.swarm.page");
		const dock = col("dock", [
			() => { revision(); return text("status", help() ? "Read-only keyboard reference" : this.#views[active()].nativeStatus(), "muted"); },
			() => {
				revision();
				const hints = help() ? ["? or Esc closes help"] : this.#views[active()].hints(true);
				const legend = text("keys", hints.flatMap((hint, i) => [...(i ? [span("  ")] : []), span(hint, "key")]));
				if (help()) return row("commands", [legend, ...(!nativeSupports("overlay") ? [button("close-help", "Close help", "Esc", () => this.#setHelp(false))] : [])]);
				return row("commands", field() ? [legend] : [
					legend,
					button("help", "Keys", "?", () => this.#setHelp(true)),
					...(this.#stack.length ? [button("back", "Back", "Esc", () => this.interact(this.#views[this.#active], () => this.back()))] : []),
					button("close", "Close", "q", () => this.#close()),
				]);
			},
			// In TSP, overlays under dock are hoisted into layer with their structural event path intact.
			() => help() && nativeSupports("overlay") && overlay("help", {
				role: "omp.swarm.help", modal: true, head: [span("Swarm keys", "strong")], size: "lg", anchor: "center",
				children: [text("instructions", NATIVE_HELP), button("close-help", "Close help", "Esc", () => this.#setHelp(false))],
			}),
		], "omp.swarm.dock");
		return overlay("swarm", {
			size: "full", page: { role: "omp.swarm", dock: 1 }, children: [content, dock],
			onKey: key => this.#handleKey(key, true),
			onPaste: paste => this.#paste(paste),
			// Keep program focus on the stable page when the peer interacts with a transient child.
			onFocus: () => {},
		});
	}

	#nativeHeader(): UiNode {
		// ExtensionUiHost does not expose the peer's clock preference. Use the locale's
		// time format and the saved wait deadline, never a repaint-time countdown.
		const v = project(this.model, this.#viewFiles, {});
		const { working, waiting, stopped, failed } = v.counts;
		const spend = this.model.spend();
		const spent = spend.unknown ? "unknown" : `$${spend.cost.toFixed(4)}`;
		return col("header", [
			row("title-row", [
				text("title", [span("Swarm  ", "strong"), span(sanitizeLine(this.model.title) || "untitled", "title strong")]),
				badge("mode", this.model.mode, "info"), text("head", `#${this.model.head}`, "num"),
			]),
			node("text", "directory", { spans: [span(`…/${basename(this.model.swarmDir)}`, "muted path")], wrap: "none", truncate: "middle" }),
			facts("counts", [
				["Working", String(working), "num"], ["Waiting", String(waiting), "num"], ["Stopped", String(stopped), "num"],
				["Spend", `${spent}${spend.ceiling === null ? "" : ` / $${spend.ceiling}`}`, spend.unknown ? "warning" : "num"],
			], true),
			row("state", [
				badge("outcome", headerReason(v.stateLine), v.stateLine.startsWith("incomplete") ? "error" : v.stateLine.startsWith("complete") ? "success" : "neutral"),
				...(failed ? [badge("failed", `${failed} failed`, "error")] : []),
				badge("attention", `${v.attention.length} attention`, v.attention.length ? "warning" : "muted"),
			]),
			...(spend.unknown ? [text("unpriced", headerReason(spend.unknown), "warning")] : []),
		], "omp.swarm.header");
	}

	interact(view: View, action: () => void): void {
		if (this.#disposed || this.#help || this.#views[this.#active] !== view || view.capturing(true)) return;
		action();
		this.#refresh();
	}

	#setHelp(show: boolean): void {
		if (this.#help === show || this.#disposed || show && this.#views[this.#active].capturing(true)) return;
		this.#help = show;
		this.#refresh();
	}

	#refresh(): void {
		if (!this.#disposed) this.#revision.update(n => n + 1);
	}

	requestRender(): void { this.#refresh(); }

	#scheduleUpdate(): void {
		if (this.#disposed || this.#renderTimer) return;
		this.#renderTimer = setTimeout(() => {
			this.#renderTimer = undefined;
			this.#refresh();
		}, TIMING.uiRenderCoalesceMs);
		this.#renderTimer.unref?.();
	}

	/** Follows a link from the current view (Enter, o, t): Esc returns to where it came from. */
	open(view: ViewId, target?: OpenTarget): void {
		const from = this.#active;
		const sel = from === "members" ? { member: this.#views.members.selected() } : undefined;
		if (view !== from) this.#stack.push({ view: from, target: sel });
		this.#show(view, target);
	}

	#show(view: ViewId, target?: OpenTarget): void {
		this.#active = view;
		this.#views[view].show(target);
		this.#refresh();
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
		const rows = Math.max(1, this.#ui.size().rows);
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

	#handleKey(key: KeyEvent, native: boolean): boolean {
		if (this.#disposed || key.kind === "release") return false;
		const ch = printable(key);
		const view = this.#views[this.#active];
		if (this.#help) {
			if (ch === "?" || this.keys.cancel(key) || ch === "q") this.#setHelp(false);
			return true;
		}
		const captured = view.capturing(native);
		if (view.handleInput(key, native) || captured) {
			this.#refresh();
			return true;
		}
		const idx = ORDER.indexOf(this.#active);
		// Switching views directly (digits, Tab) is not a link: it does not grow the back stack.
		if (ch && /^[1-4]$/.test(ch)) this.#show(ORDER[Number(ch) - 1]!);
		else if (this.keys.tab(key)) this.#show(ORDER[(idx + 1) % ORDER.length]!);
		else if (this.keys.shiftTab(key)) this.#show(ORDER[(idx + ORDER.length - 1) % ORDER.length]!);
		else if (ch === "?") this.#setHelp(true);
		else if (ch === "q") this.#close();
		else if (this.keys.cancel(key)) { if (!this.back()) this.#close(); }
		else return false;
		return true;
	}

	#paste(paste: PasteEvent): boolean {
		if (this.#disposed || this.#help) return false;
		const field = this.#views[this.#active].field?.();
		if (!field) return false;
		if (field.paste(paste.text)) this.#refresh();
		return true;
	}

	#close(): void {
		if (this.#disposed || this.#help || this.#views[this.#active].capturing(true)) return;
		try { this.#done(); } finally { this.dispose(); }
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		clearTimeout(this.#renderTimer);
		clearInterval(this.#poll);
		this.#disposeNodes?.();
	}
}

/** The no-swarm state shown when /swarm runs before any swarm exists. */
export class EmptyOverlay {
	readonly #ui: ViewSize;
	readonly #keys: Keys;
	readonly #done: () => void;
	readonly #reason: string | undefined;
	#closed = false;
	#disposeNodes: (() => void) | undefined;

	constructor(ui: ViewSize, kb: KeybindingMatcher | undefined, done: () => void, reason?: string) {
		this.#ui = ui;
		this.#keys = new Keys(kb);
		this.#done = done;
		this.#reason = reason;
	}

	component(): UiNode {
		return createRoot(dispose => {
			this.#disposeNodes = dispose;
			if (!nativeRendering()) return node("canvas", "swarm", { paint: width => this.render(width), onKey: key => this.#handleKey(key) });
			return overlay("swarm", {
				size: "full", page: { role: "omp.swarm", dock: 0 }, onKey: key => this.#handleKey(key),
				onFocus: () => {},
				children: [col("empty", [
					text("title", this.#reason ? "Swarm could not attach" : "No swarm in this session", "title strong"),
					text("reason", this.#reason ?? 'The coordinator creates one with swarm{action:"add", …}.', this.#reason ? "warning" : "muted"),
					button("close", "Close", "q", () => this.#close()),
					text("keys", "q or Esc closes", "key"),
				], this.#reason ? "omp.swarm.refused" : "omp.swarm.empty")],
			});
		});
	}

	render(width: number): string[] {
		const rows = Math.max(1, this.#ui.size().rows);
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

	#handleKey(key: KeyEvent): boolean {
		if (this.#closed || printable(key) !== "q" && !this.#keys.cancel(key)) return false;
		this.#close();
		return true;
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try { this.#done(); } finally { this.dispose(); }
	}

	dispose(): void {
		this.#closed = true;
		this.#disposeNodes?.();
		this.#disposeNodes = undefined;
	}
}
