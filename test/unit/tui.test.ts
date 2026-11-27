// /swarm overlay rendering and keyboard paths over a real runtime's read model (§10.2, T5).

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { batch, createSurface, getOwner, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleKey } from "@oh-my-pi/pi-tui/dispatch";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { bold, inverse, italic, strikethrough, underline } from "@oh-my-pi/pi-tui/theme/theme";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CoordinatorBinding } from "../../src/runtime/coordinator.ts";
import { RuntimeReadModel } from "../../src/runtime/read-model.ts";
import { postedFrames, project } from "../../src/ui/model.ts";
import { renderDirectMessage, renderWebBoardMessage } from "../../src/ui/tui/custom-message.ts";
import { Keys, printable } from "../../src/ui/tui/keys.ts";
import { EmptyOverlay, SwarmOverlay } from "../../src/ui/tui/overlay.ts";
import { widgetLine } from "../../src/ui/tui/widget.ts";
import { fastTimers, Harness, until } from "../helpers/harness.ts";

let h: Harness;
const dispose: (() => void)[] = [];
beforeAll(() => fastTimers());
afterEach(async () => {
	for (const cleanup of dispose.splice(0)) cleanup();
	await h?.close();
});

const theme = Object.assign(loadThemeSync("dark"), { bold, inverse, italic, strikethrough, underline });
const decode = (raw: string) => decodeKey(raw, { kitty: false, backspaceIsCtrl: false });

function overlay(model: RuntimeReadModel, rows: number, view: "overview" | "board" | "members" | "transcript" = "overview") {
	const size = { rows, columns: 80 };
	let closed = false;
	const overlay = new SwarmOverlay(model, { size: () => size }, theme, undefined, () => { closed = true; }, view);
	const canvas = overlay.component() as UiNode<"canvas">;
	dispose.push(() => overlay.dispose());
	return {
		size,
		closed: () => closed,
		paint: (width: number) => canvas.props().paint(width),
		key(raw: string) {
			const key = decode(raw);
			if (key) batch(() => bubbleKey([canvas], key));
		},
	};
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
	test("renders exactly the terminal rows at wide, narrow, and compact sizes without exceeding the width", async () => {
		const model = await populated();
		for (const [cols, rows] of [
			[80, 24],
			[40, 12],
			[30, 8],
		] as const) {
			for (const v of ["overview", "board", "members", "transcript"] as const) {
				const lines = overlay(model, rows, v).paint(cols);
				expect(lines.length).toBe(rows);
				for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(cols);
				const joined = lines.join("\n");
				expect(joined.includes("\x1b[2J")).toBe(false);
				expect(joined.includes("\x1b]0;")).toBe(false);
				expect(joined.includes("\u202e")).toBe(false);
			}
		}
		const board = overlay(model, 8, "board");
		for (const key of "/no-such-post\r") board.key(key);
		const noMatches = board.paint(30)[1]!;
		expect(noMatches).toContain("No posts match the filters");
		expect(visibleWidth(noMatches)).toBeLessThanOrEqual(30);

		const responsive = overlay(model, 24);
		responsive.size.rows = 5;
		const tiny = responsive.paint(30);
		expect(tiny[0]).toContain("terminal too small");
		expect(tiny.length).toBe(5);
	});

	test("keyboard path: search → #seq jump (filters suspended) → o → t → Esc → Esc → b → q", async () => {
		const model = await populated();
		const { paint, key, closed } = overlay(model, 24, "overview");
		key("2");
		for (const c of "/fail") key(c);
		key("\r");
		let status = paint(80)[22] ?? "";
		expect(status).toContain("/fail");
		for (const c of "#10") key(c);
		key("\r");
		status = paint(80)[22] ?? "";
		expect(status).toContain("#10 · filters off · b back");
		key("o");
		let lines = paint(80);
		expect(lines[1]).toContain("3 Members");
		expect(lines.join("\n")).toContain("coordinator");
		key("t");
		lines = paint(80);
		expect(lines[2]).toContain("coordinator");
		key("\x1b");
		expect(paint(80)[22]).toContain("coordinator");
		key("\x1b");
		expect(paint(80)[22]).toContain("#10 · filters off · b back");
		key("b");
		expect(paint(80)[22]).toContain("/fail");
		key("q");
		expect(closed()).toBe(true);
	});

	test("a 5 000-post board renders in under 50 ms; a new post never moves a non-following board", async () => {
		const model = await populated(10);
		for (let i = 0; i < 5000; i++) h.rt.commitPost(h.rt.coordinator, `bulk ${i}`);
		const { paint, key } = overlay(model, 24, "board");
		paint(80);
		key("\x1b[A");
		key("\x1b[A");
		const t0 = performance.now();
		const before = paint(80);
		expect(performance.now() - t0).toBeLessThan(50);
		h.rt.commitPost(h.rt.coordinator, "a newer post");
		const after = paint(80);
		expect(after.slice(2, 20)).toEqual(before.slice(2, 20));
	});

	test("projection and widget lines cover the states", async () => {
		const model = await populated(2);
		const v = project(model);
		expect(v.threads[0]?.rows[0]?.owner).toBe("parser");
		expect(v.reel[0]?.path).toBe("/tmp/x.png");
		expect(widgetLine(model)).toMatch(/^swarm · parser {2}rewrite · ●0 ○1 · #\d+ · \d+ unread · \/swarm$/);
		const url = "http://127.0.0.1:40593/";
		const label = `swarm · ${url}`;
		const status = widgetLine(model);
		const compact = status.replace(/^swarm · parser {2}rewrite/, label);
		expect(widgetLine(model, url)).toBe(status.replace(/^swarm/, label));
		expect(widgetLine(model, url, visibleWidth(compact) + 10)).toBe(compact.replace(label, `${label} · parser…`));
		expect(widgetLine(model, url, visibleWidth(compact))).toBe(compact);
		expect(widgetLine(model, url, visibleWidth(label) + 4)).toBe(label);
		expect(widgetLine(model, url, visibleWidth(url))).toBe(url);
		const narrow = widgetLine(model, url, visibleWidth(url) - 1);
		expect(narrow).toBe(`${url.slice(0, -2)}…`);
		for (const value of ["complete", "complete_with_abandonment", "incomplete"] as const) {
			h.rt.outcome = { value, reason: "", at: "", terminal: true };
			const state = value === "incomplete" ? "incomplete" : "complete";
			expect(widgetLine(model, url)).toBe(`${label} · ${state} · #${model.head} · /swarm`);
		}
		h.rt.outcome = null;
		// The interactive coordinator was sent an aside for the worker's report; let it lapse.
		await until(() => !h.rt.coordinator.delivery, 1000, "aside released");
		await h.call("read_board", {});
		h.rt.stall.interactiveStalled = true;
		const w = h.call("swarm_wait", {});
		await until(() => h.rt.coordinator.phase === "parked", 1000, "parked");
		expect(widgetLine(model)).toBe("swarm · stalled — waiting for you · /swarm");
		expect(widgetLine(model, url)).toBe(`${label} · stalled — waiting for you · /swarm`);
		h.rt.onSessionClear();
		await w;
		h.member("parser").phase = "stopped";
		h.rt.changed();
		expect(widgetLine(model, url)).toMatch(/^swarm · http:\/\/127\.0\.0\.1:40593\/ · restored: 1 stopped, \d+ owed · \/swarm$/);
	});
});

test("closing either ANSI overlay disposes its nodes when the host built it without an owner", async () => {
	const model = await populated(0);
	const ui = { size: () => ({ rows: 24, columns: 80 }) };
	let closes = 0;
	const done = () => { closes++; };
	const overlays = [new EmptyOverlay(ui, undefined, done), new SwarmOverlay(model, ui, theme, undefined, done, "overview")];
	for (const overlay of overlays) dispose.push(() => overlay.dispose());
	expect(getOwner()).toBeNull();
	for (const overlay of overlays) {
		const canvas = overlay.component() as UiNode<"canvas">;
		expect(canvas.kind).toBe("canvas");
		expect(canvas.props().paint(80)).toHaveLength(24);
		expect(canvas.disposed).toBe(false);
		expect(bubbleKey([canvas], decode("q")!)).toBe(true);
		expect(canvas.disposed).toBe(true);
	}
	expect(closes).toBe(2);
});

test("19.2 key events honor selection bindings and ignore release events", () => {
	const key = decode("\x1b[106;5u")!;
	const bindings = KeybindingsManager.inMemory({ "tui.select.down": "ctrl+j" });
	const keys = new Keys(bindings);
	expect(keys.down(key)).toBe(true);
	expect(keys.down({ ...key, kind: "release" })).toBe(false);
	expect(keys.down(decode("\x1b[B")!)).toBe(true);
	expect(keys.shiftTab(decode("\x1b[Z")!)).toBe(true);
	expect(printable(decode("\x1b[107;2u")!)).toBe("K");
	expect(printable({ id: "q", text: "q", raw: "q", kind: "release" })).toBeUndefined();
});

test("persistent web board renderer strips escapes from persisted content", () => {
	const message = { content: "http://127.0.0.1:40593/\x1b[2J\nssh -L\x1b]0;PWNED\x07 40593:127.0.0.1:40593 <host>\u202e" };
	const surface = createSurface(() => ({ main: renderWebBoardMessage(message, { expanded: false }, theme) }));
	const canvas = surface.main()[0] as UiNode<"canvas">;
	const output = canvas.props().paint(80).join("\n");
	surface.dispose();
	expect(output).toContain("Swarm web board");
	expect(output).toContain("http://127.0.0.1:40593/");
	expect(output).toContain("ssh -L 40593:127.0.0.1:40593 <host>");
	expect(output).not.toMatch(/\x1b\[2J|\x1b\]0;|PWNED|\u202e/);
});

test("postedFrames includes coordinator and worker markdown updates, ignores briefs and code fences", async () => {
	h = new Harness({ mode: "tui" });
	h.factory.brains.set("parser", async t => {
		await t.call("post_message", {
			text: "@coordinator [done] fixed\nProgress: Worker milestone\n- **tests**: 12/12 passing\nScreenshot: /tmp/after.png | clean UI",
		});
		await t.call("swarm_wait", {});
	});
	await h.swarm({
		action: "add",
		name: "parser",
		brief: "Work on parser.\nProgress: this brief example must be ignored\nScreenshot: /tmp/brief.png | ignored",
	});
	await until(() => h.member("parser").phase === "parked", 1000, "parked");
	await h.post("Progress: **Phase 1** kicked off\n- `@parser` owns `src/parser.ts`\n```\nProgress: ignored inside fence\nScreenshot: /tmp/fake.png | ignored\n```");
	await h.post("Progress: Single-line **done**");
	const model = new RuntimeReadModel(h.rt);
	const frames = postedFrames(model.messages(), model.members());
	expect(frames.map(f => ({ kind: f.kind, agent: f.agent, caption: f.caption }))).toEqual([
		{ kind: "markdown", agent: "parser", caption: "Worker milestone" },
		{ kind: "image", agent: "parser", caption: "clean UI" },
		{ kind: "markdown", agent: "coordinator", caption: "Phase 1 kicked off" },
		{ kind: "markdown", agent: "coordinator", caption: "Single-line done" },
	]);
	expect(frames[0]?.markdown).toBe("- **tests**: 12/12 passing");
	expect(frames[2]?.markdown).toContain("Progress: ignored inside fence");
	const overview = overlay(model, 24, "overview").paint(80).join("\n");
	expect(overview).toContain("@coordinator Phase 1 kicked off");
});

test("direct message renderer strips escapes from persisted content", () => {
	const message = { content: "→ @parser\ncheck \x1b[2J\x1b]0;PWNED\x07 edge\u202e case" };
	const surface = createSurface(() => ({ main: renderDirectMessage(message, { expanded: false }, theme) }));
	const canvas = surface.main()[0] as UiNode<"canvas">;
	const output = canvas.props().paint(80).join("\n");
	surface.dispose();
	expect(output).toContain("Swarm DM");
	expect(output).toContain("→ @parser");
	expect(output).toContain("check  edge case");
	expect(output).not.toMatch(/\x1b\[2J|\x1b\]0;|PWNED|\u202e/);
});

test("CoordinatorBinding.notify strips ANSI, OSC, and bidi escapes", () => {
	const seen: { text: string; level: string }[] = [];
	const ctx = {
		mode: "tui",
		ui: { notify: (text: string, level: string) => seen.push({ text, level }) },
	} as unknown as ExtensionContext;
	const binding = new CoordinatorBinding({} as ExtensionAPI, ctx, undefined);
	binding.notify("DM → @w: \x1b[2J\x1b]0;PWNED\x07ok\u202e\nnext", "info");
	expect(seen).toEqual([{ text: "DM → @w: ok next", level: "info" }]);
});
