import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeTsp, encodeTspJson, parseTspApc } from "@oh-my-pi/pi-tui/native/apc";
import type { TspFrame, TspNode } from "@oh-my-pi/pi-wire";
import type { Script } from "../e2e/mock-llm/server.ts";
import { NativePeer, PtyOmp } from "../helpers/pty.ts";

const SCRIPT: Script = {
	coord: {
		rules: [
			{ when: "New on the board for you", reply: { text: "NATIVE-WAKE-RECEIVED" } },
			{ when: "^user:.*native-swarm-start$", reply: { tools: [{ name: "swarm", args: { action: "add", name: "native-worker", model: "mock/worker-a", brief: "Report a Unicode result." } }] } },
		],
		default: { text: "NATIVE-READY" },
	},
	"worker-a": { rules: [
		{ when: "You are `native-worker`", reply: { tools: [{ name: "post_message", args: { text: "@coordinator [done] NATIVE-RESULT-界 🐙" } }] } },
		{ when: '^tool: \\{"seq":', reply: { tools: [{ name: "swarm_wait", args: {} }] } },
	] },
};

let tty: PtyOmp | undefined;
let releaseWorker: (() => void) | undefined;
afterEach(async () => {
	releaseWorker?.();
	releaseWorker = undefined;
	await tty?.close();
	tty = undefined;
});

function find(node: TspNode | undefined, predicate: (node: TspNode) => boolean): TspNode | undefined {
	if (!node || predicate(node)) return node;
	for (const child of node.c ?? []) {
		const match = find(child, predicate);
		if (match) return match;
	}
}

function role(node: TspNode | undefined, name: string): TspNode | undefined {
	return find(node, n => n.p?.role === `omp.swarm.${name}`);
}

function region(node: TspNode | undefined, id: string): TspNode | undefined {
	return node?.c?.find(n => n.id === id);
}

const editor = (doc: TspNode | undefined) => find(region(doc, "dock"), n => n.k === "editor" && n.p?.sendable === true);
const rows = (doc: TspNode | undefined) => find(doc, n => n.k === "rows");
const includes = (node: TspNode | undefined, text: string) => node !== undefined && JSON.stringify(node).includes(text);

async function submit(p: PtyOmp, text: string): Promise<void> {
	await p.type(text);
	p.write("\r");
}

function coordinatorTurns(p: PtyOmp): number {
	return p.mock.requests("coord").filter(r => r.rule !== -3 && !r.last.startsWith("user: <composer-prediction>")).length;
}

test("native peer replies to hello before DA1 and acknowledges complete chunked UTF-8 frames", () => {
	const peer = new NativePeer({}, 100);
	const hello = encodeTspJson("q", { q: "hello" });
	const frame = encodeTsp("f", JSON.stringify({ sf: "s:9", s: 4, ops: ["界🐙", "quotes;f=x;".repeat(24)] }), undefined, 25);
	const bytes = Buffer.from(`\x1b[6n${hello}\x1b[c${frame}`);
	const replies: string[] = [];
	for (let i = 0; i < bytes.length; i++) peer.read(bytes.subarray(i, i + 1), s => replies.push(s));
	expect(replies).toHaveLength(4);
	expect(replies[0]).toBe("\x1b[1;1R");
	expect(JSON.parse(parseTspApc(replies[1]!)!.body)).toMatchObject({ r: "hello", term: "test", credits: 8 });
	expect(replies[2]).toBe("\x1b[?62;22c");
	expect(JSON.parse(parseTspApc(replies[3]!)!.body)).toEqual({ ev: "ack", sf: "s:9", s: 4 });
});

test("native /swarm owns a screen, focuses its inputs, and returns to semantic inline notices and widget", async () => {
	const late = Promise.withResolvers<void>();
	releaseWorker = late.resolve;
	const worker = SCRIPT["worker-a"]!;
	const p = tty = new PtyOmp({
		...SCRIPT,
		"worker-a": { rules: [
			worker.rules[0]!,
			{ when: '^tool: \\{"seq":', times: 1, reply: { wait: late.promise, tools: [{ name: "post_message", args: { text: "NATIVE-APPEND" } }] } },
			...worker.rules.slice(1),
		] },
	}, 100, 32, {}, { apc: 1024 });
	const { doc: inline } = await p.waitForNative(doc => !!editor(doc), "inline composer ready for input");
	expect(p.native?.opens.find(o => o.id === inline.id)?.mode).toBe("inline");

	await submit(p, "/swarm");
	const empty = await p.waitForNative(doc => !!role(doc, "empty"), "empty swarm page");
	expect(empty.rows).toBe(0);
	expect(p.native?.opens.find(o => o.id === empty.doc.id)).toMatchObject({ role: "omp.swarm", mode: "screen" });
	p.write("q");
	await p.waitForNative(doc => doc?.id === inline.id && !!editor(doc), "returned to the inline composer");

	await submit(p, "native-swarm-start");
	await p.waitForNative(doc => !!editor(doc) && includes(role(region(doc, "main"), "wake"), "NATIVE-RESULT-界 🐙") && !!role(region(doc, "dock"), "widget"), "native wake and status widget");
	const before = coordinatorTurns(p);
	await submit(p, "/swarm-ui start");
	const running = await p.waitForNative(doc => !!editor(doc) && !!role(region(doc, "main"), "webNotice") && /http:\/\/127\.0\.0\.1:\d+\//.test(JSON.stringify(role(region(doc, "dock"), "widget"))), "native web notice and full widget URL");
	const main = region(running.doc, "main");
	const widget = role(region(running.doc, "dock"), "widget");
	const wake = role(main, "wake");
	const notice = role(main, "webNotice");
	expect(coordinatorTurns(p)).toBe(before);
	expect([widget, wake, notice].every(node => !!node && !rows(node))).toBe(true);
	const url = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(JSON.stringify(widget));
	expect(!!url && includes(notice, `ssh -L ${url[1]}:127.0.0.1:${url[1]} <host>`) && includes(notice, "Anyone who can reach the board")).toBe(true);

	await submit(p, "/swarm board");
	const board = await p.waitForNative(doc => !!role(region(doc, "main"), "board"), "populated Board page");
	const sf = board.doc.id;
	expect(p.native?.opens.find(o => o.id === sf)).toMatchObject({ mode: "screen", role: "omp.swarm" });
	expect(board.rows).toBe(0);
	expect(!!role(region(board.doc, "dock"), "dock")).toBe(true);
	const posts = find(board.doc, n => n.k === "list" && n.id.endsWith("/posts"));
	const older = posts?.c?.at(-2);
	const latest = posts?.c?.at(-1);
	if (!posts || !older || !latest) throw new Error("Board did not present the two expected post items");
	p.write("\x1b[A");
	const keyed = await p.waitForNative(doc => !!find(doc, n => n.id === posts.id && n.k === "list" && n.p?.selected === older.id), "key selection moves to the previous post");
	expect(keyed.rows).toBe(0);
	p.nativeEvent({ ev: "select", sf, id: posts.id, item: latest.id });
	await p.waitForNative(doc => !!find(doc, n => n.id === posts.id && n.k === "list" && n.p?.selected === latest.id), "actual list item clicks select the same post");
	p.nativeEvent({ ev: "select", sf, id: posts.id, item: older.id });
	await p.waitForNative(doc => !!find(doc, n => n.id === posts.id && n.k === "list" && n.p?.selected === older.id), "click result matches key result");

	const search = find(board.doc, n => n.k === "button" && n.p?.actions?.click === "swarm.search");
	if (!search) throw new Error("Board did not present the search action");
	p.nativeEvent({ ev: "action", sf, id: search.id, act: "swarm.search" });
	late.resolve();
	const appended = await p.waitForNative(doc => includes(role(doc, "board"), "NATIVE-APPEND"), "append while the Board is open");
	expect(!!find(appended.doc, n => n.id === posts.id && n.k === "list" && n.p?.selected === older.id)).toBe(true);
	expect(!!find(appended.doc, n => n.id === latest.id)).toBe(true);
	expect(appended.rows).toBe(0);
	const field = await p.waitForNative(doc => !!find(region(doc, "main"), n => n.k === "input"), "native search field in the focused page");
	const input = find(region(field.doc, "main"), n => n.k === "input")!;
	p.nativeEvent({ ev: "focus", sf, id: input.id });
	p.nativeEvent({ ev: "edit", sf, id: input.id, from: 0, to: 0, text: "NATIVE-RESULT", cursor: 13, len: 0 });
	await p.waitForNative(doc => !!find(doc, n => n.id === input.id && n.k === "input" && n.p?.text === "NATIVE-RESULT"), "native field edit");
	p.write("\r");
	await p.waitForNative(doc => includes(role(doc, "dock"), "/NATIVE-RESULT") && !find(doc, n => n.k === "input"), "search committed via PTY Enter");
	const debugDoc = await p.debug({ op: "doc" });
	expect(debugDoc).toMatchObject({ ok: true, native: true, doc: { main: expect.any(Array), dock: expect.any(Array), layer: expect.any(Array), focus: "layer:swarm/page" } });

	p.write("/");
	const rawSearch = await p.waitForNative(doc => !!find(region(doc, "main"), n => n.k === "input"), "raw slash opens the search field");
	const rawInput = find(region(rawSearch.doc, "main"), n => n.k === "input")!;
	expect(rawInput.id).not.toBe(input.id);
	await p.type("ja");
	await p.waitForNative(doc => !!find(doc, n => n.id === rawInput.id && n.k === "input" && n.p?.text === "NATIVE-RESULTja"), "raw keys edit the visible search field");
	p.write("\x1b");
	await p.waitForNative(doc => !find(doc, n => n.k === "input") && !includes(role(doc, "dock"), "/NATIVE-RESULTja"), "raw Escape clears search");
	await p.type("/APPEND");
	await p.waitForNative(doc => !!find(doc, n => n.k === "input" && n.p?.text === "APPEND"), "raw keys enter a fresh search");
	p.write("\r");
	await p.waitForNative(doc => !find(doc, n => n.k === "input") && includes(role(doc, "dock"), "/APPEND"), "raw Enter commits search");

	p.nativeEvent({ ev: "features", features: ["edit", "undo", "send"] });
	p.nativeEvent({ ev: "theme", dark: false });
	p.nativeEvent({ ev: "motion", reduce: true });
	p.write("?");
	const help = await p.waitForNative(doc => !!role(region(doc, "layer"), "help"), "help in the owned native layer after feature/theme update");
	expect(help.rows).toBe(0);
	const dismiss = find(help.doc, n => n.k === "button" && n.p?.actions?.click === "swarm.close-help");
	if (!dismiss) throw new Error("Help has no native dismissal action");
	p.nativeEvent({ ev: "action", sf, id: dismiss.id, act: "swarm.close-help" });
	await p.waitForNative(doc => doc?.id === sf && !role(doc, "help"), "help dismissed by its owned action");

	let tabs = find(board.doc, n => n.k === "tabs");
	if (!tabs) throw new Error("Swarm did not present native tabs");
	for (const tab of ["overview", "members", "transcript"] as const) {
		p.nativeEvent({ ev: "activate", sf, id: tabs.id, item: tab });
		const viewed = await p.waitForNative(doc => !!role(region(doc, "main"), tab) && !!find(doc, n => n.k === "tabs" && n.p?.active === tab), tab);
		expect(viewed.doc.id).toBe(sf);
		expect(viewed.rows).toBe(0);
		expect(!!rows(viewed.doc)).toBe(false);
		const next = find(viewed.doc, n => n.k === "tabs")!;
		expect(next.id).not.toBe(tabs.id);
		tabs = next;
	}
	p.write("]");
	await p.waitForNative(doc => includes(role(doc, "transcript"), "coordinator"), "select coordinator transcript");
	p.write("]");
	const history = (doc: TspNode | undefined) => find(role(doc, "transcript"), n => n.id.endsWith("/history"));
	const transcript = await p.waitForNative(doc =>
		includes(role(doc, "transcript"), "swarm~native-worker") && includes(history(doc)?.c?.[0], "swarm_wait"),
		"live worker transcript places the latest wait first");
	expect(transcript.rows).toBe(0);
	const historyNode = history(transcript.doc);
	expect(role(transcript.doc, "transcript")?.c?.[1]?.id).toBe(historyNode?.id);
	expect(historyNode?.c?.slice(1).some(n => includes(n, "NATIVE-APPEND"))).toBe(true);
	const reply = await p.debug({ op: "tsp", n: 64 });
	const frames = (reply.frames as readonly TspFrame[]).filter(f => f.sf === sf);
	expect(frames.length).toBeGreaterThan(8); // crosses the credit window
	expect(frames.some(f => f.ops.some(op => op[0] === "text" && op[1] === input.id && op[3] === "NATIVE-RESULT"))).toBe(true);
	const focus = frames.flatMap(f => f.ops.flatMap(op => op[0] === "focus" ? [op[1]] : []));
	expect(focus.slice(0, 4)).toEqual([input.id, null, rawInput.id, null]);
	expect(frames.some(f => f.ops.some(op => op[0] === "add" && !!rows(op[4])))).toBe(false);
	for (const tab of ["overview", "members", "transcript"] as const) {
		const activated = frames.find(f => f.ops.some(op => op[0] === "add" && op[4].k === "tabs" && op[4].p?.active === tab));
		expect(activated).toBeDefined();
		expect(activated?.ops.some(op => op[0] === "add" && !!role(op[4], tab))).toBe(true);
		expect(activated?.ops.some(op => op[0] === "del" && op[1].includes("/tabs:"))).toBe(true);
		expect(p.native?.lastAck.get(sf) ?? 0).toBeGreaterThanOrEqual(activated?.s ?? Infinity);
	}

	p.write("q");
	await p.waitForNative(doc => doc?.id === inline.id && !!editor(doc), "q restores inline compositor");
	expect(p.native?.closes.some(o => o.id === sf && !o.keep)).toBe(true);
	await submit(p, "/swarm-ui stop");
	await p.waitForNative(doc => {
		const widget = role(region(doc, "dock"), "widget");
		return !!widget && !includes(widget, "http://127.0.0.1:");
	}, "board stop removes the URL without removing the native widget");

	// Host atomic sends displace the draft only into local recall; the swarm screen must not disrupt it.
	const draft = "unsent-native-draft";
	await p.type(draft);
	const pending = await p.waitForNative(doc => !!find(region(doc, "dock"), n => n.k === "editor" && n.p?.text === draft), "draft in inline editor");
	const composer = editor(pending.doc);
	if (!composer) throw new Error("Draft editor cannot accept an atomic slash command");
	p.nativeEvent({ ev: "send", sf: inline.id, id: composer.id, text: "/swarm overview" });
	await p.waitForNative(doc => !!role(doc, "overview"), "open Swarm without submitting the draft");
	p.write("q");
	await p.waitForNative(doc => doc?.id === inline.id && !!editor(doc), "return from the second Swarm screen");
	for (let i = 0; i < 3; i++) {
		const old = editor(p.native?.document());
		const previousText = old?.k === "editor" ? old.p?.text : undefined;
		if (old?.k === "editor" && old.p?.text === draft) break;
		p.write("\x1b[A");
		await p.waitForNative(doc => {
			const next = editor(doc);
			return next?.k === "editor" && next.p?.text !== previousText;
		}, "recall the displaced inline draft");
	}
	await p.waitForNative(doc => !!find(region(doc, "dock"), n => n.k === "editor" && n.p?.text === draft), "unsubmitted draft preserved in local recall");
}, 60_000);

test("a reduced native peer still has a semantic screen and keyboard navigation", async () => {
	const p = tty = new PtyOmp(SCRIPT, 100, 32, {}, { kinds: ["col", "text", "editor", "rows"] });
	await p.waitForNative(doc => !!editor(doc), "reduced native editor");
	await submit(p, "native-swarm-start");
	await p.waitForNative(doc => !!editor(doc) && !!role(doc, "widget"), "reduced native widget");
	await submit(p, "/swarm");
	const overview = await p.waitForNative(doc => !!role(doc, "overview"), "reduced overview");
	expect(overview.rows).toBe(0);
	expect(!!find(overview.doc, n => n.k !== "col" && n.k !== "text")).toBe(false);
	p.write("2");
	await p.waitForNative(doc => !!role(doc, "board"), "reduced Board");
	p.write("/");
	await p.waitForNative(doc => includes(role(doc, "page"), "Search posts:"), "text-only search capture");
	p.write("\x1b");
	await p.waitForNative(doc => !includes(role(doc, "page"), "Search posts:") && !!role(doc, "board"), "text-only search dismissed");
	p.write("q");
	await p.waitForNative(doc => !!editor(doc), "reduced inline compositor restored");
}, 60_000);

test("a reduced peer with buttons can switch tabs and dismiss inline help", async () => {
	const p = tty = new PtyOmp(SCRIPT, 100, 32, {}, { kinds: ["col", "text", "button", "editor", "rows"] });
	await p.waitForNative(doc => !!editor(doc), "reduced native editor");
	await submit(p, "native-swarm-start");
	await p.waitForNative(doc => !!editor(doc) && !!role(doc, "widget"), "reduced native widget");
	await submit(p, "/swarm");
	const action = (doc: TspNode | undefined, name: string) => find(doc, n => n.k === "button" && n.p?.actions?.click === `swarm.${name}`);
	const overview = await p.waitForNative(doc => !!role(doc, "overview") && !!action(doc, "board"), "tab button fallback");
	expect(overview.rows).toBe(0);
	const sf = overview.doc.id;
	const selectBoard = action(overview.doc, "board")!;
	expect(find(overview.doc, n => n.k === "tabs")).toBeUndefined();
	p.nativeEvent({ ev: "action", sf, id: selectBoard.id, act: "swarm.board" });
	const board = await p.waitForNative(doc => includes(role(doc, "board"), "NATIVE-RESULT"), "fallback Board tab clicked and shows worker post");
	expect(board.doc.id).toBe(sf);
	expect(board.rows).toBe(0);
	expect(find(board.doc, n => !["col", "text", "button"].includes(n.k))).toBeUndefined();
	expect(includes(role(board.doc, "header"), "Spend")).toBe(true);

	p.write("?");
	const help = await p.waitForNative(doc => !!role(region(doc, "main"), "help") && !!action(doc, "close-help"), "inline help and dismissal button");
	expect(help.rows).toBe(0);
	expect(role(region(help.doc, "layer"), "help")).toBeUndefined();
	const dismiss = action(help.doc, "close-help")!;
	p.nativeEvent({ ev: "action", sf, id: dismiss.id, act: "swarm.close-help" });
	await p.waitForNative(doc => !role(doc, "help") && !!role(doc, "board"), "inline help dismissed without switching views");
	p.write("q");
	await p.waitForNative(doc => !!editor(doc), "close the reduced native screen");
}, 60_000);

test("compiled TUI coordinator receives a worker mention at its next foreground tool boundary", async () => {
	const worker = Promise.withResolvers<void>();
	releaseWorker = worker.resolve;
	const question = "TUI-MIDTURN-QUESTION-6097";
	const response = "TUI-MIDTURN-ANSWER-4bad";
	const p = tty = new PtyOmp({
		coord: { rules: [
			{ when: "^user:.*tui-midturn-start$", reply: { tools: [{ name: "swarm", args: { action: "add", name: "worker", model: "mock/worker-a", brief: "Ask me the question." } }] } },
			{ when: '"added"', reply: { tools: [{ name: "bash", args: {
				command: "touch coordinator-busy; i=0; while [ ! -f coordinator-release ] && [ \"$i\" -lt 600 ]; do sleep .02; i=$((i+1)); done; test -f coordinator-release && echo COORDINATOR-TOOL-COMPLETE",
				async: false, timeout: 16,
			} }] } },
			{ when: question, reply: { text: response } },
		], default: { text: "Missing mid-turn question." } },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { wait: worker.promise, tools: [{ name: "post_message", args: { text: `@coordinator ${question}` } }] } },
		], default: { text: "Question posted." } },
	}, 100, 32, {}, { apc: 1024 });
	await p.waitForNative(doc => !!editor(doc), "interactive editor ready");
	await submit(p, "tui-midturn-start");
	const work = join(p.root, "work");
	await p.waitFor(() => existsSync(join(work, "coordinator-busy")), 10_000, "coordinator inside bash");
	worker.resolve();
	const board = join(p.swarm, "board.jsonl");
	await p.waitFor(() => existsSync(board) && readFileSync(board, "utf8").includes(question), 10_000, "worker posted while coordinator is busy");
	const mainRequests = () => p.mock.requests("coord").filter(r => r.rule !== -3 && !r.last.startsWith("user: <composer-prediction>"));
	expect(mainRequests().map(r => r.rule)).toEqual([0, 1]);
	writeFileSync(join(work, "coordinator-release"), "");
	await p.waitForNative(doc => includes(region(doc, "main"), response), "coordinator answered the same run's aside");
	expect(mainRequests().map(r => r.rule)).toEqual([0, 1, 2]);
	expect(mainRequests()[2]?.last).toContain(question);
	expect(mainRequests()[2]?.roles).toContain("tool");
}, 40_000);
