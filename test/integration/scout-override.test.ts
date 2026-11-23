import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { permitted } from "../../src/tools/permissions.ts";
import { Harness, until } from "../helpers/harness.ts";

test("only the coordinator sets scout policy; reset and partial replacement preserve generation snapshots across revive", async () => {
	const h = new Harness({ mode: "tui" });
	try {
		const first = await h.swarm({ action: "scout", model: "@smol:low" });
		expect(first.details.scout).toEqual({ model: "mock/worker-b", effort: "low" });
		const conflict = await h.swarm({ action: "scout", model: "@smol:low", effort: "high" });
		expect(conflict.isError).toBe(true);
		expect((await h.swarm({ action: "scout", model: "missing/model" })).isError).toBe(true);
		const denied = Promise.withResolvers<boolean>();
		h.factory.brains.set("old", async t => denied.resolve(!!(await t.call("swarm", { action: "scout", model: "mock/plain" })).isError));
		await h.swarm({ action: "add", name: "old", brief: "Do not modify scout policy." });
		expect(await denied.promise).toBe(true);
		for (const role of ["narrator", "monitor"] as const) expect(permitted("scout", { name: role, role })).not.toBeNull();
		const old = h.session("old");
		const second = await h.swarm({ action: "scout", effort: "high" });
		expect(second.details.scout).toEqual({ model: undefined, effort: "high" });
		expect(old.opts.scoutOverride).toEqual({ model: "mock/worker-b", effort: "low" });
		await h.swarm({ action: "add", name: "fresh", brief: "Check the updated policy." });
		expect(h.session("fresh").opts.scoutOverride).toEqual({ model: undefined, effort: "high" });
		await h.rt.shutdown();
		const file = join(h.dir, "members.json");
		expect(JSON.parse(readFileSync(file, "utf8")).scout).toEqual({ effort: "high" });
		h.reopen();
		expect((await h.swarm({ action: "status" })).details.scout).toEqual({ model: undefined, effort: "high" });
		await h.swarm({ action: "revive", name: "old" });
		await until(() => h.factory.sessions.has("old"), 1000, "worker revive");
		const revived = h.session("old");
		expect(revived.sessionId).toBe(old.sessionId);
		expect(revived.opts.scoutOverride).toEqual({ model: undefined, effort: "high" });
		expect((await h.swarm({ action: "scout" })).details).toMatchObject({ scout: null, scout_default_effort: "high" });
		expect((await h.swarm({ action: "status" })).details).toMatchObject({ scout: null, scout_default_effort: "high" });
		expect(JSON.parse(readFileSync(file, "utf8")).scout).toBeUndefined();
		expect(revived.opts.scoutOverride?.effort).toBe("high");
		await h.swarm({ action: "add", name: "inherited", brief: "Check native policy." });
		expect(h.session("inherited").opts.scoutOverride).toBeUndefined();
	} finally {
		await h.close();
	}
});

test("shutdown checkpoints late direct bills without rewriting the parked phase; reopen keeps spend evidence", async () => {
	const h = new Harness({ mode: "tui", env: { maxCostUsd: 1 } });
	const drain = Promise.withResolvers<void>();
	try {
		h.factory.brains.set("worker", async t => {
			await t.call("post_message", { text: "Standing by." });
			await t.call("swarm_wait", {});
		});
		await h.swarm({ action: "add", name: "worker", brief: "Park." });
		await until(() => h.member("worker").phase === "parked", 1000, "worker parked");
		const session = h.session("worker");
		const before = h.member("worker").stats.cost;
		const postCount = h.rt.board.head;
		h.rt.onMainMessageEnd({ role: "assistant", provider: "mock", model: "coord", usage: { totalTokens: 17, cost: { total: 0.02 } } });
		h.factory.disposeGates.set("worker", drain.promise);
		const shutdown = h.rt.shutdown();
		session.emit({ type: "message_end", message: { role: "assistant", provider: "mock", model: "worker-a", usage: { totalTokens: 23, cost: { total: 0.03 } } } });
		session.emit({ type: "message_end", message: { role: "assistant", provider: "mock", model: "worker-a", usage: { cacheRead: 7 } } });
		drain.resolve();
		await shutdown;
		const saved = JSON.parse(readFileSync(join(h.dir, "members.json"), "utf8"));
		expect(saved.members.worker.wake_mode).toBe("mentions");
		expect(saved.members.worker.stats.cost).toBeCloseTo(before + 0.03, 10);
		expect(h.rt.board.head).toBe(postCount);

		h.reopen();
		expect(h.rt.coordinator.stats).toMatchObject({ tokens: 17, cost: 0.02 });
		expect(h.member("worker").stats.cost).toBeCloseTo(before + 0.03, 10);
		expect(h.member("worker").lastPark?.mode).toBe("mentions");
		expect(h.rt.spendView().unknown).toMatch(/worker.*7 tokens without a price/);
		expect(h.rt.spendExceeded()).toBe(true);
		expect((await h.swarm({ action: "add", name: "denied", brief: "Never start." })).isError).toBe(true);
		await h.rt.shutdown();

		// Turning the ceiling off permits this roster to continue without
		// misrepresenting its historical measurements as completely priced.
		h.deps.env.maxCostUsd = 0;
		h.reopen();
		expect(h.rt.spendExceeded()).toBe(false);
		expect(h.rt.spendView()).toMatchObject({ ceiling: null, unknown: saved.spend_unknown });
		expect((await h.swarm({ action: "add", name: "uncapped", brief: "Run without a ceiling." })).isError).toBeUndefined();
	} finally {
		drain.resolve();
		await h.close();
	}
});
