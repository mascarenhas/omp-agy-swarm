// sanitize, descriptor-verified bounded reads (SW-08), view files with last-good parses, and
// transcript paging with (entryId, blockIndex, epoch) cursors over the whole branch (SW-12).

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "../../src/runtime/ports.ts";
import { sanitize, sanitizeLine } from "../../src/ui/sanitize.ts";
import { decodeCursor, entryItems, FileTranscript, LiveTranscript } from "../../src/ui/transcript.ts";
import { canonicalRoots, safeRead, ViewFilesReader } from "../../src/ui/view-files.ts";

const roots: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "swarm-ui-"));
	roots.push(d);
	return d;
}
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("sanitize", () => {
	test("strips CSI/OSC/DCS, C0/C1 controls and bidi overrides; tabs become spaces", () => {
		const evil = "a\x1b[2Jb\x1b]0;title\x07c\x1bP+q\x1b\\d\u202ee\u0007f\u009b31mg\th";
		expect(sanitize(evil)).toBe("abcdefg  h");
		expect(sanitizeLine("one\ntwo")).toBe("one two");
		expect(sanitize("宽字符 ok")).toBe("宽字符 ok");
	});
});

describe("safeRead", () => {
	test("rejects bad paths, outside roots, symlink escapes, directories, oversize; reads at most max+1", () => {
		const root = tmp();
		const outside = tmp();
		writeFileSync(join(root, "ok.txt"), "hello");
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
		mkdirSync(join(root, "dir"));
		writeFileSync(join(root, "big.txt"), "x".repeat(100));
		const r = canonicalRoots([root]);
		const okRead = safeRead(join(root, "ok.txt"), r, 64);
		expect(okRead.ok && okRead.buf.toString()).toBe("hello");
		expect(safeRead(join(root, "link.txt"), r, 64)).toEqual({ ok: false, reason: "outside" });
		expect(safeRead(`${root}/../${root.split("/").pop()}/ok.txt`, r, 64)).toEqual({ ok: false, reason: "invalid" });
		expect(safeRead(`${root}/ok.txt\0`, r, 64)).toEqual({ ok: false, reason: "invalid" });
		expect(safeRead("relative.txt", r, 64)).toEqual({ ok: false, reason: "invalid" });
		expect(safeRead(join(root, "dir"), r, 64)).toEqual({ ok: false, reason: "not_file" });
		expect(safeRead(join(root, "big.txt"), r, 64)).toEqual({ ok: false, reason: "too_large" });
		expect(safeRead(join(outside, "secret.txt"), r, 64)).toEqual({ ok: false, reason: "outside" });
	});

	test("a symlink swapped in after realpath cannot escape: the opened descriptor is what is checked", () => {
		const root = tmp();
		const outside = tmp();
		writeFileSync(join(outside, "secret.txt"), "secret");
		mkdirSync(join(root, "d"));
		writeFileSync(join(root, "d", "f.txt"), "inside");
		const r = canonicalRoots([root]);
		// Replace the directory with a symlink to the outside: realpath resolves outside → refused.
		rmSync(join(root, "d"), { recursive: true });
		symlinkSync(outside, join(root, "d"));
		writeFileSync(join(outside, "f.txt"), "escaped");
		expect(safeRead(join(root, "d", "f.txt"), r, 64)).toEqual({ ok: false, reason: "outside" });
	});
});

describe("view files", () => {
	test("caps and last-good JSON", () => {
		const dir = tmp();
		const reader = new ViewFilesReader(dir);
		expect(reader.read().view).toBeNull();
		writeFileSync(join(dir, "view.json"), JSON.stringify({ goal: { title: "G" } }));
		expect(reader.read().view).toEqual({ goal: { title: "G" } });
		writeFileSync(join(dir, "view.json"), "{torn");
		const torn = reader.read();
		expect(torn.view).toEqual({ goal: { title: "G" } });
		expect(torn.viewError).toBe("invalid");
		writeFileSync(join(dir, "plan.json"), `{"goal":"${"x".repeat(70_000)}"}`);
		expect(reader.read().planError).toBe("too_large");
		writeFileSync(join(dir, "view.html"), "   ");
		expect(reader.read().htmlError).toBe("empty");
	});
});

function entry(id: string, parentId: string | null, message: TranscriptEntry["message"], type = "message"): TranscriptEntry {
	return { type, id, parentId, message, timestamp: "2026-01-01T00:00:00Z" };
}

describe("transcripts", () => {
	test("items per block; entry-id cursors page backwards and forwards over the whole branch", () => {
		const entries: TranscriptEntry[] = [];
		let parent: string | null = null;
		for (let i = 0; i < 450; i++) {
			const id = `e${i}`;
			entries.push(
				entry(id, parent, {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: `think ${i}` },
						{ type: "text", text: `say ${i}` },
					],
				}),
			);
			parent = id;
		}
		const src = new LiveTranscript("conv", () => entries);
		const tail = src.page({});
		expect(tail.items.length).toBe(200);
		expect(tail.items.at(-1)?.text).toBe("say 449");
		expect(tail.more_before).toBe(true);
		expect(tail.more_after).toBe(false);
		let cursor = tail.first;
		const seen = [...tail.items];
		for (let guard = 0; guard < 10 && cursor; guard++) {
			const p = src.page({ before: cursor });
			seen.unshift(...p.items);
			cursor = p.more_before ? p.first : undefined;
		}
		expect(seen.length).toBe(900);
		expect(seen[0]?.text).toBe("think 0");
		const fwd = src.page({ after: tail.first, limit: 3 });
		expect(fwd.items.map(i => i.text)).toEqual(tail.items.slice(1, 4).map(i => i.text));
		const c = decodeCursor(tail.first);
		expect(c?.block).toBeGreaterThanOrEqual(0);
		const stale = src.page({ before: tail.first?.replace(/\.[^.]+$/, ".deadbeef") });
		expect(stale.items.at(-1)?.text).toBe("say 449");
	});

	test("file reader: current branch only, bounded per line, no silent tail cut", () => {
		const dir = tmp();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "session", id: "S1", cwd: "/" })}\n`);
		let parent: string | null = null;
		for (let i = 0; i < 300; i++) {
			const id = `m${i}`;
			appendFileSync(file, `${JSON.stringify(entry(id, parent, { role: "user", content: [{ type: "text", text: `u${i}` }] }))}\n`);
			parent = id;
		}
		// An abandoned branch off m10 must not show.
		appendFileSync(file, `${JSON.stringify(entry("x1", "m10", { role: "user", content: "off-branch" }))}\n`);
		appendFileSync(file, `${JSON.stringify(entry("m300", "m299", { role: "user", content: [{ type: "text", text: "last" }] }))}\n`);
		const src = new FileTranscript(file);
		const tail = src.page({});
		expect(tail.items.at(-1)?.text).toBe("last");
		let all = [...tail.items];
		let cur = tail.first;
		while (cur) {
			const p = src.page({ before: cur });
			all = [...p.items, ...all];
			cur = p.more_before ? p.first : undefined;
		}
		expect(all.length).toBe(301);
		expect(all.some(i => i.text === "off-branch")).toBe(false);
		expect(all[0]?.text).toBe("u0");
	});

	test("entry kinds", () => {
		const items = entryItems(entry("a", null, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "error", errorMessage: "boom" }));
		expect(items.map(i => i.kind)).toEqual(["tool_call", "system"]);
		expect(entryItems(entry("b", null, { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "no" }] }))[0]?.ok).toBe(false);
		expect(entryItems({ type: "custom_message", id: "c", parentId: null, customType: "swarm-wake", content: "[swarm] hi" })[0]?.kind).toBe("wake");
		const big = entryItems(entry("d", null, { role: "user", content: "x".repeat(10_000) }))[0];
		expect(big?.truncated).toBe(true);
		expect(big?.text.endsWith("…(truncated)")).toBe(true);
	});

	test("19.0.1 model_change renders its provider/model; the older shape still reads (H5)", () => {
		const now = entryItems({ type: "model_change", id: "m", parentId: null, model: "anthropic/claude-haiku-4-5" })[0];
		expect(now?.text).toBe("model → anthropic/claude-haiku-4-5");
		const old = entryItems({ type: "model_change", id: "o", parentId: null, provider: "p", modelId: "x" })[0];
		expect(old?.text).toBe("model → p/x");
	});

	test("a /clear rotates the live epoch and the branch starts at the reset marker (H5)", () => {
		const entries: TranscriptEntry[] = [
			entry("a", null, { role: "user", content: [{ type: "text", text: "before clear" }] }),
			{ type: "reset_boundary", id: "r", parentId: "a" },
			entry("b", "r", { role: "user", content: [{ type: "text", text: "after clear" }] }),
		];
		let epoch = 0;
		const src = new LiveTranscript("conv", () => entries, () => epoch);
		const first = src.page({});
		expect(first.items.map(i => i.text)).toEqual(["conversation cleared (/clear); earlier history is not part of it", "after clear"]);
		expect(first.more_before).toBe(false);
		epoch++;
		const second = src.page({ before: first.last });
		expect(second.epoch).not.toBe(first.epoch);
		// A cursor from before the clear restarts from the tail.
		expect(second.items.at(-1)?.text).toBe("after clear");
	});

	test("file reader: active leaf from activeLeafId, title slot, keys past the first KB (H5)", () => {
		const dir = tmp();
		const file = join(dir, "s.jsonl");
		const lines: unknown[] = [
			{ type: "title", v: 1, title: "t", updatedAt: "", pad: " ".repeat(64) },
			{ type: "session", id: "S1", cwd: "/" },
			entry("m0", null, { role: "user", content: [{ type: "text", text: "u0" }] }),
			entry("m1", "m0", { role: "user", content: [{ type: "text", text: "u1" }] }),
		];
		// A long entry whose id/parentId come after more than a KB of other keys.
		lines.push({ message: { role: "user", content: [{ type: "text", text: `long ${"y".repeat(3000)}` }] }, timestamp: new Date().toISOString(), type: "message", id: "m2", parentId: "m1" });
		// Late usage written off-branch: parented on m0, it keeps the leaf on m2 (activeLeafId at the end of a long line).
		lines.push({ type: "model_usage", id: "u1", parentId: "m0", timestamp: "", purpose: "title", api: "x", provider: "p", model: "m", usage: {}, stopReason: "stop", errorMessage: "z".repeat(2000), activeLeafId: "m2" });
		writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
		const src = new FileTranscript(file);
		const p = src.page({});
		const texts = p.items.map(i => i.text);
		expect(texts[0]).toBe("u0");
		expect(texts[1]).toBe("u1");
		expect(texts[2]?.startsWith("long ")).toBe(true);
		expect(texts.length).toBe(3);
		// Home: the head page in one step.
		expect(src.page({ head: true, limit: 1 }).items[0]?.text).toBe("u0");
	});
});
