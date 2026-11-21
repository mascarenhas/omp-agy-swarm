// Shared contract between the /swarm overlay and its four views.

import type { SwarmReadModel } from "../model.ts";
import type { Keys, ThemeLike } from "./keys.ts";

export type ViewId = "overview" | "board" | "members" | "transcript";

export interface OpenTarget {
	member?: string;
	seq?: number;
}

export interface ViewHost {
	readonly model: SwarmReadModel;
	readonly theme: ThemeLike;
	readonly keys: Keys;
	open(view: ViewId, target?: OpenTarget): void;
	/** Returns to the view (and selection) the transcript was opened from. */
	back(): boolean;
	requestRender(): void;
}

export interface View {
	/** Exactly `rows` body lines, each at most `width` columns. */
	render(width: number, rows: number): string[];
	/** The status row (filters, input, position). */
	status(width: number): string;
	/** Key hints that fit the width. */
	hints(): string[];
	/** Returns true when the key was consumed. */
	handleInput(data: string): boolean;
	/** True while a text input or detail pane owns Esc. */
	capturing(): boolean;
	/** Called when the view is shown with a target. */
	show(target?: OpenTarget): void;
}

export const GLYPH: Record<string, string> = {
	working: "●",
	waiting: "○",
	stopped: "◌",
	killed: "✗",
	failed: "✗",
};
