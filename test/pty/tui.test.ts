// PTY tests (§12.4): a real omp TUI with the plugin and the scripted mock provider.

import { afterEach, describe, expect, test } from "bun:test";
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
				// The interrupting submission follows the interrupted swarm_wait result in the request.
				{ when: "draft\\s*$", whenAny: '"woke":"interrupted"', reply: { text: "INTERRUPTED-OK" } },
				{ when: "my-draft-text", reply: { text: "DRAFT-RECEIVED" } },
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

describe("omp TUI with the swarm plugin", () => {
	test("/swarm with no swarm, then an idle coordinator woken by a worker; widget; overlay at 80×24 → 40×12; escapes sanitized", async () => {
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

	test("no socket listens until /swarm-ui start; stop closes it", async () => {
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
		await submit(t, "/swarm-ui start");
		await t.waitFor(text => text.includes("#token="), 10_000, "link shown to the user");
		expect(t.listeners()).toBe(1);
		t.mark();
		await submit(t, "/swarm-ui stop");
		await t.waitFor(text => text.includes("Web board stopped"), 10_000, "stopped");
		expect(t.listeners()).toBe(0);
	}, 90_000);
});
