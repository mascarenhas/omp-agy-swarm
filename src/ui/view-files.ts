// plan.json / view.json / view.html readers with caps, last-good parses and descriptor-verified,
// bounded file reads (SW-08). Shared by the TUI, the web board and its file routes.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { LIMITS } from "../env.ts";
import type { ViewFiles } from "./model.ts";

export type SafeReadFailure = "invalid" | "outside" | "missing" | "not_file" | "too_large" | "unverifiable";

export type SafeReadResult =
	| { ok: true; buf: Buffer; real: string; size: number; mtimeMs: number }
	| { ok: false; reason: SafeReadFailure };

/** Canonical roots with a trailing separator (computed once by the caller). */
export function canonicalRoots(roots: readonly string[]): string[] {
	const out: string[] = [];
	for (const r of roots) {
		try {
			const real = realpathSync(r);
			out.push(real.endsWith(sep) ? real : real + sep);
		} catch {}
	}
	return out;
}

/** Path rules shared by every route: absolute, no NUL/%/\, no "." or ".." segment. */
export function validTargetPath(target: unknown): target is string {
	if (typeof target !== "string" || !target || target.length > 4096 || !isAbsolute(target)) return false;
	if (/[%\0\\]/.test(target)) return false;
	return !target.split("/").some(seg => seg === "." || seg === "..");
}

/**
 * Reads a regular file under one of `roots` (canonical, with trailing separator). Containment is
 * verified on the opened descriptor itself (/proc/self/fd on Linux), never on a post-open stat of
 * the path; where that cannot be established the read fails closed. At most maxBytes + 1 bytes
 * are ever read.
 */
export function safeRead(target: string, roots: readonly string[], maxBytes: number): SafeReadResult {
	if (!validTargetPath(target)) return { ok: false, reason: "invalid" };
	let real: string;
	try {
		real = realpathSync(target);
	} catch {
		return { ok: false, reason: "missing" };
	}
	if (!roots.some(r => real.startsWith(r))) return { ok: false, reason: "outside" };
	let fd: number;
	try {
		fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return { ok: false, reason: "missing" };
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return { ok: false, reason: "not_file" };
		if (st.size > maxBytes) return { ok: false, reason: "too_large" };
		if (process.platform !== "linux") return { ok: false, reason: "unverifiable" };
		let opened: string;
		try {
			opened = realpathSync(`/proc/self/fd/${fd}`);
		} catch {
			return { ok: false, reason: "unverifiable" };
		}
		if (!roots.some(r => opened.startsWith(r))) return { ok: false, reason: "outside" };
		const cap = maxBytes + 1;
		const buf = Buffer.allocUnsafe(Math.min(cap, Math.max(1, st.size + 1)));
		let total = 0;
		const chunks: Buffer[] = [];
		for (;;) {
			const chunk = total === 0 ? buf : Buffer.allocUnsafe(Math.min(64 * 1024, cap - total));
			if (chunk.length === 0) break;
			const n = readSync(fd, chunk, 0, chunk.length, null);
			if (n <= 0) break;
			chunks.push(chunk.subarray(0, n));
			total += n;
			if (total >= cap) break;
		}
		if (total > maxBytes) return { ok: false, reason: "too_large" };
		return { ok: true, buf: Buffer.concat(chunks, total), real: opened, size: total, mtimeMs: st.mtimeMs };
	} finally {
		closeSync(fd);
	}
}

interface FileState {
	key: string;
	good: Record<string, unknown> | null;
	error?: string;
	text: string;
}

function statKey(path: string): string {
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "-";
	}
}

/** Reads the swarm dir's Overview files only when their stat key changes; keeps the last good JSON. */
export class ViewFilesReader {
	readonly #dir: string;
	readonly #roots: string[];
	#plan: FileState = { key: "", good: null, text: "" };
	#view: FileState = { key: "", good: null, text: "" };
	#html: { key: string; text: string | null; error?: string } = { key: "", text: null };
	#out: ViewFiles | undefined;

	constructor(dir: string) {
		this.#dir = dir;
		this.#roots = canonicalRoots([dir]);
	}

	#json(name: string, prev: FileState): FileState {
		const path = join(this.#dir, name);
		const key = statKey(path);
		if (key === prev.key) return prev;
		if (key === "-") return { key, good: null, text: "" };
		const r = safeRead(path, this.#roots, LIMITS.viewFileBytes);
		if (!r.ok) return { key, good: prev.good, error: r.reason, text: prev.text };
		const text = r.buf.toString("utf8");
		try {
			const v = JSON.parse(text) as unknown;
			if (v && typeof v === "object" && !Array.isArray(v)) return { key, good: v as Record<string, unknown>, text };
			return { key, good: prev.good, error: "invalid", text };
		} catch {
			return { key, good: prev.good, error: "invalid", text };
		}
	}

	read(): ViewFiles {
		this.#plan = this.#json("plan.json", this.#plan);
		this.#view = this.#json("view.json", this.#view);
		const hpath = join(this.#dir, "view.html");
		const hkey = statKey(hpath);
		if (hkey !== this.#html.key) {
			if (hkey === "-") this.#html = { key: hkey, text: null };
			else {
				const r = safeRead(hpath, this.#roots, LIMITS.viewFileBytes);
				if (!r.ok) this.#html = { key: hkey, text: null, error: r.reason };
				else {
					const text = r.buf.toString("utf8");
					this.#html = text.trim() ? { key: hkey, text } : { key: hkey, text: null, error: "empty" };
				}
			}
		}
		const key = `${this.#plan.key}|${this.#view.key}|${this.#html.key}`;
		if (this.#out && this.#out.key === key) return this.#out;
		this.#out = {
			key,
			plan: this.#plan.good,
			view: this.#view.good,
			viewHtml: this.#html.text,
			planError: this.#plan.error,
			viewError: this.#view.error,
			htmlError: this.#html.error,
			viewRaw: this.#view.text,
		};
		return this.#out;
	}
}
