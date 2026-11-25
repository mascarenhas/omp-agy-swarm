// Untrusted text → terminal-safe text, and width helpers (SW-12). Every title, post, activity
// line, tool output, model id and file content passes sanitize() before any styling.

import { truncate, visibleWidth, wrap as wrapText } from "@oh-my-pi/pi-tui/text/width";

// ESC/CSI/OSC/DCS sequences, C0/C1 controls (except \n and \t handled separately), bidi overrides
// and isolates, and other invisible format characters that can reorder or hide text.
const ESC_SEQ = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[ -/]*[0-~]?)/g;
const C1_CSI = /\u009b[0-?]*[ -/]*[@-~]/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

/** Removes control sequences, control characters, and lone surrogates. Tabs become spaces; newlines stay. */
export function sanitize(text: unknown): string {
	return String(text ?? "")
		.replace(ESC_SEQ, "")
		.replace(C1_CSI, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(CONTROLS, "")
		.replace(BIDI, "")
		.replace(/\p{Surrogate}/gu, "");
}

/** sanitize() and fold to one line. */
export function sanitizeLine(text: unknown): string {
	return sanitize(text).replace(/\s*\n\s*/g, " ").trim();
}

export function width(text: string): number {
	return visibleWidth(text);
}

/** Cuts to `cols` visible columns (ellipsis when cut). */
export function fit(text: string, cols: number): string {
	if (cols <= 0) return "";
	return truncate(text, cols);
}

/** Cuts and pads to exactly `cols` visible columns. */
export function pad(text: string, cols: number): string {
	const t = fit(text, cols);
	const w = visibleWidth(t);
	return w < cols ? t + " ".repeat(cols - w) : t;
}

export function wrap(text: string, cols: number): string[] {
	if (cols <= 0) return [];
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (line === "") out.push("");
		else out.push(...wrapText(line, cols));
	}
	return out;
}
