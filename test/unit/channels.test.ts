// channels.ts: table cases, and an oracle against the reference channels.mjs on 500 generated
// boards when AGY_SWARM_REF points at the upstream swarm_board directory.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as ch from "../../src/board/channels.ts";
import cases from "../fixtures/sees_cases.json";
import { genBoard } from "../helpers/gen-board.ts";

describe("channels table", () => {
	test("mention boundaries, prefixes, @all, Unicode", () => {
		for (const c of cases.mentions) expect([c.text, c.name, ch.mentions(c.text, c.name)]).toEqual([c.text, c.name, c.want]);
	});

	test("channel mentions", () => {
		for (const c of cases.channelMentions) expect([c.text, ch.channelMentions(c.text)]).toEqual([c.text, c.want]);
	});

	test("effective channels", () => {
		for (const c of cases.effective) expect(ch.effectiveChannels(c.role, c.set, c.name)).toEqual(c.want);
	});

	test("channelsAt follows prev/next; activeAt honours create and archive", () => {
		const msgs = [
			{ seq: 1, agent: "c", text: "x", control: { op: "create", channel: "p" } },
			{ seq: 2, agent: "c", text: "hi" },
			{ seq: 3, agent: "c", text: "sub", control: { op: "subscribe", channel: "p", members: ["w"], prev: { w: null }, next: { w: ["p"] } } },
			{ seq: 4, agent: "c", text: "@#p go" },
			{ seq: 5, agent: "c", text: "arch", control: { op: "archive", channel: "p" } },
			{ seq: 6, agent: "c", text: "@#p again" },
		];
		expect(ch.channelsAt("w", ["p"], msgs)).toEqual([null, null, ["p"], ["p"], ["p"], ["p"]]);
		const reg = ch.channelRegistry(msgs);
		expect(reg).toEqual([{ name: "p", topic: "", created_by: "c", archived: true }]);
		const active = ch.activeAt(reg, msgs);
		expect(active.map(a => a?.("p"))).toEqual([true, true, true, true, false, false]);
		expect(ch.mentionsIn("@#p go", "w", ["p"], active[3] ?? null)).toBe(true);
		expect(ch.mentionsIn("@#p again", "w", ["p"], active[5] ?? null)).toBe(false);
		expect(ch.visibleUnread("w", "worker", ["p"], msgs, 0, reg)).toBe(3);
		expect(ch.currentChannels("w", null, msgs)).toEqual(["p"]);
	});
});

const REF = process.env.AGY_SWARM_REF;
const refFile = REF ? join(REF, "channels.mjs") : "";

describe.skipIf(!REF || !existsSync(refFile))("oracle vs channels.mjs", () => {
	test("500 generated boards agree on every exported function", async () => {
		// Runtime-selected module path (the reference implementation outside this repo).
		const ref = (await import(refFile)) as typeof ch;
		let compared = 0;
		for (let seed = 1; seed <= 500; seed++) {
			const b = genBoard(seed);
			const msgs = b.records;
			const names = b.members.map(m => m.name);
			const reg = ch.channelRegistry(msgs);
			expect(ref.channelRegistry(msgs)).toEqual(reg);
			const actOurs = ch.activeAt(reg, msgs);
			const actRef = ref.activeAt(reg, msgs);
			for (const [i, m] of msgs.entries()) {
				expect(ref.mentionsOf(m.text, names)).toEqual(ch.mentionsOf(m.text, names));
				expect(ref.channelMentions(m.text)).toEqual(ch.channelMentions(m.text));
				expect(ref.channelOf(m)).toBe(ch.channelOf(m));
				expect(ref.countsUnread(m)).toBe(ch.countsUnread(m));
				for (const c of ["parser", "ui", "infra", "nope"]) expect(actRef[i]?.(c) ?? null).toBe(actOurs[i]?.(c) ?? null);
				for (const n of names) {
					expect(ref.mentions(m.text, n)).toBe(ch.mentions(m.text, n));
					compared++;
				}
			}
			for (const mem of b.members) {
				const cur = ch.currentChannels(mem.name, mem.stored, msgs);
				expect(ref.currentChannels(mem.name, mem.stored, msgs)).toEqual(cur);
				expect(ref.channelsAt(mem.name, cur, msgs)).toEqual(ch.channelsAt(mem.name, cur, msgs));
				expect(ref.effectiveChannels(mem.role, cur, mem.name)).toEqual(ch.effectiveChannels(mem.role, cur, mem.name));
				expect(ref.memberView(mem.name, mem.role, cur, msgs, reg)).toEqual(ch.memberView(mem.name, mem.role, cur, msgs, reg));
				expect(ref.visibleUnread(mem.name, mem.role, cur, msgs, 5, reg)).toBe(ch.visibleUnread(mem.name, mem.role, cur, msgs, 5, reg));
				const sets = ch.channelsAt(mem.name, cur, msgs);
				for (const [i, m] of msgs.entries()) {
					const set = ch.effectiveChannels(mem.role, sets[i], mem.name);
					expect(ref.seesIn(mem.name, set, m, actRef[i] ?? null)).toBe(ch.seesIn(mem.name, set, m, actOurs[i] ?? null));
					expect(ref.mentionsIn(m.text, mem.name, set, actRef[i] ?? null)).toBe(ch.mentionsIn(m.text, mem.name, set, actOurs[i] ?? null));
				}
			}
		}
		expect(compared).toBeGreaterThan(10_000);
	});
});
