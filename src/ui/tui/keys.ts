// Key handling for the /swarm overlay: navigation through the host's keybinding ids; literal keys
// only for app actions (§10.2).

import { type KeyId, matchesKey } from "@oh-my-pi/pi-tui";

export interface KeybindingMatcher {
	matches(data: string, id: string): boolean;
}

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
}

export class Keys {
	readonly #kb: KeybindingMatcher | undefined;

	constructor(kb: KeybindingMatcher | undefined) {
		this.#kb = kb;
	}

	#m(data: string, id: string, fallback: string): boolean {
		try {
			if (this.#kb?.matches(data, id)) return true;
		} catch {}
		try {
			return matchesKey(data, fallback as KeyId);
		} catch {
			return false;
		}
	}

	up(d: string): boolean {
		return this.#m(d, "tui.select.up", "up");
	}
	down(d: string): boolean {
		return this.#m(d, "tui.select.down", "down");
	}
	pageUp(d: string): boolean {
		return this.#m(d, "tui.select.pageUp", "pageUp");
	}
	pageDown(d: string): boolean {
		return this.#m(d, "tui.select.pageDown", "pageDown");
	}
	confirm(d: string): boolean {
		return this.#m(d, "tui.select.confirm", "enter");
	}
	cancel(d: string): boolean {
		return this.#m(d, "tui.select.cancel", "escape");
	}
	home(d: string): boolean {
		return safeMatch(d, "home");
	}
	end(d: string): boolean {
		return safeMatch(d, "end");
	}
	tab(d: string): boolean {
		return d === "\t";
	}
	shiftTab(d: string): boolean {
		return d === "\x1b[Z" || safeMatch(d, "shift+tab");
	}
	backspace(d: string): boolean {
		return d === "\x7f" || d === "\b" || safeMatch(d, "backspace");
	}
}

function safeMatch(d: string, key: string): boolean {
	try {
		return matchesKey(d, key as KeyId);
	} catch {
		return false;
	}
}

/** A printable single character typed by the user (for search and jump inputs). */
export function printable(d: string): string | undefined {
	if (d.length === 0 || d.startsWith("\x1b")) return undefined;
	const cp = d.codePointAt(0) ?? 0;
	if (cp < 0x20 || cp === 0x7f) return undefined;
	return [...d].length === 1 ? d : undefined;
}
