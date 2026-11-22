// I7 model/effort switching with the SW-04 corrections (recovery by actual resulting state).

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv } from "../../src/env.ts";
import { stopGate } from "../../src/runtime/gate.ts";
import { applyPreSwarmSwitch } from "../../src/runtime/models.ts";
import { type OpsContext, swarmOp } from "../../src/tools/ops.ts";
import { FakeBinding, fakeCaps, fastTimers, Harness, MODELS, settle, until } from "../helpers/harness.ts";
import type { TurnCtx } from "../helpers/scripted-session.ts";

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => {
	await h?.close();
});

const waits: Record<string, string[]> = {};
function waiter(name: string) {
	waits[name] = [];
	return async (t: TurnCtx) => {
		if (t.input.includes("You are `")) await t.call("post_message", { text: "ready" });
		for (;;) {
			const r = await t.call("swarm_wait", { timeout_seconds: 60 });
			waits[name]?.push(String(r.details.woke));
			if (r.details.woke !== "post" && r.details.woke !== "nudge" && r.details.woke !== "notice") return;
			if (r.details.woke === "post") await t.call("post_message", { text: "@coordinator ack" });
		}
	};
}

async function parked(name: string, model = "mock/worker-a", effort = "low") {
	h.factory.brains.set(name, waiter(name));
	await h.swarm({ action: "add", name, brief: "x", model, effort });
	await until(() => h.member(name).phase === "parked", 2000, `${name} parked`);
}

describe("switch (I7, SW-04)", () => {
	test("effort-only change on a parked worker is immediate and keeps it parked", async () => {
		h = new Harness();
		await parked("w");
		const r = await h.swarm({ action: "model", name: "w", effort: "high" });
		const sw = (r.details.switched as { effort: string; resumed: boolean }[])[0];
		expect(sw?.effort).toBe("high");
		expect(sw?.resumed).toBe(false);
		expect(h.member("w").phase).toBe("parked");
		expect(h.session("w").model?.id).toBe("worker-a");
	});

	test("parked worker: claim switch, abort, switch, exactly one resume carrying a post from meanwhile", async () => {
		h = new Harness();
		await parked("w");
		const original = h.session("w");
		const gen = h.member("w").gen;
		h.factory.switchModes.set("w", "slow");
		const switching = h.swarm({ action: "model", name: "w", model: "mock/worker-b", effort: "high" });
		await until(() => h.member("w").phase === "switching", 1000, "switching");
		const p = await h.post("@w new info");
		expect(p.details.woke).toEqual([]);
		const r = await switching;
		const sw = (r.details.switched as { model: string; effort: string; resumed: boolean }[])[0];
		expect(sw?.model).toBe("mock/worker-b");
		expect(sw?.effort).toBe("high");
		expect(sw?.resumed).toBe(true);
		const s = h.session("w");
		expect(s).toBe(original);
		expect(h.factory.created).toHaveLength(1);
		expect(h.member("w").gen).toBe(gen);
		expect(h.member("w").agentId).toBe(original.agentId);
		await until(() => s.inputs.length === 2, 1000, "one resume");
		expect(s.inputs[1]).toContain("Your model is now mock/worker-b (high)");
		expect(s.inputs[1]).toContain("new info");
		// The parked call returned woke:"switch" (recorded) before the run was aborted (H9).
		expect(s.entries.some(e => e.message?.role === "toolResult" && JSON.stringify(e.message.content).includes('\\"woke\\":\\"switch\\"'))).toBe(true);
	});

	test("kill during a switch wins: no resume, no roster model change", async () => {
		h = new Harness();
		await parked("w");
		h.factory.switchModes.set("w", "slow");
		const switching = h.swarm({ action: "model", name: "w", model: "mock/worker-b" });
		await until(() => h.member("w").phase === "switching", 1000, "switching");
		await h.swarm({ action: "kill", name: "w" });
		const r = await switching;
		expect(r.details.errors).toBeDefined();
		expect(h.member("w").killed).toBe(true);
		await settle(10);
		expect(h.session("w").inputs.length).toBe(1);
	});

	test("an exception after the host switched reads back the actual model and restores a viable phase", async () => {
		h = new Harness();
		await parked("w");
		h.factory.switchModes.set("w", "throw-after");
		const r = await h.swarm({ action: "model", name: "w", model: "mock/worker-b" });
		const err = (r.details.errors as { error: string }[])[0]?.error ?? "";
		expect(err).toContain("is on mock/worker-b");
		const m = h.member("w");
		expect(m.model).toBe("mock/worker-b");
		expect(m.op).toBeUndefined();
		expect(["idle", "starting", "working", "parked"]).toContain(m.phase);
		await until(() => h.session("w").inputs.length === 2, 1000, "resumed with the failure note");
		expect(h.session("w").inputs[1]).toContain("you are on mock/worker-b");
	});

	test("effort switch on a failed idle worker clears the failure and resumes it (resumed: true)", async () => {
		h = new Harness();
		let runs = 0;
		h.factory.brains.set("f", async t => {
			runs++;
			if (runs === 1) t.fail("upstream error");
			await t.call("post_message", { text: "@coordinator recovered" });
		});
		await h.swarm({ action: "add", name: "f", brief: "x", model: "mock/worker-a", effort: "low" });
		await until(() => h.member("f").failure !== null, 1000, "failed");
		const r = await h.swarm({ action: "model", name: "f", effort: "high" });
		expect((r.details.switched as { resumed: boolean }[])[0]?.resumed).toBe(true);
		await until(() => runs === 2, 1000, "resumed");
		expect(h.member("f").failure).toBeNull();
	});

	test("missing credentials leave the member untouched", async () => {
		h = new Harness();
		h.binding.models_ = [...MODELS, { provider: "mock", id: "noauth", reasoning: true }];
		await parked("w");
		const r = await h.swarm({ action: "model", name: "w", model: "mock/noauth" });
		expect(String((r.details.errors as { error: string }[])[0]?.error)).toContain("credentials");
		expect(h.member("w").phase).toBe("parked");
		expect(h.member("w").model).toBe("mock/worker-a");
	});

	test("worker self switch is scheduled and applied at its run boundary", async () => {
		h = new Harness();
		let n = 0;
		h.factory.brains.set("self", async t => {
			n++;
			if (n === 1) {
				const r = await t.call("swarm", { action: "model", model: "mock/worker-b" });
				expect(r.details.scheduled).toBeDefined();
				await t.call("post_message", { text: "@coordinator switching" });
			} else await t.call("post_message", { text: "@coordinator on b" });
		});
		await h.swarm({ action: "add", name: "self", brief: "x" });
		await until(() => n === 2, 2000, "resumed after the boundary switch");
		expect(h.member("self").model).toBe("mock/worker-b");
		expect(h.session("self").inputs[1]).toContain("Your model is now mock/worker-b");
	});

	test("out-of-band model change is read back and reported", async () => {
		h = new Harness();
		await parked("w");
		const s = h.session("w");
		s.model = MODELS[2];
		s.emit({ type: "model_changed" });
		expect(h.member("w").model).toBe("mock/worker-b");
		expect(h.rt.coordinator.notices.some(n => n.kind === "external_change")).toBe(true);
	});

	test("coordinator self switch: interactive at agent_end; effort only if the model switch succeeded", async () => {
		h = new Harness({ mode: "tui" });
		await h.post("x");
		const r = await h.swarm({ action: "model", model: "mock/worker-b", effort: "low" });
		expect(r.details.scheduled).toBeDefined();
		expect(h.binding.currentModel?.id).toBe("coord");
		h.rt.onMainAgentStart();
		h.rt.onMainAgentEnd({});
		await until(() => h.binding.currentModel?.id === "worker-b" && h.binding.effort === "low", 1000, "applied");
		expect(h.binding.effort).toBe("low");
		h.binding.setModelResult = false;
		await h.swarm({ action: "model", model: "mock/worker-a", effort: "medium" });
		h.rt.onMainAgentStart();
		h.rt.onMainAgentEnd({});
		await until(() => h.rt.coordinator.notices.some(n => n.text.includes("failed")), 1000, "failure notice");
		expect(h.binding.effort).toBe("low");
	});

	test("coordinator self switch headless: applied inside the stop-gate, which continues the run without a refusal", async () => {
		h = new Harness();
		await h.post("x");
		await h.swarm({ action: "model", model: "mock/worker-b", effort: "medium" });
		const before = h.rt.gate.refusals;
		const res = await stopGate(h.rt, { signal: new AbortController().signal, lastStopReason: "stop" });
		expect(res?.decision).toBe("block");
		expect(res?.reason).toContain("Your model is now mock/worker-b (medium)");
		// A completed switch is not a refusal: it does not spend the refusal budget (H4).
		expect(h.rt.gate.refusals).toBe(before);
		expect(h.rt.metrics.gate_refusals).toBe(0);
	});

	test("headless switch that does not finish inside the stop fails closed: no turn on the old model (H4)", async () => {
		h = new Harness();
		await h.post("x");
		h.binding.setModelResult = "hang";
		await h.swarm({ action: "model", model: "mock/worker-a", effort: "low" });
		const res = await stopGate(h.rt, { signal: new AbortController().signal, lastStopReason: "stop" });
		expect(res).toBeUndefined();
		expect(h.rt.outcome?.value).toBe("incomplete");
		expect(h.rt.outcome?.reason).toContain("model switch did not finish");
		expect(h.binding.effort).toBe("high");
	});

	test("a coordinator with a scheduled self switch cannot park; a late interactive completion leaves effort alone (H4)", async () => {
		h = new Harness({ mode: "tui" });
		await h.post("x");
		await h.swarm({ action: "model", model: "mock/worker-b", effort: "low" });
		const w = await h.call("swarm_wait", {});
		expect(w.details.woke).toBe("switch");
		expect(h.rt.coordinator.phase).not.toBe("parked");
		const slow = Promise.withResolvers<void>();
		h.binding.setModelDelay = slow.promise;
		h.rt.onMainAgentStart();
		h.rt.onMainAgentEnd({});
		await until(() => h.rt.coordinator.notices.some(n => n.text.includes("still being applied")), 1000, "pending notice");
		// The coordinator works on (old model) while the host is still switching.
		h.rt.onMainAgentStart();
		slow.resolve();
		await until(() => h.rt.coordinator.notices.some(n => n.text.includes("completed late")), 1000, "late notice");
		expect(h.binding.currentModel?.id).toBe("worker-b");
		expect(h.binding.effort).toBe("high"); // never applied mid-turn
	});
});

describe("before any swarm exists (M3)", () => {
	test("the coordinator's own model and effort change without creating a swarm; a refused add creates none either", async () => {
		const root = mkdtempSync(join(tmpdir(), "swarm-pre-"));
		const swarmDir = join(root, "swarm");
		try {
			const binding = new FakeBinding("01a1fc2e-701b-741a-8abd-a6061302517e", "print", root);
			let ensured = 0;
			const ctx: OpsContext = {
				rt: null,
				caller: null,
				ensure: () => {
					ensured++;
					return { error: "would create a swarm" };
				},
				env: { ...readEnv({}), dir: swarmDir },
				binding,
				caps: fakeCaps,
				toolCallId: "t1",
				signal: undefined,
				batch: undefined,
				isWorker: false,
			};
			const effort = await swarmOp(ctx, { action: "model", effort: "low" });
			expect(effort.isError).toBeUndefined();
			expect(binding.effort).toBe("low");
			const sched = await swarmOp(ctx, { action: "model", model: "mock/worker-b", effort: "medium" });
			expect(sched.details.scheduled).toBeDefined();
			expect(binding.pendingSelfSwitch).toEqual({ model: "mock/worker-b", effort: "medium" });
			expect(binding.currentModel?.id).toBe("coord");
			const badAdd = await swarmOp(ctx, { action: "add", name: "x" });
			expect(badAdd.isError).toBe(true);
			const badChannel = await swarmOp(ctx, { action: "add", name: "x", brief: "y", channels: ["nope"] });
			expect(badChannel.isError).toBe(true);
			expect(ensured).toBe(0);
			expect(existsSync(swarmDir)).toBe(false);
			expect(readdirSync(root)).toEqual([]);
			// At the run boundary the binding applies it: model first, effort only after success.
			const res = await applyPreSwarmSwitch(binding, 200);
			expect(res?.state).toBe("ok");
			expect(binding.currentModel?.id).toBe("worker-b");
			expect(binding.effort).toBe("medium");
			expect(binding.pendingSelfSwitch).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a pre-swarm self switch is handed to the runtime when a swarm is created first", async () => {
		h = new Harness({ mode: "tui" });
		await h.rt.shutdown();
		h.binding.pendingSelfSwitch = { model: "mock/worker-b", effort: "low" };
		const rt = h.reopen();
		expect(rt.coordinatorSwitch).toEqual({ model: "mock/worker-b", effort: "low" });
		expect(h.binding.pendingSelfSwitch).toBeUndefined();
	});
});
