// PTY tests (§12.4): a real omp TUI with the plugin and the scripted mock provider.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RosterFile } from "../../src/board/types.ts";
import type { Script } from "../e2e/mock-llm/server.ts";
import { PtyOmp } from "../helpers/pty.ts";

const EVIL = "evil \u001b]0;PWNED\u0007 and \u001b[2J clear";

function script(delayMs = 0): Script {
	return {
		coord: {
			rules: [
				{ when: "New on the board for you", reply: { text: "WOKE-BY-WORKER" } },
				{ when: "start-swarm", reply: { tools: [{ name: "swarm", args: { action: "add", name: "w", brief: "report", model: "mock/worker-a" } }] } },
				{ when: '"added"', reply: { text: "STARTED" } },
				{ when: "park-now", reply: { tools: [{ name: "swarm_wait", args: {} }] } },
				{ when: "^user: park-web-board$", reply: { tools: [{ name: "swarm_wait", args: { timeout_seconds: 60 } }] } },
				// The interrupting submission follows the interrupted swarm_wait result in the request.
				{ when: "draft\\s*$", whenAny: '"woke":"interrupted"', reply: { text: "INTERRUPTED-OK" } },
				{ when: "my-draft-text", reply: { text: "DRAFT-RECEIVED" } },
				{ when: "^user: web-status$", whenAny: "Read-only\\. Anyone who can reach the board can read it\\.", reply: { text: "BOARD-NOTICE-LEAKED" } },
				{ when: "^user: web-status$", reply: { tools: [{ name: "swarm", args: { action: "status" } }] } },
				{ when: '"open_board"', reply: { text: "STATUS-READ" } },
			],
			default: { text: "OK" },
		},
		"worker-a": {
			rules: [
				{ when: "You are `w`", reply: { delay: delayMs, tools: [{ name: "post_message", args: { text: `@coordinator [done] DONE-w ${EVIL}` } }] } },
				{ when: '^tool: \\{"seq":', reply: { tools: [{ name: "swarm_wait", args: {} }] } },
			],
		},
	};
}

let t: PtyOmp | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function ready(p: PtyOmp): Promise<void> {
	await p.waitFor(text => text.includes("mock/coord") || text.includes("coord"), 20_000, "the TUI");
	await Bun.sleep(300); // let the editor settle before typing (real TUI start-up)
}

async function submit(p: PtyOmp, text: string): Promise<void> {
	await p.type(text);
	p.write("\r");
}

function coordTurnRequests(p: PtyOmp) {
	return p.mock.requests("coord").filter(r => r.rule !== -3 && !r.last.startsWith("user: <composer-prediction>"));
}

async function waitForWebBoard(p: PtyOmp): Promise<string> {
	await p.waitFor(text => text.includes("Swarm web board") && /http:\/\/127\.0\.0\.1:\d+\//.test(text), 10_000, "persistent web board URL");
	const port = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(p.since())![1]!;
	await p.waitFor(text =>
		text.includes(`tailscale serve ${port}`) &&
		text.includes(`ssh -L ${port}:127.0.0.1:${port} <host>`), 10_000, "copyable forwarding commands");
	return port;
}

async function verifyOpenBoard(p: PtyOmp, url: string): Promise<void> {
	const before = p.mock.requests("coord").length;
	p.mark();
	p.write("\x1b[200~web-status\x1b[201~");
	await p.waitFor(text => text.includes("web-status"), 10_000, "status draft reaches the editor");
	p.write("\r");
	await p.waitFor(text => text.includes("STATUS-READ") || text.includes("BOARD-NOTICE-LEAKED"), 15_000, "status tool result");
	expect(p.since()).not.toContain("BOARD-NOTICE-LEAKED");
	expect(p.mock.requests("coord").slice(before).some(r => r.last.includes(`"open_board":${JSON.stringify(url)}`))).toBe(true);
}

describe("omp TUI with the swarm plugin", () => {
	test("persisted Main's Agent Hub focuses the worker's native transcript without agent profiles", async () => {
		const privateResponse = "LENS-PRIVATE-TRANSCRIPT-5d91";
		t = new PtyOmp({
			coord: {
				rules: [
					{ when: "^user:.*focus-worker$", reply: { tools: [{ name: "swarm", args: { action: "add", name: "lens", brief: "Return your observations privately.", model: "mock/worker-a" } }] } },
					{ when: '"added"', reply: { text: "LENS-STARTED" } },
				],
			},
			"worker-a": { rules: [{ when: "You are `lens`", reply: { text: privateResponse } }] },
		}, 128, 36, {}, true);
		const agents = join(t.root, "agent", "agents");
		expect(existsSync(agents)).toBe(false);
		await t.waitFor(text => text.includes("coord"), 20_000, "coordinator editor");
		await submit(t, "focus-worker");
		await t.waitFor(text => text.includes("LENS-STARTED"), 20_000, "swarm add returned to Main");
		expect(existsSync(agents)).toBe(false);
		expect(t.since()).not.toContain(privateResponse);

		t.mark();
		await submit(t, "/clear");
		await t.waitFor(text => text.includes("Context reset") && text.includes("session continues"), 10_000, "in-place clear");

		t.mark();
		await submit(t, "/hub");
		await t.waitFor(text => text.includes("Activity") && text.includes("Agents"), 10_000, "Agent Hub tabs");
		t.mark();
		t.write("1");
		await t.waitFor(text => text.includes("swarm~lens"), 10_000, "live worker in the in-session Agents roster");
		t.mark();
		t.write("\r");
		await t.waitFor(text => text.includes(privateResponse) && text.includes("swarm~lens"), 15_000, "focused worker transcript and status line");
		expect(existsSync(agents)).toBe(false);

		t.mark();
		t.write("\x1b");
		await t.waitFor(text => text.includes("Mock coord"), 5_000, "return to Main");
		await submit(t, "/quit");
		await t.waitFor(() => t?.proc.exitCode !== null, 10_000, "graceful shutdown");
		expect(t.proc.exitCode).toBe(0);
		expect(existsSync(agents)).toBe(false);
	}, 90_000);

	test("resumed symlinked Main lists its live worker in the native Tern Hub", async () => {
		const id = "01a2046a-8e38-7599-87c0-a60158933f7b";
		t = new PtyOmp({
			coord: {
				rules: [
					{ when: "^user:.*start-native-hub$", reply: { tools: [{ name: "swarm", args: { action: "add", name: "lens", brief: "Wait on the board.", model: "mock/worker-a" } }] } },
					{ when: '"added"', reply: { text: "NATIVE-HUB-STARTED" } },
				],
			},
			"worker-a": { rules: [], default: { tools: [{ name: "swarm_wait" }] } },
		}, 128, 36, {}, { id });
		const resumeFile = t.resumeFile!;
		const root = resumeFile.slice(0, -".jsonl".length);
		expect(realpathSync(resumeFile)).not.toBe(resumeFile);
		await t.waitForNative(doc => JSON.stringify(doc ?? "").includes("Seeded resumed Main transcript"), "resumed Main");
		await submit(t, "start-native-hub");
		await t.waitForNative(doc => {
			const text = JSON.stringify(doc ?? "");
			return text.includes("NATIVE-HUB-STARTED") && text.includes('"ref":"swarm~lens"') && text.includes("waiting on board");
		}, "worker parked in the native Tray");
		const roster = JSON.parse(readFileSync(join(root, "swarm", "members.json"), "utf8")) as RosterFile;
		expect(roster.id).toBe(id);
		expect(roster.members.lens?.agent_id).toBe("swarm~lens");
		await submit(t, "/hub");
		await t.waitForNative(doc => JSON.stringify(doc ?? "").includes('"tab":"activity"'), "native Agent Hub Activity tab");
		t.write("1");
		await t.waitForNative(doc => {
			const text = JSON.stringify(doc ?? "");
			return text.includes('"tab":"agents"') && text.includes('"id":"swarm~lens"');
		}, "native Agent Hub Agents roster");
		t.write("\r");
		await t.waitForNative(doc => JSON.stringify(doc ?? "").includes("Message swarm~lens"), "native worker focus");
	}, 60_000);

	test("/swarm with no swarm, then an idle coordinator woken by a worker; widget; fullscreen resize and safe text", async () => {
		t = new PtyOmp(script());
		await ready(t);
		t.mark();
		await submit(t, "/swarm");
		await t.waitFor(text => text.includes("no swarm in this session"), 10_000, "empty overlay");
		t.write("q");
		await t.waitFor((_x, raw) => raw.includes("\x1b[?1049l") || !raw.includes("no swarm"), 5000, "overlay closed");
		expect(t.listeners()).toBe(0);
		t.mark();
		await submit(t, "start-swarm");
		await t.waitFor(text => text.includes("WOKE-BY-WORKER"), 20_000, "coordinator woken by the worker's @coordinator post");
		await t.waitFor(text => /swarm ·.*\/swarm/.test(text), 10_000, "status widget");
		t.mark();
		await submit(t, "/swarm board");
		await t.waitFor(text => text.includes("2 Board") && text.includes("DONE-w"), 10_000, "board view");
		const raw = t.rawSince();
		expect(raw.includes("\x1b[?1049h")).toBe(true);
		expect(raw.includes("\x1b]0;PWNED")).toBe(false);
		expect(raw.includes("clear")).toBe(true);
		t.mark();
		t.resize(40, 12);
		await t.waitFor(text => text.includes("1Ovw") && text.includes("2Brd"), 10_000, "narrow tabs after resize");
		t.mark();
		t.resize(40, 8);
		await t.waitFor(text => text.includes("1Ovw") && text.includes("2Brd"), 10_000, "compact fullscreen after resize");
		t.mark();
		t.resize(20, 8);
		await t.waitFor(text => text.includes("terminal too"), 10_000, "minimum-width guard");
		t.resize(40, 12);
		await t.waitFor(text => text.includes("1Ovw"), 10_000, "fullscreen restored after minimum-width guard");
		t.mark();
		t.write("3");
		await t.waitFor(text => text.includes("w · waiting") || text.includes("w · working"), 5000, "members view");
		t.write("q");
		await t.waitFor((_x, raw2) => raw2.includes("\x1b[?1049l"), 5000, "overlay closed");
		expect(t.listeners()).toBe(0);
	}, 90_000);

	test("keyboard path in the real TUI: search, #seq jump, o, t, Esc, Esc, b, q", async () => {
		t = new PtyOmp(script());
		await ready(t);
		await submit(t, "start-swarm");
		await t.waitFor(text => text.includes("WOKE-BY-WORKER"), 20_000, "swarm running");
		t.mark();
		await submit(t, "/swarm board");
		await t.waitFor(text => text.includes("2 Board"), 10_000, "board");
		for (const k of "/DONE") t.write(k);
		t.write("\r");
		await t.waitFor(text => text.includes("/DONE"), 5000, "search status");
		t.mark();
		for (const k of "#1") t.write(k);
		t.write("\r");
		await t.waitFor(text => text.includes("filters off · b back"), 5000, "jump with filters suspended");
		t.write("o");
		await t.waitFor(text => text.includes("3 Members"), 5000, "members");
		t.write("t");
		await t.waitFor(text => text.includes("start of conversation") || text.includes("older above"), 5000, "transcript");
		t.mark();
		t.write("\x1b");
		await Bun.sleep(150); // a lone ESC must not be read as the start of an escape sequence
		t.write("\x1b");
		await t.waitFor(text => text.includes("b back"), 5000, "back on the board at the jumped post");
		t.mark();
		t.write("b");
		await t.waitFor(text => text.includes("/DONE"), 5000, "filters restored");
		t.write("q");
		await t.waitFor((_x, raw) => raw.includes("\x1b[?1049l"), 5000, "closed");
	}, 90_000);

	test("a draft survives live updates; a submission ends the coordinator's swarm_wait, a draft does not", async () => {
		t = new PtyOmp(script(2500));
		await ready(t);
		await submit(t, "start-swarm");
		await t.waitFor(text => text.includes("STARTED"), 20_000, "started");
		await t.type("my-draft-text");
		await t.waitFor(text => text.includes("WOKE-BY-WORKER"), 20_000, "live update while drafting");
		const before = t.mock.requests("coord").length;
		t.write("\r");
		await t.waitFor(text => text.includes("DRAFT-RECEIVED"), 20_000, "the draft was kept and submitted");
		expect(t.mock.requests("coord").length).toBeGreaterThan(before);
		await submit(t, "park-now");
		await t.waitFor(() => t?.mock.requests("coord").some(r => r.last.includes("park-now")) ?? false, 20_000, "parked");
		await Bun.sleep(500);
		const parkedAt = t.mock.requests("coord").length;
		await t.type("dra");
		await Bun.sleep(800); // an unsent draft must not end the wait (time passes, nothing is sent)
		expect(t.mock.requests("coord").length).toBe(parkedAt);
		await t.type("ft");
		t.write("\r");
		await t.waitFor(text => text.includes("INTERRUPTED-OK"), 20_000, "submission interrupted the wait");
	}, 90_000);

	test("manual web board start, status and stop show the persistent URL and update the widget without a turn", async () => {
		t = new PtyOmp(script());
		await ready(t);
		await submit(t, "start-swarm");
		await t.waitFor(text => text.includes("WOKE-BY-WORKER"), 20_000, "swarm");
		expect(t.listeners()).toBe(0);
		t.mark();
		await submit(t, "/swarm-ui");
		await t.waitFor(text => text.includes("Web board is off"), 10_000, "status");
		expect(t.listeners()).toBe(0);
		t.mark();
		const before = coordTurnRequests(t).length;
		await submit(t, "/swarm-ui start");
		const port = await waitForWebBoard(t);
		await t.waitFor(text => text.includes(`swarm · http://127.0.0.1:${port}/`), 10_000, "widget URL");
		expect(t.listeners()).toBe(1);
		await t.type("/swarm-ui status");
		await t.waitFor(text => text.includes("/swarm-ui status"), 10_000, "status command typed");
		t.mark();
		t.write("\r");
		expect(await waitForWebBoard(t)).toBe(port);
		t.mark();
		await submit(t, "/swarm-ui stop");
		await t.waitFor(text => text.includes("Web board stopped"), 10_000, "stopped");
		await t.waitFor(text => /swarm · ●.*\/swarm/.test(text), 10_000, "widget without the stopped URL");
		expect(t.listeners()).toBe(0);
		await verifyOpenBoard(t, "/swarm");
		// Only the explicitly requested status round trip reached the model.
		expect(coordTurnRequests(t)).toHaveLength(before + 2);
	}, 90_000);

	test("/swarm-ui start shows the URL while the coordinator is parked, then persists it when the turn ends", async () => {
		t = new PtyOmp(script());
		await ready(t);
		await submit(t, "start-swarm");
		await t.waitFor(text => text.includes("WOKE-BY-WORKER"), 20_000, "swarm");
		t.mark();
		await submit(t, "park-web-board");
		// The earlier wake row also says "swarm_wait" and can repaint while we type.
		// The timeout suffix is emitted only by this tool call's renderer.
		await t.waitFor(text => text.includes("swarm_wait ≤60s"), 10_000, "coordinator wait in flight");
		const requests = coordTurnRequests(t);
		expect(requests.at(-1)?.last).toBe("user: park-web-board");
		t.mark();
		await submit(t, "/swarm-ui start");
		await t.waitFor(text => /Web board: http:\/\/127\.0\.0\.1:\d+\//.test(text), 10_000, "immediate URL notification");
		const port = /Web board: http:\/\/127\.0\.0\.1:(\d+)\//.exec(t.since())![1]!;
		await t.waitFor(text => text.includes(`swarm · http://127.0.0.1:${port}/`), 10_000, "live widget URL");
		// Host canary: the context-excluded transcript row currently waits for the run to end.
		expect(t.since(), "OMP now renders context-excluded rows mid-run; the immediate URL toast may be redundant").not.toContain(`tailscale serve ${port}`);
		expect(coordTurnRequests(t)).toEqual(requests);
		expect(t.listeners()).toBe(1);
		t.mark();
		await submit(t, "draft");
		await t.waitFor(text => text.includes("INTERRUPTED-OK"), 10_000, "submission interrupts park");
		expect(await waitForWebBoard(t)).toBe(port);
	}, 90_000);

	test("OMP_SWARM_UI=1 announces the URL when a swarm first attaches", async () => {
		t = new PtyOmp(script(), 80, 24, { OMP_SWARM_UI: "1" });
		await ready(t);
		expect(t.listeners()).toBe(0);
		t.mark();
		await submit(t, "start-swarm");
		const port = await waitForWebBoard(t);
		expect(t.mock.requests("coord").some(r => r.last.includes('"added"') && r.last.includes(`"open_board":"http://127.0.0.1:${port}/"`))).toBe(true);
		await t.waitFor(text => text.includes("WOKE-BY-WORKER"), 20_000, "swarm idle");
		expect(t.listeners()).toBe(1);
		await verifyOpenBoard(t, `http://127.0.0.1:${port}/`);
	}, 90_000);
});
