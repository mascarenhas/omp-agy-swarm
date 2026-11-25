// Shared contract between the /swarm overlay and its four views.

import { nativeSupports, signal, type Accessor, type KeyEvent, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import type { SwarmReadModel, ViewFiles } from "../model.ts";
import type { Keys, ThemeLike } from "./keys.ts";
import { sanitize } from "../sanitize.ts";
import { printable } from "./keys.ts";
import { input, span, text } from "./native.ts";

export type ViewId = "overview" | "board" | "members" | "transcript";

export interface OpenTarget {
	member?: string;
	seq?: number;
}

export interface ViewHost {
	readonly model: SwarmReadModel;
	readonly theme: ThemeLike;
	readonly keys: Keys;
	readonly viewFiles: ViewFiles;
	open(view: ViewId, target?: OpenTarget): void;
	/** Returns to the view (and selection) the transcript was opened from. */
	back(): boolean;
	/** Runs an action from the currently visible view unless help or a text field owns the input. */
	interact(view: View, action: () => void): void;
	requestRender(): void;
}

export interface View {
	/** Exactly `rows` body lines, each at most `width` columns. */
	render(width: number, rows: number): string[];
	/** The status row (filters, input, position). */
	status(width: number): string;
	/** Key hints that fit the width. */
	hints(native?: boolean): string[];
	/** Returns true when the key was consumed. */
	handleInput(key: KeyEvent, native?: boolean): boolean;
	/** True while a text input or detail pane owns Esc. */
	capturing(native?: boolean): boolean;
	/** Called when the view is shown with a target. */
	show(target?: OpenTarget): void;
	native(revision: Accessor<number>): UiNode;
	/** The native page presents this field while capturing input. */
	field?(): Capture | undefined;
	nativeStatus(): string;
}

/** One bounded edit buffer for PTY keys and TSP selection edits. */
export class Capture {
	readonly #prompt: string;
	readonly #key: string;
	readonly #digits: boolean;
	#text: string;
	#cursor: number;
	readonly #undo: { text: string; cursor: number }[] = [];
	readonly #revision = signal(0);
	readonly #changed: ((inserted: boolean) => void) | undefined;

	constructor(key: string, prompt: string, initial: string, digits = false, changed?: (inserted: boolean) => void) {
		this.#key = key;
		this.#prompt = prompt;
		this.#digits = digits;
		this.#changed = changed;
		this.#text = this.#clean(initial);
		this.#cursor = this.#text.length;
	}

	get value(): string { return this.#text; }

	#clean(value: string): string {
		const plain = sanitize(value).replace(/\n/g, " ");
		return this.#digits ? plain.replace(/[^0-9]/g, "").slice(0, 16) : plain;
	}

	#offset(text: string, n: number, bias = -1): number {
		const at = Number.isFinite(n) ? Math.max(0, Math.min(Math.trunc(n), text.length)) : 0;
		const lo = text.charCodeAt(at);
		const hi = text.charCodeAt(at - 1);
		return lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff ? at + bias : at;
	}

	#replace(from: number, to: number, raw: string, cursor: number): boolean {
		const a = this.#offset(this.#text, Math.min(from, to));
		// A caret move or insertion must not delete a pair at a split offset.
		const b = from === to ? a : this.#offset(this.#text, Math.max(from, to), 1);
		const free = (this.#digits ? 16 : 256) - (this.#text.length - (b - a));
		const clean = this.#clean(raw);
		const insert = clean.slice(0, this.#offset(clean, free));
		const next = this.#text.slice(0, a) + insert + this.#text.slice(b);
		const caret = this.#offset(next, cursor <= a ? cursor
			: cursor < a + raw.length ? a + Math.min(insert.length, this.#clean(raw.slice(0, cursor - a)).length)
			: cursor + insert.length - raw.length);
		if (next === this.#text && caret === this.#cursor) return false;
		if (next !== this.#text) {
			if (this.#undo.length === 32) this.#undo.shift();
			this.#undo.push({ text: this.#text, cursor: this.#cursor });
		}
		this.#text = next;
		this.#cursor = caret;
		this.#revision.update(n => n + 1);
		return true;
	}

	handleKey(keys: Keys, data: KeyEvent): boolean {
		if (keys.backspace(data) && this.#cursor > 0) {
			const from = this.#offset(this.#text, this.#cursor - 1);
			return this.#replace(from, this.#cursor, "", from);
		}
		const ch = printable(data);
		return !!ch && this.#replace(this.#cursor, this.#cursor, ch, this.#cursor + ch.length);
	}

	paste(text: string): boolean {
		if (!this.#replace(this.#cursor, this.#cursor, text, this.#cursor + text.length)) return false;
		this.#changed?.(true);
		return true;
	}

	#edit(event: Extract<UiEvent, { type: "edit" }>): void {
		if (event.len === this.#text.length && this.#replace(event.from, event.to, event.text, event.cursor)) this.#changed?.(!!event.text);
	}

	#undoEdit(): void {
		const previous = this.#undo.pop();
		if (!previous) return;
		this.#text = previous.text;
		this.#cursor = previous.cursor;
		this.#revision.update(n => n + 1);
		this.#changed?.(false);
	}

	native(): UiNode {
		if (!nativeSupports("input")) return text(this.#key, () => {
			this.#revision();
			return [span(`${this.#prompt}: ${this.#text}▏`, "mono")];
		});
		return input(this.#key, {
			prompt: `${this.#prompt}: `,
			text: () => { this.#revision(); return this.#text; },
			cursor: () => { this.#revision(); return this.#cursor; },
			sendable: false,
			onEdit: event => this.#edit(event),
			onUndo: () => this.#undoEdit(),
		});
	}
}

export const GLYPH: Record<string, string> = {
	working: "●",
	waiting: "○",
	stopped: "◌",
	killed: "✗",
	failed: "✗",
};
