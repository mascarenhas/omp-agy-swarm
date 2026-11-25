// Key handling for the /swarm overlay: navigation through the host's keybinding ids; literal keys
// only for app actions (§10.2).

import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import type { KeyEvent } from "@oh-my-pi/pi-tui";

type SelectionAction = `tui.select.${"up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel"}`;

export interface KeybindingMatcher {
	matches(event: KeyEvent, action: SelectionAction): boolean;
}

export type ThemeLike = ExtensionTheme;

export function isKey(key: KeyEvent, id: string): boolean {
	return key.kind !== "release" && key.id === id;
}

export class Keys {
	constructor(private readonly kb: KeybindingMatcher | undefined) {}

	#matches(key: KeyEvent, action: SelectionAction, fallback: string): boolean {
		return key.kind !== "release" && (key.id === fallback || this.kb?.matches(key, action) === true);
	}

	up(key: KeyEvent): boolean { return this.#matches(key, "tui.select.up", "up"); }
	down(key: KeyEvent): boolean { return this.#matches(key, "tui.select.down", "down"); }
	pageUp(key: KeyEvent): boolean { return this.#matches(key, "tui.select.pageUp", "pageUp"); }
	pageDown(key: KeyEvent): boolean { return this.#matches(key, "tui.select.pageDown", "pageDown"); }
	confirm(key: KeyEvent): boolean { return this.#matches(key, "tui.select.confirm", "enter"); }
	cancel(key: KeyEvent): boolean { return this.#matches(key, "tui.select.cancel", "escape"); }
	home(key: KeyEvent): boolean { return isKey(key, "home"); }
	end(key: KeyEvent): boolean { return isKey(key, "end"); }
	tab(key: KeyEvent): boolean { return isKey(key, "tab"); }
	shiftTab(key: KeyEvent): boolean { return isKey(key, "shift+tab"); }
	backspace(key: KeyEvent): boolean { return isKey(key, "backspace"); }
}

/** Text produced by a key, including kitty and non-ASCII keys but never releases. */
export function printable(key: KeyEvent): string | undefined {
	return key.kind === "release" ? undefined : key.text;
}
