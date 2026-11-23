// TranscriptSource (§10.5 with SW-12): live current-branch entries, or a bounded indexed reader
// over a member's JSONL. Pages cover the whole current branch in both directions; cursors are
// (entryId, blockIndex, epoch) and never array indexes. A cursor from another epoch, or one whose
// entry left the branch, restarts from the tail and marks that page as a cursor reset.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { LIMITS } from "../env.ts";
import type { TranscriptEntry } from "../runtime/ports.ts";
import type { TranscriptItem, TranscriptPage, TranscriptPageOptions, TranscriptSource } from "./model.ts";
import { sanitize } from "./sanitize.ts";

const ITEM_CAP = LIMITS.transcriptItemBytes;
const LINE_CAP = 4 * 1024 * 1024;

function cap(text: string): { text: string; truncated?: boolean } {
	const clean = sanitize(text);
	if (Buffer.byteLength(clean, "utf8") <= ITEM_CAP) return { text: clean };
	let cut = clean.slice(0, ITEM_CAP);
	while (Buffer.byteLength(cut, "utf8") > ITEM_CAP) cut = cut.slice(0, -64);
	return { text: `${cut}…(truncated)`, truncated: true };
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(c => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : ""))
		.filter(Boolean)
		.join("\n");
}

function tsOf(e: TranscriptEntry): number | undefined {
	const t = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
	return Number.isFinite(t) ? t : undefined;
}

/** One entry → its compact items (several for an assistant message with several blocks). */
export function entryItems(e: TranscriptEntry): TranscriptItem[] {
	const out: TranscriptItem[] = [];
	const ts = tsOf(e);
	const push = (kind: TranscriptItem["kind"], text: string, extra: Partial<TranscriptItem> = {}): void => {
		const block = out.length;
		out.push({ id: `${e.id}#${block}`, entryId: e.id, block, kind, ...cap(text), ...(ts ? { ts } : {}), ...extra });
	};
	if (e.type === "message" && e.message) {
		const m = e.message;
		if (m.role === "user") {
			const t = textOf(m.content);
			push(t.startsWith("[swarm]") ? "wake" : "user", t);
		} else if (m.role === "assistant") {
			const model = m.provider && m.model ? `${m.provider}/${m.model}` : undefined;
			const blocks = Array.isArray(m.content) ? m.content : [];
			for (const b of blocks) {
				if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) push("thinking", b.thinking, { model });
				else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) push("assistant", b.text, { model });
				else if (b.type === "toolCall") {
					let args = "";
					try {
						args = JSON.stringify(b.arguments ?? {});
					} catch {}
					push("tool_call", `${b.name ?? "tool"} ${args}`, { tool: b.name, model });
				}
			}
			if (m.stopReason === "error" && m.errorMessage) push("system", `error: ${m.errorMessage}`);
		} else if (m.role === "toolResult") {
			push("tool_result", textOf(m.content), { tool: m.toolName, ok: !m.isError });
		} else if (m.role === "custom") {
			push(m.customType === "swarm-wake" ? "wake" : "system", textOf(m.content));
		}
	} else if (e.type === "custom_message") {
		push(e.customType === "swarm-wake" ? "wake" : "system", textOf(e.content));
	} else if (e.type === "compaction") {
		push("system", `context compacted${e.summary ? `: ${e.summary}` : ""}`);
	} else if (e.type === "model_change") {
		push("system", `model → ${e.model ?? `${e.provider ?? "?"}/${e.modelId ?? "?"}`}`);
	} else if (e.type === "thinking_level_change") {
		push("system", `effort → ${e.thinkingLevel ?? "default"}`);
	} else if (e.type === "reset_boundary") {
		push("system", "conversation cleared (/clear); earlier history is not part of it");
	}
	return out;
}

export function encodeCursor(entryId: string, block: number, epoch: string): string {
	return `${encodeURIComponent(entryId)}.${block}.${epoch}`;
}

export function decodeCursor(c: string | undefined): { entryId: string; block: number; epoch: string } | undefined {
	if (!c) return undefined;
	const parts = c.split(".");
	if (parts.length !== 3) return undefined;
	const block = Number(parts[1]);
	if (!Number.isInteger(block) || block < 0) return undefined;
	try {
		return { entryId: decodeURIComponent(parts[0] ?? ""), block, epoch: parts[2] ?? "" };
	} catch {
		return undefined;
	}
}

/** The branch as an indexable list of entries (live array or file index). */
export interface EntryList {
	readonly length: number;
	readonly epoch: string;
	indexOf(id: string): number;
	entry(i: number): TranscriptEntry | undefined;
}

function hasItemsBefore(list: EntryList, idx: number): boolean {
	for (let i = idx - 1; i >= 0 && i >= idx - 500; i--) {
		const e = list.entry(i);
		if (e && entryItems(e).length) return true;
	}
	return idx > 500;
}

function hasItemsAfter(list: EntryList, idx: number): boolean {
	for (let i = idx + 1; i < list.length && i <= idx + 500; i++) {
		const e = list.entry(i);
		if (e && entryItems(e).length) return true;
	}
	return list.length - idx > 500;
}

export function pageOf(list: EntryList, opts: TranscriptPageOptions): TranscriptPage {
	const limit = Math.max(1, Math.min(LIMITS.transcriptPage, Math.trunc(opts.limit ?? LIMITS.transcriptPage)));
	const epoch = list.epoch;
	const before = decodeCursor(opts.before);
	const after = decodeCursor(opts.after);
	const cursor = before ?? after;
	let idx = cursor && cursor.epoch === epoch ? list.indexOf(cursor.entryId) : -1;
	const reset = idx < 0 && (opts.before !== undefined || opts.after !== undefined);
	let dir: "before" | "after" | "tail" = idx >= 0 ? (before ? "before" : "after") : "tail";
	if (!reset && idx < 0 && opts.head) {
		// The start of the branch: one page forward from the first entry (no walk over the rest).
		idx = 0;
		dir = "after";
	}
	const items: TranscriptItem[] = [];
	let firstIdx = list.length;
	let lastIdx = -1;
	if (dir === "after") {
		const startBlock = cursor ? cursor.block + 1 : 0;
		for (let i = idx; i < list.length && items.length < limit; i++) {
			const e = list.entry(i);
			if (!e) continue;
			for (const it of entryItems(e)) {
				if (i === idx && it.block < startBlock) continue;
				if (items.length >= limit) break;
				items.push(it);
				firstIdx = Math.min(firstIdx, i);
				lastIdx = i;
			}
		}
	} else {
		if (dir === "tail") idx = list.length - 1;
		const endBlock = dir === "before" ? (before?.block ?? 0) : Number.POSITIVE_INFINITY;
		const collected: TranscriptItem[] = [];
		for (let i = idx; i >= 0 && collected.length < limit; i--) {
			const e = list.entry(i);
			if (!e) continue;
			const its = entryItems(e).filter(it => i !== idx || it.block < endBlock);
			for (let k = its.length - 1; k >= 0 && collected.length < limit; k--) {
				collected.push(its[k] as TranscriptItem);
				firstIdx = i;
				lastIdx = Math.max(lastIdx, i);
			}
		}
		items.push(...collected.reverse());
	}
	const first = items[0];
	const last = items[items.length - 1];
	let moreBefore = false;
	let moreAfter = false;
	if (first) {
		const e = list.entry(firstIdx);
		moreBefore = (e ? entryItems(e).some(it => it.block < first.block) : false) || hasItemsBefore(list, firstIdx);
	} else moreBefore = dir === "before" ? hasItemsBefore(list, idx + 1) : false;
	if (last) {
		const e = list.entry(lastIdx);
		moreAfter = (e ? entryItems(e).some(it => it.block > last.block) : false) || hasItemsAfter(list, lastIdx);
	} else moreAfter = dir === "after" ? hasItemsAfter(list, idx - 1) : false;
	return {
		items,
		first: first ? encodeCursor(first.entryId, first.block, epoch) : undefined,
		last: last ? encodeCursor(last.entryId, last.block, epoch) : undefined,
		more_before: moreBefore,
		more_after: moreAfter,
		epoch,
		...(reset ? { cursor_reset: true } : {}),
	};
}

function epochOf(parts: string[]): string {
	return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

/** Index of the latest `/clear` marker on a branch (its conversation starts there), or 0. */
function lastResetIndex(length: number, typeAt: (i: number) => string | undefined): number {
	for (let i = length - 1; i >= 0; i--) if (typeAt(i) === "reset_boundary") return i;
	return 0;
}

/**
 * Live entries (worker session or the coordinator's read-only manager). The branch shown starts
 * at the latest `/clear` marker; the epoch covers the session id, that start, every compaction and
 * the runtime's clear counter, so a `/clear` invalidates every outstanding cursor.
 */
export class LiveTranscript implements TranscriptSource {
	readonly #entries: () => readonly TranscriptEntry[];
	readonly #sessionId: string;
	readonly #epoch: () => number;

	constructor(sessionId: string, entries: () => readonly TranscriptEntry[], epoch: () => number = () => 0) {
		this.#sessionId = sessionId;
		this.#entries = entries;
		this.#epoch = epoch;
	}

	page(opts: TranscriptPageOptions): TranscriptPage {
		const all = this.#entries();
		const entries = all.slice(lastResetIndex(all.length, i => all[i]?.type));
		const index = new Map<string, number>();
		entries.forEach((e, i) => index.set(e.id, i));
		const compactions = entries.filter(e => e.type === "compaction").map(e => e.id);
		const list: EntryList = {
			length: entries.length,
			epoch: epochOf([this.#sessionId, String(this.#epoch()), entries[0]?.id ?? "", ...compactions]),
			indexOf: id => index.get(id) ?? -1,
			entry: i => entries[i],
		};
		return pageOf(list, opts);
	}
}

interface LineRef {
	offset: number;
	length: number;
	id: string;
	parentId: string | null;
	type: string;
	/** `activeLeafId` as written; undefined: absent, or unknown when `leafKnown` is false. */
	activeLeafId: string | null | undefined;
	/** False when the key may lie past the indexed prefix (read on demand for leaf resolution). */
	leafKnown: boolean;
}

const PREFIX_BYTES = 1024;
const ID_RE = /"id"\s*:\s*"([^"\\]+)"/;
const PARENT_RE = /"parentId"\s*:\s*(null|"([^"\\]+)")/;
const TYPE_RE = /"type"\s*:\s*"([^"\\]+)"/;
const LEAF_RE = /"activeLeafId"\s*:\s*(null|"([^"\\]+)")/;

/** Fixed-width first-line title slot (19.0.1 SESSION_TITLE_SLOT_ENTRY_TYPE): not an entry. */
const TITLE_SLOT = "title";

function optionalId(m: RegExpExecArray | null): string | null | undefined {
	if (!m) return undefined;
	return m[1] === "null" ? null : (m[2] ?? null);
}

/**
 * A member's JSONL read through a line index built in bounded chunks (no whole-file read, no
 * silent tail cut). Keys are read from each line's first KB; a line whose id or type lies further
 * in is parsed whole (bounded by LINE_CAP). The current branch is the parent chain from the active
 * leaf, resolved as 19.0.1 does (`activeLeafId` on off-branch entries), and starts at the latest
 * `/clear` marker. Each page() reads its entries through one short-lived descriptor.
 */
export class FileTranscript implements TranscriptSource {
	readonly #path: string;
	#key = "";
	#lines: LineRef[] = [];
	#branch: number[] = [];
	#index = new Map<string, number>();
	#epoch = "";
	#cache = new Map<number, TranscriptEntry | undefined>();
	#fd: number | undefined;

	constructor(path: string) {
		this.#path = path;
	}

	/** Parses one whole line (bounded); undefined when it is too large or not a JSON object. */
	#parseLine(fd: number, offset: number, length: number): Record<string, unknown> | undefined {
		if (length > LINE_CAP) return undefined;
		try {
			const buf = Buffer.allocUnsafe(length);
			const n = readSync(fd, buf, 0, length, offset);
			const v = JSON.parse(buf.subarray(0, n).toString("utf8")) as unknown;
			return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}

	#indexLine(fd: number, head: string, offset: number, length: number, lines: LineRef[]): void {
		let id = ID_RE.exec(head)?.[1];
		let type = TYPE_RE.exec(head)?.[1];
		const parentMatch = PARENT_RE.exec(head);
		let parentId: string | null = optionalId(parentMatch) ?? null;
		let activeLeafId = optionalId(LEAF_RE.exec(head));
		let leafKnown = activeLeafId !== undefined || length <= PREFIX_BYTES;
		if (type === TITLE_SLOT) return;
		if (length > PREFIX_BYTES && (id === undefined || type === undefined || (type !== "session" && !parentMatch))) {
			const v = this.#parseLine(fd, offset, length);
			if (v) {
				id = typeof v.id === "string" ? v.id : undefined;
				type = typeof v.type === "string" ? v.type : undefined;
				parentId = typeof v.parentId === "string" ? v.parentId : null;
				activeLeafId = typeof v.activeLeafId === "string" || v.activeLeafId === null ? v.activeLeafId : undefined;
				leafKnown = true;
			}
		}
		if (!type || type === TITLE_SLOT) return;
		if (type === "session") {
			lines.push({ offset, length, id: `session:${id ?? ""}`, parentId: null, type, activeLeafId: undefined, leafKnown: true });
			return;
		}
		if (id) lines.push({ offset, length, id, parentId, type, activeLeafId, leafKnown });
	}

	/** The leaf a line selects on replay (19.0.1 sessionEntryLeafId), reading the line if needed. */
	#leafOf(fd: number, l: LineRef): string | null {
		if (!l.leafKnown) {
			const v = this.#parseLine(fd, l.offset, l.length);
			l.activeLeafId = v && (typeof v.activeLeafId === "string" || v.activeLeafId === null) ? v.activeLeafId : undefined;
			l.leafKnown = true;
		}
		return l.activeLeafId !== undefined ? l.activeLeafId : l.id;
	}

	/** The active leaf after replaying the entries in file order (19.0.1 resolveSessionLeafId). */
	#resolveLeaf(fd: number, entries: readonly LineRef[], byId: ReadonlyMap<string, number>): string | null {
		const last = entries[entries.length - 1];
		if (!last) return null;
		const leaf = this.#leafOf(fd, last);
		if (leaf === null || leaf === last.id || byId.has(leaf)) return leaf;
		for (let i = entries.length - 1; i >= 0; i--) {
			const l = entries[i] as LineRef;
			if (this.#leafOf(fd, l) === l.id) return l.id;
		}
		return null;
	}

	#build(): boolean {
		let fd: number;
		try {
			fd = openSync(this.#path, "r");
		} catch {
			this.#lines = [];
			this.#branch = [];
			return false;
		}
		try {
			const st = fstatSync(fd);
			const key = `${st.size}:${st.mtimeMs}`;
			if (key === this.#key) return true;
			this.#key = key;
			this.#cache.clear();
			const lines: LineRef[] = [];
			const chunk = Buffer.allocUnsafe(1 << 20);
			let pos = 0;
			let lineStart = 0;
			let prefix: Buffer[] = [];
			let prefixLen = 0;
			const finish = (end: number): void => {
				if (end > lineStart) this.#indexLine(fd, Buffer.concat(prefix, prefixLen).toString("utf8"), lineStart, end - lineStart, lines);
				prefix = [];
				prefixLen = 0;
			};
			for (;;) {
				const n = readSync(fd, chunk, 0, chunk.length, pos);
				if (n <= 0) break;
				let start = 0;
				for (;;) {
					const nl = chunk.indexOf(10, start);
					const segEnd = nl < 0 || nl >= n ? n : nl;
					if (prefixLen < PREFIX_BYTES) {
						const take = chunk.subarray(start, Math.min(segEnd, start + (PREFIX_BYTES - prefixLen)));
						prefix.push(Buffer.from(take));
						prefixLen += take.length;
					}
					if (nl < 0 || nl >= n) break;
					finish(pos + nl);
					lineStart = pos + nl + 1;
					start = nl + 1;
				}
				pos += n;
			}
			finish(pos);
			this.#lines = lines;
			const byId = new Map<string, number>();
			lines.forEach((l, i) => byId.set(l.id, i));
			const header = lines.find(l => l.type === "session");
			const leafId = this.#resolveLeaf(
				fd,
				lines.filter(l => l.type !== "session"),
				byId,
			);
			const chain: number[] = [];
			const seen = new Set<string>();
			for (let cur = leafId ? byId.get(leafId) : undefined; cur !== undefined; ) {
				const l = lines[cur];
				if (!l || seen.has(l.id)) break;
				seen.add(l.id);
				chain.push(cur);
				cur = l.parentId ? byId.get(l.parentId) : undefined;
			}
			chain.reverse();
			const branch = chain.slice(lastResetIndex(chain.length, i => lines[chain[i] ?? -1]?.type));
			this.#branch = branch;
			this.#index = new Map(branch.map((li, i) => [lines[li]?.id ?? "", i]));
			const compactions = branch.filter(li => lines[li]?.type === "compaction").map(li => lines[li]?.id ?? "");
			this.#epoch = epochOf([header?.id ?? this.#path, lines[branch[0] ?? -1]?.id ?? "", ...compactions]);
			return true;
		} finally {
			closeSync(fd);
		}
	}

	#entry(i: number): TranscriptEntry | undefined {
		const li = this.#branch[i];
		if (li === undefined) return undefined;
		if (this.#cache.has(li)) return this.#cache.get(li);
		const l = this.#lines[li];
		let e: TranscriptEntry | undefined;
		if (l) {
			if (l.length > LINE_CAP) e = { type: "custom_message", id: l.id, parentId: l.parentId, customType: "note", content: `(entry too large to show: ${l.length} bytes)` };
			else if (this.#fd !== undefined) e = this.#parseLine(this.#fd, l.offset, l.length) as TranscriptEntry | undefined;
		}
		if (this.#cache.size > 2000) this.#cache.clear();
		this.#cache.set(li, e);
		return e;
	}

	page(opts: TranscriptPageOptions): TranscriptPage {
		if (!this.#build()) return { items: [], more_before: false, more_after: false, epoch: "" };
		try {
			this.#fd = openSync(this.#path, "r");
		} catch {
			return { items: [], more_before: false, more_after: false, epoch: "" };
		}
		try {
			const list: EntryList = {
				length: this.#branch.length,
				epoch: this.#epoch,
				indexOf: id => this.#index.get(id) ?? -1,
				entry: i => this.#entry(i),
			};
			return pageOf(list, opts);
		} finally {
			closeSync(this.#fd);
			this.#fd = undefined;
		}
	}
}
