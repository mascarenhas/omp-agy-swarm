// Turn-end standby on antigravity-cli (an untimed wait ends the turn so omp can bill it) and the
// split of native scout spend from a member's own requests.

import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelInfo } from "../../src/runtime/ports.ts";
import { fastTimers, Harness, until } from "../helpers/harness.ts";
import type { TurnCtx } from "../helpers/scripted-session.ts";

const AGY: ModelInfo = { provider: "antigravity-cli", id: "gemini-4-neon", reasoning: true };

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => {
	await h?.close();
});

function harness(mode: "tui" | "print" = "print"): Harness {
	h = new Harness({ mode });
	h.binding.models_.push(AGY);
	return h;
}

/** Posts, then makes each wait in `waits`, recording every result; the run ends after the last one. */
function waiter(results: Record<string, unknown>[], inputs: string[], waits: Record<string, unknown>[] = [{}]) {
	return async (t: TurnCtx) => {
		inputs.push(t.input);
		await t.call("post_message", { text: "@coordinator ack" });
		for (const params of waits) {
			const r = await t.call("swarm_wait", params);
			results.push(r.details);
			if (r.details.woke !== "end_turn") return;
		}
	};
}

test("an antigravity-cli worker's untimed wait ends its turn, and a mention starts the next one", async () => {
	harness();
	const results: Record<string, unknown>[] = [];
	const inputs: string[] = [];
	h.factory.brains.set("w", waiter(results, inputs));
	expect((await h.swarm({ action: "add", name: "w", brief: "standby", model: "antigravity-cli/gemini-4-neon" })).isError).toBeUndefined();
	await until(() => results.length === 1 && h.member("w").phase === "idle", 2000, "w idle after end_turn");
	expect(results[0]).toMatchObject({ woke: "end_turn" });
	expect(h.member("w").waiter).toBeUndefined();
	expect(h.session("w").waitTransitions).toEqual([]);
	const contract = h.session("w").opts.appendSystemPrompt;
	expect(contract).toContain("For standby after posting, end your turn");
	expect(contract).not.toContain("use untimed swarm_wait");

	await h.post("@w next step");
	await until(() => inputs.length === 2 && results.length === 2, 2000, "the mention woke w");
	expect(inputs[1]).toContain("next step");
	expect(inputs[1]).toContain("post the outcome, then end your turn.");
	expect(results[1]).toMatchObject({ woke: "end_turn" });
});

test("a second untimed wait in the same turn parks until a post arrives", async () => {
	harness();
	const results: Record<string, unknown>[] = [];
	h.factory.brains.set("w", waiter(results, [], [{}, {}]));
	await h.swarm({ action: "add", name: "w", brief: "standby", model: "antigravity-cli/gemini-4-neon" });
	await until(() => h.member("w").phase === "parked", 2000, "w parked on its second wait");
	expect(results).toEqual([expect.objectContaining({ woke: "end_turn" })]);
	const r = await h.post("@w go");
	// The park returns the post; the brain's next turn (a nudge, since it never reports) may follow at once.
	await until(() => results.length >= 2, 2000, "the post claimed the park");
	expect(results[1]).toMatchObject({ woke: "post" });
	expect((results[1]?.messages as { seq: number }[]).map(m => m.seq)).toContain(Number(r.details.seq));
});

test("timed and any-post waits by antigravity-cli workers keep parking", async () => {
	harness();
	const timed: Record<string, unknown>[] = [];
	const anyPost: Record<string, unknown>[] = [];
	h.factory.brains.set("timed", waiter(timed, [], [{ timeout_seconds: 600 }]));
	h.factory.brains.set("any", waiter(anyPost, [], [{ mentions_only: false }]));
	await h.swarm({ action: "add", name: "timed", brief: "deadline", model: "antigravity-cli/gemini-4-neon" });
	await h.swarm({ action: "add", name: "any", brief: "watch", model: "antigravity-cli/gemini-4-neon" });
	await until(() => h.member("timed").phase === "parked" && h.member("any").phase === "parked", 2000, "both parked");
	expect(timed).toEqual([]);
	expect(anyPost).toEqual([]);
});

test("workers on other providers keep parking on untimed waits", async () => {
	harness();
	const results: Record<string, unknown>[] = [];
	h.factory.brains.set("w", waiter(results, []));
	await h.swarm({ action: "add", name: "w", brief: "standby", model: "mock/worker-a" });
	await until(() => h.member("w").phase === "parked", 2000, "w parked");
	expect(results).toEqual([]);
	expect(h.session("w").opts.appendSystemPrompt).toContain("end your turn or use untimed swarm_wait{}");
});

test("an interactive antigravity-cli coordinator ends its turn once per run; a headless one parks", async () => {
	harness("tui");
	h.binding.currentModel = AGY;
	expect((await h.call("swarm_wait", {})).details).toMatchObject({ woke: "end_turn" });
	expect(h.rt.coordinator.phase).not.toBe("parked");
	// No new main run started, so the next untimed wait parks.
	const ac = new AbortController();
	const second = h.call("swarm_wait", {}, { signal: ac.signal });
	await until(() => h.rt.coordinator.phase === "parked", 2000, "coordinator parked on its second wait");
	ac.abort();
	expect((await second).details.woke).toBe("aborted");
	await h.close();

	harness("print");
	h.binding.currentModel = AGY;
	const headless = new AbortController();
	const parked = h.call("swarm_wait", {}, { signal: headless.signal });
	await until(() => h.rt.coordinator.phase === "parked", 2000, "headless coordinator parked");
	headless.abort();
	expect((await parked).details.woke).toBe("aborted");
});

test("native scout spend stays out of the member's own numbers but counts toward swarm spend", async () => {
	harness();
	h.factory.brains.set("w", async t => {
		await t.call("post_message", { text: "ready" });
		await t.call("swarm_wait", {});
	});
	await h.swarm({ action: "add", name: "w", brief: "park", model: "mock/worker-a" });
	await until(() => h.member("w").phase === "parked", 2000, "w parked");
	const own = { tokens: h.member("w").stats.tokens, cost: h.member("w").stats.cost };
	const spent = h.rt.spendView();
	h.session("w").opts.onOwnedUsage?.({ provider: "anthropic", model: "claude-haiku-5-5", usage: { totalTokens: 1000, cost: { total: 0.25 } } }, "scout");
	expect(h.member("w").stats).toMatchObject({ ...own, scoutTokens: 1000, scoutCost: 0.25 });
	expect(h.rt.spendView().tokens).toBe(spent.tokens + 1000);
	expect(h.rt.spendView().cost).toBeCloseTo(spent.cost + 0.25, 10);

	h.rt.writeMetrics();
	expect(JSON.parse(readFileSync(join(h.dir, "metrics.json"), "utf8")).members.w).toMatchObject({ ...own, scout_tokens: 1000, scout_cost: 0.25 });
	await h.rt.shutdown();
	expect(JSON.parse(readFileSync(join(h.dir, "members.json"), "utf8")).members.w.stats).toMatchObject({ ...own, scout_tokens: 1000, scout_cost: 0.25 });
	h.reopen();
	expect(h.member("w").stats).toMatchObject({ ...own, scoutTokens: 1000, scoutCost: 0.25 });
});
