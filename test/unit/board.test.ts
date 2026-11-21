// Board: ring sets fixed at the post, self/control never ring, the three unread questions, pages,
// and parity of the incremental view with channels.ts memberView on generated boards.

import { describe, expect, test } from "bun:test";
import { Board, type BoardMember } from "../../src/board/board.ts";
import { channelRegistry, currentChannels, memberView } from "../../src/board/channels.ts";
import type { BoardRecord, Role } from "../../src/board/types.ts";
import { genBoard } from "../helpers/gen-board.ts";

function mkBoard(members: { name: string; role: Role; set?: string[] | null }[]) {
	const list: BoardMember[] = members.map(m => ({ name: m.name, role: m.role, addedSeq: 0, killedSeq: undefined }));
	const board = new Board({ boardMembers: () => list });
	for (const m of members) board.seedStoredSet(m.name, m.set ?? null);
	let seq = 0;
	const post = (agent: string, text: string, extra: Partial<BoardRecord> = {}) =>
		board.append({ seq: ++seq, agent, text, time: "2026-01-01 00:00:00", ...extra });
	return { board, list, post };
}

describe("ring sets", () => {
	test("are fixed at the post: a later subscribe/archive does not change an earlier ring", () => {
		const { board, post } = mkBoard([
			{ name: "coordinator", role: "coordinator" },
			{ name: "w", role: "worker" },
		]);
		post("coordinator", "c", { control: { op: "create", channel: "p" } });
		const before = post("coordinator", "@#p anyone");
		expect(before.ring.mentions.has("w")).toBe(false);
		post("coordinator", "sub", { control: { op: "subscribe", channel: "p", members: ["w"], prev: { w: null }, next: { w: ["p"] } } });
		const after = post("coordinator", "@#p now");
		expect(after.ring.mentions.has("w")).toBe(true);
		expect(before.ring.mentions.has("w")).toBe(false);
		post("coordinator", "arch", { control: { op: "archive", channel: "p" } });
		expect(after.ring.mentions.has("w")).toBe(true);
		expect(board.wakePending("w", "mentions", 0).map(m => m.seq)).toEqual([after.seq]);
	});

	test("self posts and controls never ring (self @all, own prefix, own channel)", () => {
		const { board, post } = mkBoard([
			{ name: "coordinator", role: "coordinator" },
			{ name: "g-1", role: "worker", set: ["p"] },
			{ name: "g-2", role: "worker" },
		]);
		post("coordinator", "c", { control: { op: "create", channel: "p" } });
		const m = post("g-1", "@all @g @#p hello", { channel: "p" });
		expect(m.ring.mentions.has("g-1")).toBe(false);
		expect(m.ring.mentions.has("g-2")).toBe(true);
		expect(board.wakePending("g-1", "anything", 0)).toEqual([]);
		const ctl = board.messages[0];
		expect(ctl?.ring.sees.size).toBe(0);
	});

	test("posts before a member was added never ring it", () => {
		const list: BoardMember[] = [{ name: "coordinator", role: "coordinator", addedSeq: 0, killedSeq: undefined }];
		const board = new Board({ boardMembers: () => list });
		board.append({ seq: 1, agent: "coordinator", text: "@late hi", time: "t" });
		list.push({ name: "late", role: "worker", addedSeq: 1, killedSeq: undefined });
		const second = board.append({ seq: 2, agent: "coordinator", text: "@late again", time: "t" });
		expect(board.messages[0]?.ring.mentions.has("late")).toBe(false);
		expect(second.ring.mentions.has("late")).toBe(true);
	});
});

describe("unread questions", () => {
	test("wakePending, gateUnread and uiUnread differ where they should", () => {
		const { board, post } = mkBoard([
			{ name: "coordinator", role: "coordinator" },
			{ name: "w", role: "worker" },
		]);
		post("w", "unaddressed result");
		post("coordinator", "@w do it");
		post("w", "@coordinator done");
		expect(board.wakePending("coordinator", "mentions", 0).map(m => m.seq)).toEqual([3]);
		expect(board.gateUnread(0).map(m => m.seq)).toEqual([1, 3]);
		expect(board.uiUnread("coordinator", "coordinator", 0)).toBe(3);
		expect(board.uiUnread("w", "worker", 0)).toBe(3);
	});
});

describe("pages", () => {
	test("the first post is never cut; byte cap and limit; more; next_since never the head", () => {
		const { board, post } = mkBoard([
			{ name: "coordinator", role: "coordinator" },
			{ name: "w", role: "worker" },
		]);
		const big = "é".repeat(8000);
		post("coordinator", big);
		post("coordinator", "small");
		post("coordinator", "small2");
		const p = board.page("w", "worker", 0, { limit: 10, maxBytes: 100 });
		expect(p.messages.length).toBe(1);
		expect(p.messages[0]?.text).toBe(big);
		expect(p.more).toBe(true);
		expect(p.next_since).toBe(1);
		const p2 = board.page("w", "worker", 1, { limit: 1, maxBytes: 1000 });
		expect(p2.messages.map(m => m.seq)).toEqual([2]);
		expect(p2.next_since).toBe(2);
		const empty = board.page("w", "worker", 3, { limit: 10, maxBytes: 1000 });
		expect(empty.messages).toEqual([]);
		expect(empty.next_since).toBe(3);
		expect(empty.more).toBe(false);
	});

	test("channel reads filter by channel", () => {
		const { board, post } = mkBoard([
			{ name: "coordinator", role: "coordinator" },
			{ name: "w", role: "worker" },
		]);
		post("coordinator", "c", { control: { op: "create", channel: "p" } });
		post("coordinator", "in p", { channel: "p" });
		post("coordinator", "in main");
		expect(board.page("w", "worker", 0, { limit: 10, maxBytes: 1e6, channel: "p" }).messages.map(m => m.seq)).toEqual([2]);
		expect(board.page("w", "worker", 0, { limit: 10, maxBytes: 1e6 }).messages.map(m => m.seq)).toEqual([1, 3]);
		expect(board.page("w", "worker", 0, { limit: 10, maxBytes: 1e6, channel: "*" }).messages.length).toBe(3);
	});
});

describe("incremental view parity", () => {
	test("visibleTo and ring sets equal memberView/mentionsIn on 200 generated boards (log replayed by load)", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const g = genBoard(seed, 30);
			const list: BoardMember[] = g.members.map(m => ({ name: m.name, role: m.role, addedSeq: 0, killedSeq: undefined }));
			const live = new Board({ boardMembers: () => list });
			for (const m of g.members) live.seedStoredSet(m.name, m.stored);
			for (const r of g.records) live.append(r);
			const loaded = new Board({ boardMembers: () => list });
			for (const m of g.members) loaded.seedStoredSet(m.name, m.stored);
			loaded.load(g.records);
			const reg = channelRegistry(g.records);
			for (const m of g.members) {
				const cur = currentChannels(m.name, m.stored, g.records);
				const view = memberView(m.name, m.role, cur, g.records, reg);
				const ours = live.messages.map(msg => live.visibleTo(m.name, m.role, msg));
				expect(ours).toEqual(view.visible);
				for (let i = 0; i < live.messages.length; i++) {
					const a = live.messages[i];
					const b = loaded.messages[i];
					if (!a || !b) continue;
					// V4: a reload recomputes each post's ring with the sets and channel state as of
					// that post, so it equals what the live board fixed at the post.
					expect([...a.ring.mentions].sort()).toEqual([...b.ring.mentions].sort());
					expect([...a.ring.sees].sort()).toEqual([...b.ring.sees].sort());
				}
			}
		}
	});
});
