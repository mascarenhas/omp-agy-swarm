import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getThemeByName, type Component } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { TSP_KINDS, type TspKind } from "@oh-my-pi/pi-wire";
import { TIMING } from "../../src/env.ts";
import { RuntimeReadModel } from "../../src/runtime/read-model.ts";
import { entryItems } from "../../src/ui/transcript.ts";
import { renderWakeMessage, renderWebBoardMessage } from "../../src/ui/tui/custom-message.ts";
import { EmptyOverlay, SwarmOverlay } from "../../src/ui/tui/overlay.ts";
import type { OpenTarget, ViewId } from "../../src/ui/tui/view.ts";
import { widgetComponent } from "../../src/ui/tui/widget.ts";
import { fastTimers, Harness, until } from "../helpers/harness.ts";
import { ScriptedSession } from "../helpers/scripted-session.ts";

const BAD = "\x1b[2J\x1b]8;;https://evil.invalid\x1b\\linked\x1b]8;;\x1b\\\x1b]52;c;bad\x07\x1b_tsp;e;bad\x1b\\\u009b31m\u202e\u2066 [literal](https://bad.invalid)";
const LONE_SURROGATES = "high\ud800 low\udc00 emoji 🐙";
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t };
const full = new Set<TspKind>(TSP_KINDS);
const context = (kinds: Set<TspKind> = full): DescribeContext => ({ cols: 100, dark: true, reduceMotion: false, supports: k => kinds.has(k), feature: n => n === "scroll" });
const cx = context();


test("describing a timed wait uses the saved deadline and never reads the clock", async () => {
	const rt = h = new Harness({ mode: "tui", sid: crypto.randomUUID() });
	rt.factory.brains.set("timer", async t => {
		await t.call("post_message", { text: "@coordinator Before the timer." });
		await t.call("swarm_wait", { timeout_seconds: 30 });
	});
	await rt.swarm({ action: "add", name: "timer", brief: "Wait on the board." });
	await until(() => rt.member("timer").waiter?.deadline !== undefined, 2000, "timed wait");
	const model = new RuntimeReadModel(rt.rt);
	const { o } = mount(model, "overview");
	const deadline = rt.member("timer").waiter!.deadline!;
	const clock = spyOn(Date, "now").mockImplementation(() => { throw new Error("describe read the clock"); });
	try {
		const a = page(o, { ...cx, hour12: false });
		const b = page(o, { ...cx, hour12: true });
		const formatted = (hour12: boolean) => new Date(deadline).toLocaleTimeString(undefined, { hour12, hour: "numeric", minute: "2-digit", second: "2-digit" });
		expect(json(a.body)).toContain(`wakes at ${formatted(false)}`);
		expect(json(b.body)).toContain(`wakes at ${formatted(true)}`);
		expect(a.body).not.toBe(b.body);
	} finally { clock.mockRestore(); }
	expect(model.completion()).toContain("wakes in ~");
});
let h: Harness | undefined;
const mounted: SwarmOverlay[] = [];
beforeAll(() => fastTimers());
afterEach(async () => {
	for (const overlay of mounted.splice(0)) overlay.dispose();
	await h?.close();
	h = undefined;
});

async function fixture() {
	const rt = h = new Harness({ mode: "tui", sid: crypto.randomUUID(), env: { maxCostUsd: 2 } });
	rt.factory.resolvedIds.set("parser", "swarm~parser~2");
	rt.factory.brains.set("parser", async t => {
		await t.call("post_message", { text: "@coordinator [done] parser result\nScreenshot: /tmp/progress.png | result frame" });
		await t.call("swarm_wait", {});
	});
	await rt.swarm({ action: "title", title: `Work streams ${BAD}` });
	await rt.swarm({ action: "add", name: "parser", brief: "Worker brief" });
	await until(() => rt.member("parser").phase === "parked", 2000, "test worker parked");
	return { rt, model: new RuntimeReadModel(rt.rt) };
}

function mount(model: RuntimeReadModel, initial: ViewId, target?: OpenTarget) {
	let closes = 0;
	let renders = 0;
	const o = new SwarmOverlay(model, { requestRender() { renders++; } }, theme, undefined, () => { closes++; }, initial, target);
	mounted.push(o);
	return { o, closes: () => closes, renders: () => renders };
}

function component(child: NativeChild | undefined): Component {
	if (!child || "k" in child) throw new Error("Expected an owned component boundary");
	return child;
}

function page(o: SwarmOverlay, cx: DescribeContext = context()) {
	const screen = o.describeScreen(cx);
	const owner = component(screen.main[0]);
	const body = owner.describe?.(cx);
	const dock = o.describe(cx);
	if (!body || !dock) throw new Error("No semantic page or dock");
	return { screen, owner, body, dock };
}

function entries(node: NativeNode, key = ""): { node: NativeNode; key: string }[] {
	return [{ node, key }, ...(node.c ?? []).flatMap((n, i) => {
		if (!("k" in n)) throw new Error("Unexpected nested component boundary");
		const segment = n.key ?? String(i);
		return entries(n, `${key ? `${key}/` : ""}${segment}`);
	})];
}

function get(root: NativeNode, pred: (node: NativeNode) => boolean) {
	const entry = entries(root).find(({ node }) => pred(node));
	if (!entry) throw new Error("Expected a matching semantic node");
	return entry;
}

function click(owner: Component, root: NativeNode, action: string) {
	const { key } = get(root, n => n.k === "button" && n.p?.actions?.click === `swarm.${action}`);
	owner.handleNativeEvent?.({ type: "action", key, act: `swarm.${action}`, mods: [] });
}

const json = (node: NativeNode) => JSON.stringify(node);

function assertSafe(value: unknown): void {
	if (typeof value === "string") expect(value).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\p{Surrogate}/u);
	else if (Array.isArray(value)) for (const child of value) assertSafe(child);
	else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
		expect(["href", "html", "src"]).not.toContain(key);
		if (key === "click") expect(child).toMatch(/^swarm\.[a-zA-Z0-9:%_.!~*'()-]+$/);
		assertSafe(child);
	}
}

function assertTree(node: NativeNode, kinds: Set<TspKind> = full): void {
	for (const { node: n } of entries(node)) {
		expect(kinds.has(n.k)).toBe(true);
		expect(["rows", "ansi", "md", "web", "image", "editor"]).not.toContain(n.k);
		assertSafe(n.p);
		const keys = (n.c ?? []).flatMap(c => "k" in c && c.key !== undefined ? [c.key] : []);
		expect(new Set(keys).size).toBe(keys.length);
	}
}

test("native empty and refused overlays are distinct, safe, cached pages with one close", () => {
	for (const reason of [undefined, `storage unavailable ${BAD}`]) {
		let closes = 0;
		const o = new EmptyOverlay({ requestRender() {} }, undefined, () => { closes++; }, reason);
		const screen = o.describeScreen();
		expect(screen.role).toBe("omp.swarm");
		expect(screen.main).toEqual([o]);
		const node = o.describe(cx)!;
		expect(o.describe(cx)).toBe(node);
		expect(node.p?.role).toBe(reason ? "omp.swarm.refused" : "omp.swarm.empty");
		assertTree(node);
		click(o, node, "close");
		o.handleInput("q");
		expect(closes).toBe(1);
	}
});

test("native page retains ownership, view state and literal data across feature negotiation and help", async () => {
	const { rt, model } = await fixture();
	const w = rt.member("parser");
	w.model = `mock/bad ${BAD}`;
	w.workspace.path = `/tmp/literal ${BAD}`;
	w.workspace.state = "retained";
	w.workspace.retained_reason = `why ${BAD}`;
	w.workspace.cleanup = `how ${BAD}`;
	rt.rt.spendUnknown = `no price ${BAD}`;
	rt.rt.commitPost(w, `literal post ${BAD}`);
	writeFileSync(join(rt.dir, "plan.json"), JSON.stringify({ goal: { title: `Goal ${BAD}` }, tasks: { parser: `Task ${BAD}` }, threads: [
		{ id: "story", title: `Shared outcome ${BAD}`, tasks: ["parser", "parser", "nonexistent"] },
		{ id: "others", title: "Other outcome", tasks: ["parser"] },
	] }));
	const { o } = mount(model, "overview");
	const a = page(o);
	const again = page(o);
	expect(again.screen).toBe(a.screen);
	expect(a.screen.dock).toEqual([o]);
	expect(again.body).toBe(a.body);
	expect(again.dock).toBe(a.dock);
	expect(json(a.body)).toContain("Shared outcome");
	expect(json(a.body)).toContain("result frame");
	expect(json(a.body)).toContain("unknown / $2");
	const tab = get(a.body, n => n.k === "tabs");
	expect(tab.node.k === "tabs" && tab.node.p?.items.map(i => i.id)).toEqual(["overview", "board", "members", "transcript"]);
	assertTree(a.body);
	assertTree(a.dock);

	click(o, a.dock, "help");
	const help = page(o);
	expect(get(help.dock, n => n.k === "overlay").node.p?.role).toBe("omp.swarm.help");
	a.owner.handleNativeEvent?.({ type: "select", key: tab.key, item: "board" });
	expect(page(o).body).toBe(a.body);
	click(o, help.dock, "close-help");
	const first = get(a.body, n => n.k === "list" && n.p?.selected !== undefined);
	const item = get(first.node, n => n.k === "item" && n.key?.endsWith(":2") === true);
	a.owner.handleNativeEvent?.({ type: "select", key: first.key, item: item.node.key! });
	const selected = page(o);
	expect(selected.body).not.toBe(a.body);
	expect(get(selected.body, n => n.p?.role === "omp.swarm.header").node).toBe(get(a.body, n => n.p?.role === "omp.swarm.header").node);
	o.handleInput("\r");
	const members = page(o);
	expect(json(members.body)).toContain("omp.swarm.members");
	expect(json(members.body)).toContain("mock/bad linked [literal]");
	expect(json(members.body)).toContain("Retained");
	assertTree(members.body);
	// A Board click on an old view key must not change this selected Member.
	a.owner.handleNativeEvent?.({ type: "activate", key: "board/posts", item: `post:${rt.rt.board.head}` });
	expect(page(o).body).toBe(members.body);

	const basic = new Set<TspKind>(["col", "text"]);
	const mutable = context(basic);
	const minimal = page(o, mutable);
	expect(minimal.screen).toBe(a.screen);
	assertTree(minimal.body, basic);
	assertTree(minimal.dock, basic);
	expect(json(minimal.body)).toContain("View transcript");
	o.handleInput("t");
	expect(json(page(o, mutable).body)).toContain("swarm~parser~2");
	basic.clear();
	expect(o.describeScreen(mutable).main).toEqual([o]);
	expect(o.describe(mutable)).toBeNull();
	for (const kind of full) basic.add(kind);
	expect(json(page(o, mutable).body)).toContain("omp.swarm.transcript");
});

test("Overview caps unaddressed posts, retains failures, and keeps non-member owner rows inert in ANSI", async () => {
	const { rt, model } = await fixture();
	const hostile = `untrusted-${"long-id".repeat(600)}`;
	const member = rt.member("parser");
	for (let i = 0; i < 60; i++) rt.rt.commitPost(member, `absolute observation ${i}`);
	member.failure = { kind: "error", text: "runtime failure before unaddressed flood", at: "", at_seq: 0, count: 1 };
	rt.rt.changed();
	writeFileSync(join(rt.dir, "view.json"), JSON.stringify({
		threads: [{ title: `${hostile} ${LONE_SURROGATES}`, workstreams: ["ghost", "known"] }],
		workstreams: [{ id: "ghost", owners: ["not-a-member"], title: "visible but inert task" }, { id: "known", owners: ["parser"], title: "owned task" }],
		attention: [{ kind: hostile, text: `${LONE_SURROGATES} attention` }],
		reel: { frames: [{ seq: rt.rt.board.head, path: `/tmp/${hostile}`, caption: "a frame" }] },
	}));
	const { o } = mount(model, "overview");
	const native = page(o);
	const attention = get(native.body, n => n.k === "section" && n.key === "attention").node;
	expect(entries(attention).filter(e => e.node.key?.startsWith("notice:"))).toHaveLength(52);
	expect(json(attention)).toContain("10 more unaddressed posts not shown");
	expect(json(attention)).toContain("runtime failure before unaddressed flood");
	expect(json(attention)).toContain(`#${rt.rt.board.head} result addressed to nobody`);
	expect(json(attention)).not.toContain("#3 result addressed");
	expect(json(attention)).toContain("high low emoji 🐙");
	expect(entries(native.body).every(e => e.key.length < 128 && !e.key.includes("untrusted-"))).toBe(true);
	assertTree(native.body);
	const rows = o.render(100);
	expect(rows.join("\n")).toContain("not-a-member");
	o.handleInput("\r"); // Enter skips the first, non-member row.
	const members = o.render(100);
	expect(members[1]).toContain("3 Members");
	expect(members.at(-2)).toContain("parser");
});

test("usage alone invalidates the native spend header, and full path stays under coordinator details", async () => {
	const rt = h = new Harness({ mode: "tui", sid: crypto.randomUUID(), env: { maxCostUsd: 2 } });
	const model = new RuntimeReadModel(rt.rt);
	const { o, renders } = mount(model, "members");
	const before = page(o);
	const header = () => get(page(o).body, n => n.p?.role === "omp.swarm.header").node;
	const initialHeader = header();
	expect(json(initialHeader)).toContain("$0.0000 / $2");
	expect(json(initialHeader)).not.toContain(model.swarmDir);
	expect(json(before.body)).toContain("Swarm directory");
	expect(json(before.body)).toContain(model.swarmDir);
	rt.rt.onMainMessageEnd({ role: "assistant", content: [], usage: { totalTokens: 8, cost: { total: 0.0123 } } });
	await until(() => renders() > 0, 2000, "render requested for spend");
	expect(header()).not.toBe(initialHeader);
	expect(json(header())).toContain("$0.0123 / $2");
});

test("native Members Enter opens the visible transcript action and leaves tab, help, and close keys available", async () => {
	const { model } = await fixture();
	const { o, closes } = mount(model, "members", { member: "parser" });
	page(o);
	o.handleInput("\r");
	expect(json(page(o).body)).toContain("omp.swarm.transcript");
	o.handleInput("\x1b");
	const members = page(o);
	expect(json(members.body)).toContain("omp.swarm.members");
	expect(get(members.dock, n => n.p?.actions?.click === "swarm.help")).toBeDefined();
	expect(get(members.dock, n => n.p?.actions?.click === "swarm.close")).toBeDefined();
	o.handleInput("2");
	expect(json(page(o).body)).toContain("omp.swarm.board");
	o.handleInput("q");
	expect(closes()).toBe(1);
});

test("native Board is bounded, preserves post nodes on append, and shares selection/expansion and UTF-16 capture", async () => {
	const { rt, model } = await fixture();
	const wrk = rt.member("parser");
	for (let i = 0; i < 5000; i++) rt.rt.commitPost(wrk, `bulk ${i}`);
	const committed = rt.rt.commitPost(wrk, `long 🐙 ${"post body ".repeat(150)} ${BAD} long end`);
	if ("error" in committed) throw new Error(committed.error);
	const long = committed.msg;
	const cursor = model.coordinatorCursor();
	const { o } = mount(model, "board");
	let b = page(o);
	const outcome = get(b.body, n => n.k === "badge" && n.key === "outcome").node;
	if (outcome.k !== "badge") throw new Error("Expected a native outcome badge");
	expect(outcome.p?.text).toContain(`${long.seq - 1} unread`);
	expect(outcome.p?.text?.length).toBeLessThanOrEqual(160);
	expect(outcome.p?.text).not.toContain("#5000");
	expect(model.completion()).toContain("#5000"); // Legacy status still exposes every owed sequence.
	const posts = () => get(b.body, n => n.k === "list" && n.key === "posts");
	const selected = () => { const { node } = posts(); return node.k === "list" ? node.p?.selected : undefined; };
	const postKeys = () => (posts().node.c ?? []).flatMap(n => "k" in n && n.key?.startsWith("post:") ? [n.key] : []);
	const tailKeys = postKeys();
	expect(tailKeys).toHaveLength(50);
	o.handleInput("\x1b[A");
	b = page(o);
	expect(postKeys()).toEqual(tailKeys);
	expect(selected()).toBe(`post:${long.seq - 1}`);
	click(b.owner, b.body, "older");
	b = page(o);
	expect(postKeys()).toEqual(tailKeys.map((_, i) => `post:${long.seq - 99 + i}`));
	click(b.owner, b.body, "newer");
	b = page(o);
	expect(postKeys()).toEqual(tailKeys);
	for (let i = 0; i < 49; i++) o.handleInput("\x1b[A");
	b = page(o);
	expect(postKeys()).toEqual([`post:${long.seq - 50}`, ...tailKeys.slice(0, -1)]);
	o.handleInput("\x1b[F");
	b = page(o);
	expect(selected()).toBe(`post:${long.seq}`);
	expect(json(b.body)).not.toContain("long end");
	const longRow = () => get(b.body, n => n.k === "item" && n.key === `post:${long.seq}`).node;
	const row = longRow();
	o.handleInput("\r");
	b = page(o);
	expect(json(b.body)).toContain("long end");
	const card = get(b.body, n => n.k === "card");
	b.owner.handleNativeEvent?.({ type: "toggle", key: card.key, collapsed: true });
	b = page(o);
	expect(json(b.body)).not.toContain("long end");
	b.owner.handleNativeEvent?.({ type: "toggle", key: card.key, collapsed: true });
	expect(page(o).body).toBe(b.body);
	b.owner.handleNativeEvent?.({ type: "activate", key: posts().key, item: `post:${long.seq}` });
	b = page(o);
	expect(json(b.body)).toContain("long end");
	rt.rt.commitPost(wrk, "new post while paused");
	b = page(o);
	expect(selected()).toBe(`post:${long.seq}`);
	expect(longRow()).toBe(row);
	assertTree(b.body);

	click(b.owner, b.body, "search");
	const s = page(o);
	const field = get(s.dock, n => n.k === "input");
	const edit = (text: string, from: number, to: number, cursor: number, len: number) => o.handleNativeEvent({ type: "edit", key: field.key, text, from, to, cursor, len });
	edit("🐙bulk", 0, 0, 6, 0);
	const edited = page(o);
	expect(json(edited.dock)).toContain("🐙bulk");
	edit("bad", 0, 4, 3, 999);
	expect(page(o).dock).toBe(edited.dock);
	edit("", 1, 1, 1, 6); // snap the cursor out of the surrogate pair without deleting it
	const caret = get(page(o).dock, n => n.k === "input").node;
	expect(caret.k === "input" && caret.p).toMatchObject({ text: "🐙bulk", cursor: 0, sendable: false });
	edit("", 1, 2, 0, 6); // deleting only one half must remove the pair, not leave invalid UTF-16
	expect(json(page(o).dock)).toContain('"text":"bulk"');
	o.handleNativeEvent({ type: "undo", key: field.key });
	expect(json(page(o).dock)).toContain('"text":"🐙bulk"');
	edit("bulk", 0, 6, 4, 6);
	o.handleInput("\r");
	b = page(o);
	b.owner.handleNativeEvent?.({ type: "activate", key: posts().key, item: `post:${long.seq}` });
	expect(page(o).body).toBe(b.body); // no longer visible under the filter
	click(b.owner, b.body, "jump");
	const jump = get(page(o).dock, n => n.k === "input");
	const seq = String(long.seq);
	o.handleNativeEvent({ type: "edit", key: jump.key, text: `a${seq}#`, from: 0, to: 0, cursor: seq.length + 2, len: 0 });
	expect(json(page(o).dock)).toContain(`"text":"${seq}"`);
	o.handleInput("\r");
	b = page(o);
	expect(selected()).toBe(`post:${long.seq}`);
	expect(json(b.dock)).toContain("filters off");
	click(b.owner, b.body, "restore");
	expect(json(page(o).dock)).toContain("/bulk");
	expect(model.coordinatorCursor()).toBe(cursor);
});

test("native Transcript pages and searches without ANSI render, follows source epochs, and only hints live registry ids", async () => {
	const { rt, model } = await fixture();
	const member = rt.member("parser");
	const session = rt.session("parser");
	session.entries.length = 0;
	for (let i = 0; i < 430; i++) session.entries.push({ type: "custom_message", id: `history-${i}`, parentId: null, content: i === 1 ? "FIRST-UNIQUE" : i === 427 ? `TAIL-UNIQUE ${BAD}` : `Message ${i}` });
	session.entries.push({ type: "message", id: "tool", parentId: null, message: { role: "toolResult", toolName: `evilTool ${BAD}`, content: [{ type: "text", text: `tool output ${BAD}` }] } });
	rt.rt.changed();
	const { o } = mount(model, "transcript", { member: "parser" });
	let tr = page(o);
	expect(json(tr.body)).toContain("TAIL-UNIQUE");
	expect(json(tr.body)).toContain("swarm~parser~2");
	expect(json(tr.body)).toContain("(Agents), select ");
	expect(json(tr.body)).not.toContain("FIRST-UNIQUE");
	assertTree(tr.body);
	const entryKeys = () => entries(tr.body).flatMap(e => e.node.key?.startsWith("entry:") ? [e.node.key] : []);
	const tail = entryKeys();
	expect(tail[0]).toEndWith(":tool%230");
	expect(tail.at(-1)).toEndWith(":history-391%230");
	expect(tail).toHaveLength(40);
	const transcript = get(tr.body, n => n.p?.role === "omp.swarm.transcript").node;
	expect(transcript.c?.[1]).toBe(get(tr.body, n => n.key === "history").node);
	o.handleInput("\x1b[5~");
	tr = page(o);
	expect(entryKeys()[0]).toEndWith(":history-390%230");
	o.handleInput("\x1b[6~");
	tr = page(o);
	expect(entryKeys()).toEqual(tail);
	for (let i = 0; i < 10; i++) o.handleInput("\x1b[5~");
	tr = page(o);
	expect(entryKeys().at(-1)).toEndWith(":history-0%230");
	expect(entryKeys()).toHaveLength(31);
	o.handleInput("\x1b[5~");
	expect(page(o).body).toBe(tr.body);
	o.handleInput("\x1b[F"); // follow the tail again
	const longText = `${"long-line\n".repeat(90)}LAST-LINE ${LONE_SURROGATES}`;
	session.entries.push({ type: "custom_message", id: "long-latest", parentId: null, content: longText });
	rt.rt.changed();
	tr = page(o);
	expect(entryKeys()).toHaveLength(1);
	expect(entryKeys()[0]).toEndWith(":long-latest%230");
	expect(json(tr.body)).toContain("LAST-LINE high low emoji 🐙");
	assertTree(tr.body);
	click(tr.owner, tr.body, "head");
	tr = page(o);
	expect(json(tr.body)).toContain("FIRST-UNIQUE");
	expect(json(tr.body)).not.toContain("TAIL-UNIQUE");
	expect(entryKeys()).toHaveLength(40);
	o.handleInput("\x1b[5~");
	expect(page(o).body).toBe(tr.body);
	click(tr.owner, tr.body, "newer");
	tr = page(o);
	expect(json(tr.body)).not.toContain("FIRST-UNIQUE");
	o.handleInput("\x1b[5~");
	tr = page(o);
	expect(json(tr.body)).toContain("FIRST-UNIQUE");
	click(tr.owner, tr.body, "newer");
	tr = page(o);
	const paused = entryKeys();
	expect(paused[0]).not.toEndWith(":history-0%230");
	o.handleInput("/");
	o.handleInput("i");
	tr = page(o);
	expect(entryKeys()).toEqual(paused);
	o.handleInput("\x1b");
	tr = page(o);
	expect(entryKeys()).toEqual(paused);
	click(tr.owner, tr.body, "search");
	const input = get(page(o).dock, n => n.k === "input");
	o.handleNativeEvent({ type: "edit", key: input.key, from: 0, to: 0, text: "unfindable", cursor: 10, len: 0 });
	o.handleInput("\r");
	expect(json(page(o).body)).toContain("No matches in the loaded transcript items");
	o.handleInput("/");
	o.handleInput("\x1b");
	tr = page(o);
	expect(entryKeys()).toEqual(paused);
	session.entries.push({ type: "reset_boundary", id: "reset", parentId: null });
	session.entries.push({ type: "custom_message", id: "after-reset", parentId: "reset", content: "NEW-EPOCH" });
	rt.rt.changed();
	tr = page(o);
	expect(json(tr.body)).toContain("NEW-EPOCH");
	expect(json(tr.body)).not.toContain("FIRST-UNIQUE");
	click(tr.owner, tr.body, "previous-member");
	expect(json(page(o).body)).not.toContain("For omp’s live transcript");
	o.handleInput("]");
	expect(json(page(o).body)).toContain("swarm~parser~2");
	member.phase = "stopped"; // even a parked session reference must not be treated as live once stopped
	rt.rt.changed();
	expect(model.members().find(m => m.name === "parser")?.liveAgentId).toBeUndefined();
	tr = page(o);
	expect(json(tr.body)).toContain("stopped · read-only history");
	expect(json(tr.body)).not.toContain("For omp’s live transcript");
	rt.factory.resolvedIds.set("parser", "swarm~parser~3");
	const replaced = new ScriptedSession(rt.factory, session.opts, "replacement");
	replaced.entries.push({ type: "custom_message", id: "after-reset", parentId: null, content: "REPLACEMENT-SESSION" });
	member.session = replaced;
	member.phase = "idle";
	rt.rt.changed();
	tr = page(o);
	expect(json(tr.body)).toContain("swarm~parser~3");
	expect(json(tr.body)).toContain("REPLACEMENT-SESSION");
	expect(json(tr.body)).not.toContain("NEW-EPOCH");
	member.phase = "killed";
	member.killed = true;
	member.sessionFile = null;
	rt.rt.changed();
	tr = page(o);
	expect(json(tr.body)).toContain("killed · read-only history");
	expect(json(tr.body)).toContain("Transcript unavailable");
	expect(json(tr.body)).not.toContain("For omp’s live transcript");
	o.handleInput("3");
	let roster = page(o);
	expect(entries(roster.body).some(e => e.node.key === "member:parser")).toBe(false);
	click(roster.owner, roster.body, "killed");
	roster = page(o);
	expect(entries(roster.body).some(e => e.node.key === "member:parser")).toBe(true);
	member.session = session; // retain fixture ownership for teardown
});

test.each(["follow", "paused", "before paging"] as const)("native Transcript discards retired entries after a real same-session branch rewind (%s)", mode => {
	const rt = h = new Harness({ mode: "tui", sid: crypto.randomUUID() });
	const manager = SessionManager.inMemory(rt.binding.cwd);
	rt.binding.branchEntries = () => manager.getBranch();
	const common = manager.appendCustomMessageEntry("probe", "COMMON-ENTRY", true);
	const oldCount = mode === "before paging" ? 220 : 1;
	for (let i = 0; i < oldCount; i++) manager.appendCustomMessageEntry("probe", `RETIRED-ENTRY ${i}`, true);
	const model = new RuntimeReadModel(rt.rt);
	const source = model.transcript("coordinator")!;
	const oldPage = source.page({});
	const { o } = mount(model, "transcript", { member: "coordinator" });
	expect(json(page(o).body)).toContain("RETIRED-ENTRY");
	if (mode === "paused") o.handleInput("f");
	if (mode === "before paging") for (let i = 0; i < 4; i++) o.handleInput("\x1b[5~");
	const ansi = mode === "before paging" ? undefined : mount(model, "transcript", { member: "coordinator" }).o;
	if (ansi) {
		expect(ansi.render(100).join("\n")).toContain("RETIRED-ENTRY");
		if (mode === "paused") ansi.handleInput("f");
	}

	manager.branch(common);
	manager.appendCustomMessageEntry("probe", "REPLACEMENT-ENTRY", true);
	if (mode === "before paging") {
		// No model notification yet: this key exercises the stale `before` cursor itself.
		o.handleInput("\x1b[5~");
	} else rt.rt.changed();

	const current = manager.getBranch().flatMap(entryItems).reverse();
	const rendered = page(o).body;
	const nodes = entries(rendered).filter(e => e.node.key?.startsWith("entry:"));
	const keys = nodes.map(e => e.node.key);
	expect(keys).toHaveLength(current.length);
	expect(new Set(keys).size).toBe(keys.length);
	expect(keys.map(k => k?.slice(k.lastIndexOf(":") + 1))).toEqual(current.map(i => encodeURIComponent(i.id)));
	expect(nodes.map(({ node }) => {
		const body = get(node, n => n.key === "body").node;
		return body.k === "text" ? body.p?.spans?.map(s => s.t).join("") : undefined;
	})).toEqual(current.map(i => i.text));
	expect(json(rendered)).not.toContain("RETIRED-ENTRY");
	if (ansi) {
		const lines = ansi.render(100);
		expect(lines.filter(line => line.includes("-ENTRY")).map(line => line.trim())).toEqual(current.map(i => i.text).reverse());
	}
	expect(model.transcript("coordinator")).toBe(source);
	expect(source.page({ after: oldPage.last })).toMatchObject({ epoch: oldPage.epoch, cursor_reset: true });
	expect(source.page({ before: oldPage.last })).toMatchObject({ epoch: oldPage.epoch, cursor_reset: true });
	const replacement = source.page({});
	manager.appendCustomMessageEntry("probe", "ORDINARY-APPEND", true);
	const append = source.page({ after: replacement.last });
	expect(append.epoch).toBe(replacement.epoch);
	expect(append.cursor_reset).toBeUndefined();
	expect(append.items.map(it => it.text)).toEqual(["ORDINARY-APPEND"]);
});

test("native Overview refreshes last-good files on its poll and disposes its update sources once", async () => {
	const { rt, model } = await fixture();
	const plan = join(rt.dir, "plan.json");
	writeFileSync(plan, JSON.stringify({ goal: "Last good goal" }));
	let unsubscribed = 0;
	const subscribe = model.onChange.bind(model);
	model.onChange = cb => {
		const unsubscribe = subscribe(cb);
		return () => { unsubscribed++; unsubscribe(); };
	};
	const poll = TIMING.uiFilePollMs;
	fastTimers({ uiFilePollMs: 20 });
	const { o, renders } = mount(model, "overview");
	fastTimers({ uiFilePollMs: poll });
	const before = page(o);
	expect(json(before.body)).toContain("Last good goal");
	writeFileSync(plan, "{");
	await until(() => renders() > 0, 2000, "file invalidation");
	const after = page(o);
	expect(after.body).not.toBe(before.body);
	expect(json(after.body)).toContain("Last good goal");
	expect(json(after.body)).toContain("plan: invalid");
	o.dispose();
	o.dispose();
	expect(unsubscribed).toBe(1);
	const count = renders();
	rt.rt.changed();
	writeFileSync(plan, JSON.stringify({ goal: "Not observed" }));
	// The real filesystem poll must not fire after disposal; a fake clock would not exercise it.
	await Bun.sleep(TIMING.uiRenderCoalesceMs + 30);
	expect(renders()).toBe(count);
});

test("widget URL changes independently of the model; wake and web notice keep literal, safe semantic bodies", async () => {
	const { model } = await fixture();
	const url = "http://127.0.0.1:40593/";
	const authorized = `${url}\ntailscale serve 40593\nssh -L 40593:127.0.0.1:40593 <host>\nRead-only. Anyone who can reach the board can read it.`;
	let link: string | undefined;
	const widget = widgetComponent(model, { requestRender() {} }, () => link);
	try {
		const w = widget.describe(cx)!;
		expect(widget.describe(cx)).toBe(w);
		expect(w.p?.role).toBe("omp.swarm.widget");
		link = url;
		const running = widget.describe(cx)!;
		expect(running).not.toBe(w);
		expect(json(running)).toContain(url);
		link = undefined;
		expect(json(widget.describe(cx)!)).not.toContain(url);
		assertTree(running);
	} finally { widget.dispose(); }
	const th = await getThemeByName("dark");
	if (!th) throw new Error("Expected the pinned host's dark theme");
	const web = renderWebBoardMessage({ content: `${authorized}\n${BAD}` }, { expanded: false }, th);
	const wake = renderWakeMessage({ content: `[swarm] ${BAD}\n! <untrusted>` }, { expanded: false }, th);
	for (const [msg, role, body] of [[web, "omp.swarm.webNotice", authorized], [wake, "omp.swarm.wake", "! <untrusted>"]] as const) {
		const node = msg.describe?.(cx);
		if (!node) throw new Error("Expected a semantic notice");
		expect(msg.describe?.(cx)).toBe(node);
		expect(node.p?.role).toBe(role);
		expect(json(node)).toContain(JSON.stringify(body).slice(1, -1));
		expect(json(node)).toContain("[literal](https://bad.invalid)");
		assertTree(node);
	}
});
