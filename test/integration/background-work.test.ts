import { afterEach, beforeAll, expect, test } from "bun:test";
import { TIMING } from "../../src/env.ts";
import { decide, stopGate } from "../../src/runtime/gate.ts";
import { SwarmRegistry } from "../../src/runtime/registry.ts";
import { fastTimers, Harness, until } from "../helpers/harness.ts";

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => h?.close());
const held = { jobs: ["bg_test"], agents: [], queued: false } as const;

async function finish(): Promise<void> {
	await h.call("read_board", {});
	const result = await h.swarm({ action: "finish", summary: "Verified." });
	expect(result.details.completion, JSON.stringify(result.details)).toBe("accepted");
	await stopGate(h.rt, { signal: new AbortController().signal, lastStopReason: "stop" });
	expect(h.rt.outcome?.value).toBe("complete");
}

test("an awaiting worker is board-idle, never nudged while awaiting, and a cancellation-only end releases Main's gate", async () => {
	h = new Harness();
	const nextLoop = Promise.withResolvers<void>();
	const initial = Promise.withResolvers<void>();
	h.factory.brains.set("job", async t => {
		t.session.wakeSources = held;
		if (t.session.inputs.length === 1) {
			t.session.emit({ type: "agent_pause", yielded: false, awaiting: false });
			initial.resolve();
			await nextLoop.promise;
		} else await t.call("post_message", { text: "received the directed board wake" });
	});
	await h.swarm({ action: "add", name: "job", brief: "Run background work." });
	await initial.promise;
	const m = h.member("job");
	expect(m.phase).toBe("working");
	nextLoop.resolve();
	await until(() => m.awaiting, 1000, "host paused awaiting work");
	const s = h.session("job");
	expect(m.state).toBe("waiting");
	expect(m.detail).toBe("waiting on background work");
	expect(m.nudgePending).toBe(false);
	expect(m.stats.nudges).toBe(0);
	await h.call("read_board", {});
	expect(decide(h.rt)).toBe("WAIT");
	expect((await h.swarm({ action: "finish", summary: "Not yet" })).details.error).toContain("job is waiting on background work");
	const post = await h.post("@job check this while work runs");
	await until(() => s.inputs.length === 2 && m.awaiting, 1000, "aside ran and worker paused again");
	expect(s.inputs[1]).toContain("check this while work runs");
	expect(m.lastReadSeq).toBe(post.details.seq as number);
	expect(s.wakeSources).toBe(held);
	await h.call("read_board", {});
	const stop = stopGate(h.rt, { signal: new AbortController().signal, lastStopReason: "stop" });
	await until(() => h.rt.gate.waiting, 1000, "gate is waiting");
	s.wakeSources = undefined;
	s.endRun();
	expect(await stop).toBeUndefined();
	expect(m.awaiting).toBe(false);
	expect(m.stats.nudges).toBe(0);
	expect(h.rt.outcome?.value).toBe("quiescent_no_done");
});

for (const queuedAtEntry of [false, true]) {
	test(`swarm_wait returns job only for queued work ${queuedAtEntry ? "at entry" : "on the keep-alive tick"}`, async () => {
		h = new Harness();
		const read = Promise.withResolvers<{ woke: unknown; cursor: number }>();
		h.factory.brains.set("job", async t => {
			t.session.wakeSources = { ...held, queued: queuedAtEntry };
			const result = await t.call("swarm_wait", {});
			read.resolve({ woke: result.details.woke, cursor: h.member("job").lastReadSeq });
			t.session.wakeSources = undefined;
		});
		await h.swarm({ action: "add", name: "job", brief: "Wait for the job." });
		const m = h.member("job");
		if (!queuedAtEntry) {
			await until(() => !!m.waiter, 1000, "running job did not make swarm_wait spin");
			m.tracker.touch(Date.now() - TIMING.stuckMs - 1_000);
			h.session("job").wakeSources = { jobs: [], agents: [], queued: true };
		}
		expect(await read.promise).toEqual({ woke: "job", cursor: m.briefSeq });
		await until(() => m.phase === "idle", 1000, "job-only wake left no resuming phase");
		expect(h.rt.coordinator.notices.some(n => n.kind === "stuck")).toBe(false);
		expect(h.session("job").waitTransitions.map(w => w.waiting)).toEqual(queuedAtEntry ? [] : [true, false]);
	});
}

test("an actively running tool with no events for ten minutes still raises a stuck notice", async () => {
	h = new Harness();
	const toolStarted = Promise.withResolvers<void>();
	const toolFinished = Promise.withResolvers<void>();
	h.factory.brains.set("builder", async t => {
		t.session.emit({ type: "tool_execution_start", toolCallId: "slow", toolName: "bash" });
		toolStarted.resolve();
		await toolFinished.promise;
		t.session.emit({ type: "tool_execution_end", toolCallId: "slow", toolName: "bash" });
	});
	await h.swarm({ action: "add", name: "builder", brief: "Run a blocking tool." });
	await toolStarted.promise;
	const m = h.member("builder");
	expect(m.phase).toBe("working");
	m.tracker.touch(Date.now() - TIMING.stuckMs - 1_000);
	try {
		await until(() => h.rt.coordinator.notices.some(n => n.kind === "stuck" && n.text.includes("builder")), 1000, "stuck tool notice");
	} finally {
		toolFinished.resolve();
	}
});

test("abandon fences an untimed waiter with pending async work and revives without its jobs", async () => {
	h = new Harness();
	const finished = Promise.withResolvers<void>();
	h.factory.brains.set("job", async t => {
		t.session.wakeSources = held;
		await t.call("swarm_wait", {});
		await finished.promise;
		await t.call("post_message", { text: "must never appear" });
	});
	await h.swarm({ action: "add", name: "job", brief: "You own a job." });
	const m = h.member("job");
	const old = h.session("job");
	await until(() => m.phase === "parked", 1000, "untimed waiter");
	const abandon = await h.swarm({ action: "finish", abandon: true, summary: "Cancel outstanding work." });
	expect(abandon.details.abandoned).toMatchObject([{ name: "job", was: expect.stringContaining("session detached") }]);
	expect(m.phase).toBe("stopped");
	expect(old.teardown).toEqual(["dispose", "cancel/reap swarm~job"]);
	finished.resolve();
	await old.waitForIdle();
	expect(h.rt.board.messages.some(msg => msg.text.includes("must never appear"))).toBe(false);
	h.factory.brains.delete("job");
	await h.swarm({ action: "revive", name: "job" });
	await until(() => !!h.session("job").inputs.length && h.session("job") !== old, 1000, "revived wake");
	expect(h.session("job").inputs[0]).toContain("Background jobs from the previous session are not resumed");
});

for (const mode of ["ok", "throw-after"]) {
	test(`a job-result loop overlapping model switch (${mode}) keeps the worker working`, async () => {
		h = new Harness();
		const switching = Promise.withResolvers<void>();
		const processing = Promise.withResolvers<void>();
		h.factory.brains.set("job", async t => {
			if (t.session.inputs.length === 1) t.session.wakeSources = held;
			else {
				await processing.promise;
				await t.call("post_message", { text: "processed the job result" });
			}
		});
		await h.swarm({ action: "add", name: "job", model: "mock/worker-a", brief: "Launch an async job." });
		const m = h.member("job");
		await until(() => m.awaiting);
		const session = h.session("job");
		h.factory.switchGates.set("job", switching.promise);
		h.factory.switchModes.set("job", mode);
		const change = h.swarm({ action: "model", name: "job", model: "mock/worker-b" });
		await until(() => m.phase === "switching");
		session.wakeSources = undefined;
		const resultTurn = session.prompt("Host delivered the native job result.");
		await until(() => session.isStreaming && !m.awaiting);
		switching.resolve();
		const reply = await change;
		if (mode === "ok") expect(reply.details.switched).toMatchObject([{ resumed: true }]);
		else expect(reply.details.errors).toMatchObject([{ error: expect.stringContaining("reconcile failed") }]);
		try {
			expect(m.phase).toBe("working");
			await h.call("read_board", {});
			expect(decide(h.rt)).toBe("WAIT");
			expect((await h.swarm({ action: "finish", summary: "Too early" })).details.error).toContain("job is working");
		} finally {
			processing.resolve();
			await resultTurn;
		}
		await finish();
	});
}

test("successful awaiting pause clears a stale failure and applies a scheduled self-switch before the next loop", async () => {
	h = new Harness();
	const switchRequested = Promise.withResolvers<unknown>();
	const pause = Promise.withResolvers<void>();
	const nextModel = Promise.withResolvers<string | undefined>();
	h.factory.brains.set("job", async t => {
		if (t.session.inputs.length === 1) {
			t.session.wakeSources = held;
			const switched = await t.call("swarm", { action: "model", model: "mock/worker-b" });
			switchRequested.resolve(switched.details.scheduled);
			await pause.promise;
		} else {
			nextModel.resolve(t.session.model?.id);
			await t.call("post_message", { text: "continued" });
		}
	});
	await h.swarm({ action: "add", name: "job", model: "mock/worker-a", brief: "Switch before processing results." });
	expect(await switchRequested.promise).toMatchObject([{ name: "job", note: expect.stringContaining("when this turn ends") }]);
	const m = h.member("job");
	expect(m.pendingSwitch?.model).toBe("mock/worker-b");
	m.failure = { kind: "error", text: "previous loop failed", at: "", at_seq: 0, count: 1 };
	pause.resolve();
	await until(() => h.session("job").inputs.length === 2, 1000, "self-switch resumed the paused worker");
	expect(await nextModel.promise).toBe("worker-b");
	expect(m.failure).toBeNull();
	expect(m.pendingSwitch).toBeUndefined();
	expect(h.session("job").wakeSources).toBe(held);
});

test("completed attach skips print wake; new work reacquires it and a rejected finish does not release it", async () => {
	h = new Harness();
	const first = await h.swarm({ action: "finish", summary: "Initial completion." });
	expect(first.details.completion).toBe("accepted");
	await h.rt.shutdown();
	h.factory.printWake.length = 0;
	const registry = new SwarmRegistry();
	// Use a real attach/drop path; the lease selection is captured by the fake factory.
	const reopened = registry.attach(h.binding, h.deps);
	expect(reopened).toBeDefined();
	h.rt = reopened!;
	expect(h.factory.printWake).toEqual([false]);
	const close = Promise.withResolvers<void>();
	h.factory.brains.set("active", async () => { await close.promise; });
	await h.swarm({ action: "add", name: "active", brief: "Observe new work after reopening." });
	expect(h.factory.printWake.at(-1)).toBe(true);
	const rejected = await h.swarm({ action: "finish", summary: "Unread work" });
	expect(rejected.isError).toBe(true);
	expect(h.factory.printWake.at(-1)).toBe(true);
	await registry.drop(h.binding.sessionId);
	expect(h.factory.printWake.at(-1)).toBe(false);
	close.resolve();
});

test("a day-long standby timer is live and its refusal is actionable; a board wake lets finish succeed", async () => {
	h = new Harness();
	h.factory.brains.set("probe", async t => {
		await t.call("post_message", { text: "standby" });
		await t.call("swarm_wait", { timeout_seconds: 86_400 });
		await t.call("post_message", { text: "timer stopped" });
	});
	await h.swarm({ action: "add", name: "probe", brief: "wait" });
	await until(() => h.member("probe").phase === "parked", 1000);
	await h.call("read_board", {});
	const rejected = await h.swarm({ action: "finish", summary: "done" });
	expect(rejected.details.error).toContain("probe is parked in a timed swarm_wait (wakes in ~24h)");
	expect(rejected.details.error).toContain("@probe end your turn without rearming the timer");
	expect(rejected.details.error).not.toContain("Read unread");
	await h.post("@probe end your turn without rearming the timer");
	await until(() => h.member("probe").phase === "idle", 1000);
	await finish();
});

test("finish distinguishes a current-loop post from a settled turn and does not recommend abandonment", async () => {
	h = new Harness();
	const posted = Promise.withResolvers<void>();
	const settle = Promise.withResolvers<void>();
	h.factory.brains.set("probe", async t => {
		await t.call("post_message", { text: "@coordinator [done]" });
		posted.resolve();
		await settle.promise;
	});
	await h.swarm({ action: "add", name: "probe", brief: "Report." });
	await posted.promise;
	await h.call("read_board", {});
	const rejected = await h.swarm({ action: "finish", summary: "done" });
	expect(rejected.details.error).toBe("Cannot finish: probe posted, but its turn is still open. Call `swarm_wait{}`; when it wakes, retry `finish` without `abandon:true`.");
	settle.resolve();
	await until(() => h.member("probe").phase === "idle", 1000);
	await finish();
});
