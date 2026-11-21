// /swarm overlay rendering and keyboard paths over a real runtime's read model (§10.2, T5).

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { RuntimeReadModel } from "../../src/runtime/read-model.ts";
import { project } from "../../src/ui/model.ts";
import { SwarmOverlay } from "../../src/ui/tui/overlay.ts";
import { widgetLine } from "../../src/ui/tui/widget.ts";
import { fastTimers, Harness, until } from "../helpers/harness.ts";

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => {
	await h?.close();
});

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t };

function overlay(model: RuntimeReadModel, rows: number, view: "overview" | "board" | "members" | "transcript" = "overview") {
	const tui = { terminal: { rows, columns: 80 }, requestRender: () => {} };
	let closed = false;
	const o = new SwarmOverlay(model, tui, theme, undefined, () => (closed = true), view);
	return { o, tui, closed: () => closed };
}

async function populated(posts = 40) {
	h = new Harness({ mode: "tui" });
	h.factory.brains.set("parser", async t => {
		await t.call("post_message", { text: "@coordinator [done] fail case fixed\nScreenshot: /tmp/x.png | look" });
		await t.call("swarm_wait", {});
	});
	await h.swarm({ action: "title", title: "parser \x1b[2J rewrite \x1b]0;pwn\x07" });
	await h.swarm({ action: "add", name: "parser", brief: "fix the fail case" });
	await until(() => h.member("parser").phase === "parked", 1000, "parked");
	for (let i = 0; i < posts; i++) await h.post(i === 7 ? "evil \x1b[31mred\x1b[0m \u202edir post 7" : `note ${i} 宽`);
	return new RuntimeReadModel(h.rt);
}

describe("overlay", () => {
	test("renders exactly the terminal rows at 80x24 and 40x12; never wider; no raw escapes from content", async () => {
		const model = await populated();
		for (const [cols, rows] of [
			[80, 24],
			[40, 12],
		] as const) {
			for (const v of ["overview", "board", "members", "transcript"] as const) {
				const { o } = overlay(model, rows, v);
				const lines = o.render(cols);
				expect(lines.length).toBe(rows);
				for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(cols);
				const joined = lines.join("\n");
				expect(joined.includes("\x1b[2J")).toBe(false);
				expect(joined.includes("\x1b]0;")).toBe(false);
				expect(joined.includes("\u202e")).toBe(false);
				o.dispose();
			}
		}
		const tiny = overlay(model, 5).o.render(30);
		expect(tiny[0]).toContain("terminal too small");
		expect(tiny.length).toBe(5);
	});

	test("keyboard path: search → #seq jump (filters suspended) → o → t → Esc → Esc → b → q", async () => {
		const model = await populated();
		const { o, closed } = overlay(model, 24, "overview");
		const key = (d: string) => o.handleInput(d);
		key("2");
		for (const c of "/fail") key(c);
		key("\r");
		let status = o.render(80)[22] ?? "";
		expect(status).toContain("/fail");
		for (const c of "#10") key(c);
		key("\r");
		status = o.render(80)[22] ?? "";
		expect(status).toContain("#10 · filters off · b back");
		key("o");
		let lines = o.render(80);
		expect(lines[1]).toContain("3 Members");
		expect(lines.join("\n")).toContain("coordinator");
		key("t");
		lines = o.render(80);
		expect(lines[2]).toContain("coordinator");
		key("\x1b");
		expect(o.render(80)[22]).toContain("coordinator");
		key("\x1b");
		expect(o.render(80)[22]).toContain("#10 · filters off · b back");
		key("b");
		expect(o.render(80)[22]).toContain("/fail");
		key("q");
		expect(closed()).toBe(true);
	});

	test("a 5 000-post board renders in under 50 ms; a new post never moves a non-following board", async () => {
		const model = await populated(10);
		for (let i = 0; i < 5000; i++) h.rt.commitPost(h.rt.coordinator, `bulk ${i}`);
		const { o } = overlay(model, 24, "board");
		o.render(80);
		o.handleInput("\x1b[A");
		o.handleInput("\x1b[A");
		const t0 = performance.now();
		const before = o.render(80);
		expect(performance.now() - t0).toBeLessThan(50);
		h.rt.commitPost(h.rt.coordinator, "a newer post");
		const after = o.render(80);
		expect(after.slice(2, 20)).toEqual(before.slice(2, 20));
	});

	test("projection and widget lines cover the states", async () => {
		const model = await populated(2);
		const v = project(model);
		expect(v.threads[0]?.rows[0]?.owner).toBe("parser");
		expect(v.reel[0]?.path).toBe("/tmp/x.png");
		expect(widgetLine(model)).toMatch(/^swarm · parser {2}rewrite · ●0 ○1 · #\d+ · \d+ unread · \/swarm$/);
		// The interactive coordinator was sent an aside for the worker's report; let it lapse.
		await until(() => !h.rt.coordinator.delivery, 1000, "aside released");
		await h.call("read_board", {});
		h.rt.stall.interactiveStalled = true;
		const w = h.call("swarm_wait", {});
		await until(() => h.rt.coordinator.phase === "parked", 1000, "parked");
		expect(widgetLine(model)).toBe("swarm · stalled — waiting for you · /swarm");
		h.rt.onSessionClear();
		await w;
	});
});
