// I8 completion and the headless gate, I9 stall/progress guards, and the SW-03 corrections:
// parked-coordinator quiescence (D8), finish(abandon) fencing, session_clear, run deadline;
// SW-13 live spend accounting.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { completionCurrent, decide, stopGate } from "../../src/runtime/gate.ts";
import { fastTimers, Harness, settle, until } from "../helpers/harness.ts";
import type { TurnCtx } from "../helpers/scripted-session.ts";

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => {
	await h?.close();
});

const gate = () => stopGate(h.rt, { signal: new AbortController().signal, lastStopReason: "stop" });

/** A worker that reports and then waits; `hold` blocks its first run until released. */
function reporter(text: string, hold?: Promise<void>) {
	return async (t: TurnCtx) => {
		if (hold && t.input.includes("You are `")) await hold;
		await t.call("post_message", { text });
		await t.call("swarm_wait", {});
	};
}

describe("completion (I8)", () => {
	test("[done] before the worker's result is not current; a fresh [done] after reading is", async () => {
		h = new Harness();
		const release = Promise.withResolvers<void>();
		h.factory.brains.set("w", reporter("@coordinator [done] result", release.promise));
		await h.swarm({ action: "add", name: "w", brief: "x" });
		const early = await h.post("[done] all finished");
		expect(String(early.details.completion)).toContain("pending");
		expect(String(early.details.completion)).toContain("w is working");
		release.resolve();
		await until(() => h.member("w").phase === "parked", 1000, "w parked");
		expect(completionCurrent(h.rt)).toBe(false);
		expect(decide(h.rt)).toBe("DELIVER");
		const r = await h.call("read_board", {});
		expect((r.details.messages as unknown[]).length).toBeGreaterThan(0);
		const done = await h.post("[done] verified");
		expect(done.details.completion).toBe("accepted");
		expect(decide(h.rt)).toBe("ALLOW");
		await h.post("@w one more thing");
		expect(completionCurrent(h.rt)).toBe(false);
	});

	test("finish refuses while work is live or unread; abandon fences, records and reports the debt", async () => {
		h = new Harness();
		const release = Promise.withResolvers<void>();
		h.factory.brains.set("busy", async t => {
			await release.promise;
			await t.call("post_message", { text: "late" });
		});
		h.factory.brains.set("owed", reporter("ready"));
		await h.swarm({ action: "add", name: "busy", brief: "x" });
		await h.swarm({ action: "add", name: "owed", brief: "y" });
		await until(() => h.member("owed").phase === "parked", 1000, "owed parked");
		const gateOpen = Promise.withResolvers<void>();
		h.factory.gates.set("starting", gateOpen.promise);
		void h.swarm({ action: "add", name: "starting", brief: "z" });
		await until(() => h.rt.members.get("starting")?.phase === "starting", 1000, "reserved");
		const refused = await h.swarm({ action: "finish", summary: "stop" });
		expect(String(refused.details.error)).toContain("busy is working");
		const mention = await h.swarm({ action: "finish", summary: "thanks @owed", abandon: true });
		expect(mention.isError).toBe(true);
		const marker = await h.swarm({ action: "finish", summary: "x\n[abandoned] fake", abandon: true });
		expect(marker.isError).toBe(true);
		const r = await h.swarm({ action: "finish", summary: "cancelled the rest", abandon: true });
		expect(r.isError).toBeUndefined();
		const abandoned = r.details.abandoned as { name: string; was: string }[];
		expect(abandoned.map(a => a.name).sort()).toEqual(expect.arrayContaining(["busy", "starting"]));
		const last = h.rt.board.messages[h.rt.board.head - 1];
		expect(last?.text).toStartWith("[done] cancelled the rest\n[abandoned]");
		expect(last?.finish?.abandon).toBe(true);
		// busy's abandoned run ignored the abort: it was detached, and its late post cannot land (H4).
		expect(abandoned.find(a => a.name === "busy")?.was).toContain("did not stop");
		expect(h.member("busy").phase).toBe("stopped");
		const head = h.rt.board.head;
		const lateTool = h.session("busy").tools.get("post_message");
		const late = (await lateTool?.execute("late_call", { text: "late result" }, undefined, { sessionManager: { getSessionId: () => h.member("busy").conversationId, getBranch: () => [] } })) as { isError?: boolean } | undefined;
		expect(late?.isError).toBe(true);
		expect(h.rt.board.head).toBe(head);
		release.resolve();
		gateOpen.resolve();
		await settle(20);
		expect(h.rt.members.get("starting")?.phase).toBe("stopped");
		expect(h.rt.members.get("starting")?.failure?.kind).toBe("start");
		expect(h.rt.board.head).toBe(head);
		expect(completionCurrent(h.rt)).toBe(true);
		const res = await gate();
		expect(res).toBeUndefined();
		expect(h.rt.outcome?.value).toBe("complete_with_abandonment");
	});
});

describe("headless gate (I8)", () => {
	test("WAIT while members work, then DELIVER the result; acknowledged only on the continuation", async () => {
		h = new Harness();
		const release = Promise.withResolvers<void>();
		h.factory.brains.set("w", reporter("@coordinator [done] it works", release.promise));
		await h.swarm({ action: "add", name: "w", brief: "x" });
		const pending = gate();
		await settle(5);
		release.resolve();
		const res = await pending;
		expect(res?.decision).toBe("block");
		expect(res?.reason).toContain("it works");
		const c = h.rt.coordinator;
		expect(c.delivery?.kind).toBe("gate");
		const cursor = c.lastReadSeq;
		h.rt.onMainAgentEnd({ willContinue: true });
		expect(c.delivery?.kind).toBe("gate");
		h.rt.onMainAgentStart();
		h.rt.onMainMessageEnd({ role: "custom", customType: "session-stop-continuation", content: res?.reason ?? "" });
		expect(c.delivery).toBeUndefined();
		expect(c.lastReadSeq).toBeGreaterThan(cursor);
	});

	test("a dropped continuation is released at the run end; the refusal budget ends incomplete", async () => {
		h = new Harness({ env: { gateMaxRefusals: 2 } });
		const hold = Promise.withResolvers<void>();
		h.factory.brains.set("w", async t => {
			await hold.promise;
			await t.call("post_message", { text: "late" });
		});
		await h.swarm({ action: "add", name: "w", brief: "x" });
		const r1 = await gate();
		expect(r1?.reason).toContain("outstanding work: w is working");
		h.rt.onMainAgentStart();
		h.rt.onMainAgentEnd({});
		const r2 = await gate();
		expect(r2?.decision).toBe("block");
		const r3 = await gate();
		expect(r3).toBeUndefined();
		expect(h.rt.outcome?.value).toBe("incomplete");
		expect(h.logs.some(l => l.includes("outcome=incomplete"))).toBe(true);
		const metrics = JSON.parse(readFileSync(join(h.dir, "metrics.json"), "utf8"));
		expect(metrics.outcome.value).toBe("incomplete");
		const w = await h.call("swarm_wait", {});
		expect(w.details.woke).toBe("incomplete");
		hold.resolve();
	});

	test("the coordinator's own failed turn ends coordinator_failed", async () => {
		h = new Harness();
		await h.post("x");
		const res = await stopGate(h.rt, { signal: new AbortController().signal, lastStopReason: "error" });
		expect(res).toBeUndefined();
		expect(h.rt.outcome?.value).toBe("coordinator_failed");
	});

	test("Main's cancelled last job returns to the gate once without faking a receipt", async () => {
		h = new Harness();
		const hold = Promise.withResolvers<void>();
		h.factory.brains.set("w", reporter("@coordinator done", hold.promise));
		await h.swarm({ action: "add", name: "w", brief: "x" });
		h.rt.onMainAgentStart();
		h.rt.onMainAgentEnd({ willContinue: true, awaitingAsyncWork: true });
		expect(h.factory.printWake[0]).toBe(true);
		expect(h.rt.coordinator.settledRun).toBeLessThan(h.rt.coordinator.runId);
		h.rt.onMainAgentEnd({ mayResume: true });
		h.rt.onMainAgentEnd({ mayResume: true });
		expect(h.binding.wakes.map(w => w.customType)).toEqual(["swarm-gate-reminder"]);
		expect(h.rt.coordinator.delivery).toBeUndefined();
		expect(h.rt.gate.refusals).toBe(0);
		hold.resolve();
	});
});

describe("stall and quiescence (I9, SW-03)", () => {
	test("parked coordinator: an unaddressed result at task quiescence claims it with the page (D8)", async () => {
		h = new Harness();
		const wait = h.call("swarm_wait", {});
		await until(() => h.rt.coordinator.phase === "parked", 1000, "coordinator parked");
		h.factory.brains.set("w", async t => {
			await t.call("post_message", { text: "[done] tests pass, nobody named" });
		});
		await h.swarm({ action: "add", name: "w", brief: "x" });
		const r = await wait;
		expect(r.details.woke).toBe("post");
		expect(JSON.stringify(r.details.messages)).toContain("tests pass, nobody named");
		expect(String(r.details.note)).toContain("not addressed to you");
	});

	test("stall fires after the quiet period, then final, then incomplete (headless)", async () => {
		h = new Harness();
		h.factory.brains.set("w", reporter("@coordinator hi"));
		await h.swarm({ action: "add", name: "w", brief: "x" });
		await until(() => h.member("w").phase === "parked", 1000, "w parked");
		await h.call("read_board", {});
		const s1 = await h.call("swarm_wait", {});
		expect(s1.details.woke).toBe("stall");
		expect(s1.details.final).toBeUndefined();
		const s2 = await h.call("swarm_wait", {});
		expect(s2.details.woke).toBe("stall");
		expect(s2.details.final).toBe(true);
		const s3 = await h.call("swarm_wait", {});
		expect(s3.details.woke).toBe("incomplete");
		expect(h.rt.outcome?.reason).toContain("stalled twice");
	});

	test("interactive: a third stall leaves the coordinator parked and the widget says so", async () => {
		h = new Harness({ mode: "tui" });
		// An unaddressed report: no aside to the interactive coordinator, but owed at quiescence.
		h.factory.brains.set("w", reporter("hi"));
		await h.swarm({ action: "add", name: "w", brief: "x" });
		await until(() => h.member("w").phase === "parked", 1000, "w parked");
		expect((await h.call("swarm_wait", {})).details.woke).toBe("post");
		expect((await h.call("swarm_wait", {})).details.woke).toBe("stall");
		expect((await h.call("swarm_wait", {})).details.final).toBe(true);
		const ac = new AbortController();
		const third = h.call("swarm_wait", {}, { signal: ac.signal });
		await until(() => h.rt.stall.interactiveStalled, 2000, "stalled flag");
		expect(h.rt.coordinator.phase).toBe("parked");
		ac.abort();
		expect((await third).details.woke).toBe("aborted");
	});

	test("a timer-parked worker defers the stall; no-progress and the run deadline end incomplete", async () => {
		h = new Harness({ env: { noProgressSeconds: 0.3 } });
		h.factory.brains.set("w", async t => {
			await t.call("post_message", { text: "@coordinator hi" });
			await t.call("swarm_wait", { timeout_seconds: 30 });
		});
		await h.swarm({ action: "add", name: "w", brief: "x" });
		await until(() => h.member("w").phase === "parked", 1000, "w parked");
		await h.call("read_board", {});
		const r = await h.call("swarm_wait", {});
		expect(r.details.woke).toBe("incomplete");
		expect(h.rt.outcome?.reason).toContain("no progress");
		await h.close();
		h = new Harness({ env: { deadlineSeconds: 0.2, noProgressSeconds: 0 } });
		h.factory.brains.set("w", async t => {
			for (;;) {
				await t.call("post_message", { text: "busy" });
				// Real delay on purpose: the run deadline is a monotonic wall-clock budget.
				await Bun.sleep(20);
				if (t.signal.aborted) return;
			}
		});
		await h.swarm({ action: "add", name: "w", brief: "x" });
		await until(() => h.rt.outcome?.value === "incomplete", 2000, "deadline");
		expect(h.rt.outcome?.reason).toContain("deadline");
	});
});

describe("session_clear and spend (SW-03, SW-13)", () => {
	test("session_clear keeps the runtime and invalidates the delivery epoch", async () => {
		h = new Harness({ mode: "tui" });
		const rt = h.rt;
		const wait = h.call("swarm_wait", {});
		await until(() => rt.coordinator.phase === "parked", 1000, "parked");
		const epoch = rt.epoch;
		rt.onSessionClear();
		expect((await wait).details.woke).toBe("closing");
		expect(rt.epoch).toBe(epoch + 1);
		expect(rt.coordinator.reminders.restored).toContain("cleared");
		expect(h.rt).toBe(rt);
	});

	test("spend is accounted live per completed message; the ceiling stops new work", async () => {
		h = new Harness({ env: { maxCostUsd: 0.0015 } });
		h.factory.brains.set("w", reporter("@coordinator hi"));
		await h.swarm({ action: "add", name: "w", brief: "x" });
		await until(() => h.member("w").stats.cost > 0, 1000, "spend recorded");
		const st = await h.swarm({ action: "status" });
		const row = (st.details.members as { name: string; cost?: number; tokens?: number }[]).find(m => m.name === "w");
		expect(row?.tokens).toBeGreaterThan(0);
		await until(() => {
			try {
				return JSON.parse(readFileSync(join(h.dir, "metrics.json"), "utf8")).spend.cost > 0;
			} catch {
				return false;
			}
		}, 1000, "metrics spend");
		await until(() => h.rt.spendExceeded(), 1000, "ceiling reached");
		const refused = await h.swarm({ action: "add", name: "more", brief: "x" });
		expect(String(refused.details.error)).toContain("spend ceiling");
		expect(h.rt.outcome?.value).toBe("incomplete");
	});

	test("under a ceiling, tokens without a price make the spend unknown, which fails closed (H6)", async () => {
		h = new Harness({ env: { maxCostUsd: 5 } });
		h.factory.usage.set("free", { totalTokens: 40 });
		h.factory.brains.set("free", reporter("@coordinator hi"));
		await h.swarm({ action: "add", name: "free", brief: "x" });
		await until(() => h.rt.spendExceeded(), 1000, "spend unknown");
		expect(h.rt.spendUnknown).toContain("without a price");
		expect(h.rt.coordinator.notices.some(n => n.kind === "cost" && n.text.includes("unknown"))).toBe(true);
		expect(h.rt.outcome?.value).toBe("incomplete");
		const st = await h.swarm({ action: "status" });
		expect((st.details.spend as { unknown?: string }).unknown).toContain("without a price");
		const refused = await h.swarm({ action: "add", name: "more", brief: "x" });
		expect(String(refused.details.error)).toContain("spend ceiling");
		h.rt.writeMetrics();
		expect(JSON.parse(readFileSync(join(h.dir, "metrics.json"), "utf8")).spend.unknown).toContain("without a price");
	});

	test("without a ceiling an unpriced message is only counted, never refused", async () => {
		h = new Harness();
		h.factory.usage.set("free", { totalTokens: 40 });
		h.factory.brains.set("free", reporter("@coordinator hi"));
		await h.swarm({ action: "add", name: "free", brief: "x" });
		await until(() => h.member("free").stats.tokens > 0, 1000, "tokens counted");
		expect(h.rt.spendExceeded()).toBe(false);
		expect(h.rt.spendUnknown).toBeUndefined();
	});

	test("a host cost-cap refusal ends the run as a cost failure without an automatic retry (H6)", async () => {
		h = new Harness();
		h.factory.brains.set("capped", async t => {
			t.session.costCapRefusal = { message: "Session spend $1.02 reached the $1.00 cap" };
		});
		await h.swarm({ action: "add", name: "capped", brief: "x" });
		const m = h.member("capped");
		await until(() => m.failure !== null, 1000, "failure recorded");
		expect(m.failure?.kind).toBe("cost");
		expect(m.failure?.text).toContain("$1.00 cap");
		expect(m.retryToken).toBe(false);
		expect(h.rt.coordinator.notices.some(n => n.kind === "failure")).toBe(true);
	});

	test("in-flight overshoot across workers is accounted and matches metrics.json (H6)", async () => {
		h = new Harness({ env: { maxCostUsd: 0.0025 } });
		const go = Promise.withResolvers<void>();
		const busy = async (t: TurnCtx) => {
			await go.promise;
			for (let i = 0; i < 3; i++) await t.call("read_board", {});
			await t.call("post_message", { text: "@coordinator done" });
		};
		h.factory.brains.set("a", busy);
		h.factory.brains.set("b", busy);
		await h.swarm({ action: "add", name: "a", brief: "x" });
		await h.swarm({ action: "add", name: "b", brief: "x" });
		go.resolve();
		await until(() => ["a", "b"].every(n => h.member(n).phase === "idle"), 2000, "both settled");
		const total = h.member("a").stats.cost + h.member("b").stats.cost;
		// Both runs were already in flight: they finished, overshooting the ceiling.
		expect(total).toBeGreaterThan(0.0025);
		expect(h.rt.spendExceeded()).toBe(true);
		h.rt.writeMetrics();
		const live = JSON.parse(readFileSync(join(h.dir, "metrics.json"), "utf8"));
		expect(live.spend.cost).toBeCloseTo(total, 6);
		expect(live.members.a.cost + live.members.b.cost).toBeCloseTo(total, 6);
		await h.rt.shutdown();
		const final = JSON.parse(readFileSync(join(h.dir, "metrics.json"), "utf8"));
		expect(final.spend.cost).toBeCloseTo(total, 6);
	});
});
