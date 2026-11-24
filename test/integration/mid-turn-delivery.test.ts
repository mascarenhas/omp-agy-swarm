import { afterEach, beforeAll, expect, test } from "bun:test";
import { LIMITS } from "../../src/env.ts";
import { stopGate } from "../../src/runtime/gate.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fastTimers, Harness, settle, until } from "../helpers/harness.ts";
import type { ScriptedSession, ToolOut, TurnCtx } from "../helpers/scripted-session.ts";

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => { await h?.close(); });

function latch() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return { entered, release };
}

type Latch = ReturnType<typeof latch>;

async function hold(t: TurnCtx, l: Latch): Promise<void> {
	t.session.tools.set("hold", {
		name: "hold",
		async execute(_id, _p, _update, _ctx, signal) {
			l.entered.resolve();
			await new Promise<void>(resolve => {
				const unblock = () => { signal?.removeEventListener("abort", unblock); resolve(); };
				if (signal?.aborted) return unblock();
				signal?.addEventListener("abort", unblock, { once: true });
				void l.release.promise.then(unblock);
			});
			return { details: {}, content: [] };
		},
	});
	await t.call("hold");
}

const asideContent = (s: ScriptedSession) => s.entries.flatMap(e => {
	const msg = e.message;
	return msg?.role === "custom" && msg.customType === "swarm-wake" ? [String(msg.content)] : [];
});
const sent = (name: string) => h.factory.sent.filter(s => s.name === name).map(s => s.message);
const seqs = (t: ToolOut | undefined) => (t?.details.messages as { seq: number }[] | undefined)?.map(m => m.seq);

async function addWorking(name: string, step: Latch, after?: (t: TurnCtx) => Promise<void>): Promise<void> {
	h.factory.brains.set(name, async t => {
		if (!t.input.includes(`You are \`${name}\``)) {
			await t.call("post_message", { text: "Handled the wake." });
			return;
		}
		await t.call("post_message", { text: "ready" });
		await hold(t, step);
		await after?.(t);
	});
	const res = await h.swarm({ action: "add", name, brief: "Work on your piece.", model: "mock/worker-a" });
	expect(res.isError).toBeUndefined();
	await step.entered.promise;
}

function commit(text: string): number {
	const result = h.rt.commitPost(h.rt.coordinator, text);
	if ("error" in result) throw new Error(result.error);
	return result.msg.seq;
}

test("streaming workers get only addressed posts and notices at the next boundary; read/wait don't repeat them", async () => {
	h = new Harness();
	await h.swarm({ action: "channel", op: "create", channel: "parser" });
	const a = latch();
	const b = latch();
	const read: ToolOut[] = [];
	h.factory.brains.set("group-1", async t => {
		if (!t.input.includes("You are `group-1`")) return;
		await t.call("post_message", { text: "ready-a" });
		await hold(t, a);
		read.push(await t.call("read_board"));
		read.push(await t.call("swarm_wait", { timeout_seconds: 1 }));
		await t.call("post_message", { text: "Handled the wake." });
	});
	const r = await h.swarm({ action: "add", name: "group-1", brief: "Work on the parser.", channels: ["parser"] });
	expect(r.isError).toBeUndefined();
	await a.entered.promise;
	await addWorking("other", b);
	const m = h.member("group-1");
	const floor = m.lastReadSeq;
	const noise = commit("Unaddressed-CHITCHAT");
	await settle();
	expect(h.factory.sent).toEqual([]);
	const group = commit("@group group-prefix-question");
	const everyone = commit("@all broadcast-question");
	const channel = commit("@#parser subscriber-question");
	h.rt.queueNotice(m, "probe", "targeted-system-notice");
	await until(() => sent("group-1").length === 1 && sent("other").length === 1, 1000, "one queued page per member");
	expect(m.lastReadSeq).toBe(floor);
	expect(m.phase).toBe("working");
	expect(asideContent(h.session("group-1"))).toEqual([]);
	expect(sent("group-1")[0]?.content).toContain("group-prefix-question");
	expect(sent("group-1")[0]?.content).toContain("broadcast-question");
	expect(sent("group-1")[0]?.content).toContain("subscriber-question");
	expect(sent("group-1")[0]?.content).toContain("targeted-system-notice");
	expect(sent("group-1")[0]?.content).not.toContain("Unaddressed-CHITCHAT");
	expect(sent("other")[0]?.content).toContain("broadcast-question");
	expect(sent("other")[0]?.content).not.toMatch(/group-prefix-question|subscriber-question|targeted-system-notice|Unaddressed-CHITCHAT/);

	a.release.resolve();
	b.release.resolve();
	await until(() => read.length >= 1, 1000, "read after mid-turn receipt");
	expect(asideContent(h.session("group-1"))).toHaveLength(1);
	expect(seqs(read[0])).toContain(noise);
	for (const mid of [group, everyone, channel]) expect(seqs(read[0])).not.toContain(mid);
	expect(m.lastReadSeq).toBe(channel);
	expect(m.addressedRead).toBeUndefined();
	expect(m.notices).toEqual([]);
	await until(() => m.phase === "parked", 1000, "nothing repeated when waiting");
	const next = commit("@group-1 after it parked");
	await until(() => read.length >= 2, 2000, "tool wake");
	expect(read[1]?.details.woke).toBe("post");
	expect(seqs(read[1])).toEqual([next]);
});

test("batches arriving while a page is pending stay bounded and don't refresh the stuck clock", async () => {
	h = new Harness();
	const steps = [latch(), latch(), latch()];
	await addWorking("worker", steps[0]!, async t => {
		for (const l of steps.slice(1)) await hold(t, l);
	});
	const m = h.member("worker");
	const s = h.session("worker");
	const id = m.runId;
	const last = Date.now() - 900_000;
	let progressAtReceipt: [number, boolean] | undefined;
	s.subscribe(ev => {
		if (!("message" in ev) || typeof ev.message === "string" || ev.message.role !== "custom" || ev.message.customType !== "swarm-wake") return;
		if (ev.type === "message_start") { m.tracker.lastEventAt = last; m.stuckNotified = true; }
		if (ev.type === "message_end") progressAtReceipt = [m.tracker.lastEventAt, m.stuckNotified];
	});
	commit("@worker first-page");
	await until(() => sent("worker").length === 1);
	for (let i = 0; i < LIMITS.wakePage.limit + 1; i++) commit(`@worker bounded-${i}`);
	await settle();
	expect(sent("worker")).toHaveLength(1);
	steps[0]!.release.resolve();
	await steps[1]!.entered.promise;
	await until(() => sent("worker").length === 2);
	expect(progressAtReceipt).toEqual([last, true]);
	expect(asideContent(s)).toHaveLength(1);
	expect(sent("worker")[1]?.content.match(/bounded-\d+/g)).toHaveLength(LIMITS.wakePage.limit);
	expect(sent("worker")[1]?.content).toContain("More addressed posts will follow");
	steps[1]!.release.resolve();
	await steps[2]!.entered.promise;
	await until(() => sent("worker").length === 3);
	expect(asideContent(s)).toHaveLength(2);
	expect(sent("worker")[2]?.content.match(/bounded-\d+/g)).toEqual([`bounded-${LIMITS.wakePage.limit}`]);
	steps[2]!.release.resolve();
	await until(() => m.phase === "idle");
	expect(asideContent(s)).toHaveLength(3);
	expect(m.runId).toBe(id);
	expect(m.stats.nudges).toBe(0);
});

test("a dropped aside is replayed after a real run end and presented only once", async () => {
	h = new Harness();
	const first = latch();
	const second = latch();
	await addWorking("worker", first, t => hold(t, second));
	const m = h.member("worker");
	const floor = m.lastReadSeq;
	const s = h.session("worker");
	h.factory.sendModes.set("worker", ["drop"]);
	const seq = commit("@worker replay-this");
	await until(() => sent("worker").length === 1);
	first.release.resolve();
	await second.entered.promise;
	await settle(20);
	expect(asideContent(s)).toEqual([]);
	expect(sent("worker")).toHaveLength(1);
	expect(m.lastReadSeq).toBe(floor);
	expect(m.addressedRead).toBeUndefined();
	second.release.resolve();
	await until(() => m.lastReadSeq === seq && m.phase === "idle", 2000, "replayed receipt");
	expect(asideContent(s)).toHaveLength(1);
	expect(sent("worker")[0]?.details.delivery_id).not.toBe(sent("worker")[1]?.details.delivery_id);
	expect(h.rt.memberStatus(m).owed).toEqual([]);
});

test("read_board presents non-queued posts while swarm_wait does not park behind an aside", async () => {
	h = new Harness();
	const ready = Promise.withResolvers<void>();
	const go = Promise.withResolvers<void>();
	const results: ToolOut[] = [];
	h.factory.brains.set("worker", async t => {
		await t.call("post_message", { text: "ready" });
		ready.resolve();
		await go.promise;
		results.push(await t.call("read_board"));
	});
	await h.swarm({ action: "add", name: "worker", brief: "Work." });
	await ready.promise;
	const queued = commit("@worker read-collision");
	const readable = commit("unaddressed but immediately readable");
	await until(() => sent("worker").length === 1);
	go.resolve();
	await until(() => results.length === 1);
	expect(seqs(results[0])).toContain(readable);
	expect(seqs(results[0])).not.toContain(queued);
	expect(h.member("worker").lastReadSeq).toBe(readable);
	expect(asideContent(h.session("worker"))[0]).toContain("read-collision");

	const waiting = Promise.withResolvers<void>();
	const arm = Promise.withResolvers<void>();
	const waitResults: ToolOut[] = [];
	h.factory.brains.set("waiter", async t => {
		await t.call("post_message", { text: "ready" });
		waiting.resolve();
		await arm.promise;
		waitResults.push(await t.call("swarm_wait"));
	});
	await h.swarm({ action: "add", name: "waiter", brief: "Work." });
	await waiting.promise;
	commit("@waiter wait-collision");
	await until(() => sent("waiter").length === 1);
	arm.resolve();
	await until(() => waitResults.length === 1);
	expect(waitResults[0]?.details.woke).toBe("interrupted");
	expect(h.session("waiter").waitTransitions).toEqual([]);
	expect(asideContent(h.session("waiter"))[0]).toContain("wait-collision");
});

test("a pre-existing tool delivery wins the slot; later mentions inject only after its receipt", async () => {
	h = new Harness({ mode: "rpc" });
	const c = h.rt.coordinator;
	const initial = h.rt.commitPost(c, "first unread post");
	if ("error" in initial) throw new Error(initial.error);
	const worker = latch();
	await addWorking("worker", worker);
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	const read = h.call("read_board", { limit: 1 });
	expect(c.delivery?.kind).toBe("tool");
	const addressed = h.rt.commitPost(h.member("worker"), "@coordinator new addressed post");
	if ("error" in addressed) throw new Error(addressed.error);
	expect(c.delivery?.kind).toBe("tool");
	expect(h.binding.wakes).toEqual([]);
	await read;
	await until(() => h.binding.wakes.length === 1);
	expect(h.binding.wakes[0]?.content).toContain("new addressed post");
	expect(h.binding.wakes[0]?.content).not.toContain("first unread post");
	expect(c.lastReadSeq).toBe(initial.msg.seq);
	h.rt.onMainMessageEnd({ ...h.binding.wakes[0]!, role: "custom" });
	expect(c.addressedRead?.has(addressed.msg.seq)).toBe(true);
	const rest = await h.call("read_board", {});
	expect((rest.details.messages as { seq: number }[]).map(p => p.seq)).not.toContain(addressed.msg.seq);
	worker.release.resolve();
});

test("coordinator streaming policy is identical in TUI/RPC, but print/JSON keep the stop gate", async () => {
	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		h = new Harness({ mode });
		try {
			const step = latch();
			await addWorking("worker", step);
			const m = h.member("worker");
			const c = h.rt.coordinator;
			h.binding.streaming = true;
			h.rt.onMainAgentStart();
			h.rt.commitPost(m, "not addressed to the coordinator");
			h.rt.commitPost(m, "@coordinator question for main");
			await settle();
			if (h.binding.headless) {
				expect(h.binding.wakes).toEqual([]);
				expect(c.delivery).toBeUndefined();
			} else {
				expect(h.binding.wakes).toHaveLength(1);
				expect(h.binding.wakes[0]?.content).toContain("question for main");
				expect(h.binding.wakes[0]?.content).not.toContain("not addressed to the coordinator");
				expect(c.delivery?.receiptTimer).toBeUndefined();
			}
			step.release.resolve();
		} finally { await h.close(); }
	}
});

test("a busy anything-mode narrator gets only addresses, not its idle wake set", async () => {
	h = new Harness();
	const step = latch();
	h.factory.brains.set("narrator", t => hold(t, step));
	const started = await h.swarm({ action: "add", role: "narrator" });
	expect(started.isError).toBeUndefined();
	await step.entered.promise;
	const prompt = h.session("narrator").opts.appendSystemPrompt;
	expect(prompt).toContain("This role replaces rules 2–6 above.");
	expect(prompt).toContain("Handle them within your role and continue your current work");
	expect(prompt).toContain("Further addressed pages are pushed automatically");
	commit("narrator-visible-only");
	await settle();
	expect(sent("narrator")).toEqual([]);
	commit("@narrator update your notes");
	await until(() => sent("narrator").length === 1);
	expect(sent("narrator")[0]?.content).not.toContain("narrator-visible-only");
	expect(sent("narrator")[0]?.content).toContain("Handle these addressed posts within your role; continue your current work.");
	expect(sent("narrator")[0]?.content).not.toMatch(/reply on the board|post the outcome|swarm_wait/);
	step.release.resolve();
});

test("abandon detaches a worker with a queued aside; kill fences its late receipt", async () => {
	for (const action of ["finish", "kill"] as const) {
		h = new Harness();
		try {
			const step = latch();
			await addWorking("worker", step);
			const s = h.session("worker");
			const m = h.member("worker");
			const floor = m.lastReadSeq;
			commit("@worker queued-before-fence");
			const runs = m.runId;
			await until(() => sent("worker").length === 1);
			const message = sent("worker")[0]!;
			const result = action === "finish"
				? await h.swarm({ action, summary: "Abandoned outstanding work", abandon: true })
				: await h.swarm({ action, name: "worker" });
			expect(result.isError).toBeUndefined();
			s.emit({ type: "message_end", message: { ...message, role: "custom" } });
			expect(m.lastReadSeq).toBe(floor);
			expect(m.addressedRead).toBeUndefined();
			expect(m.phase).toBe(action === "kill" ? "killed" : "stopped");
			expect(s.disposed).toBe(true);
			step.release.resolve();
			expect(asideContent(s)).toEqual([expect.stringContaining("queued-before-fence")]);
			expect(m.runId).toBe(runs);
		} finally { await h.close(); }
	}
});

test("abandon cancels an admitted aside before it can reach the host", async () => {
	h = new Harness();
	await addWorking("worker", latch());
	const m = h.member("worker");
	const seq = commit("@worker abandon before dispatch");
	expect(m.delivery?.status).toBe("admitted");
	const result = await h.swarm({ action: "finish", summary: "Discard the queued assignment", abandon: true });
	expect(result.isError).toBeUndefined();
	expect(m.wakeFloor).toBeGreaterThan(seq);
	expect(sent("worker")).toEqual([]);
	expect(m.delivery).toBeUndefined();
});

test("spend and a pending switch are checked again before transferring an admitted aside", async () => {
	h = new Harness({ env: { maxCostUsd: 10 } });
	const step = latch();
	await addWorking("worker", step);
	const m = h.member("worker");
	const g = m.gen;
	commit("@worker wait-for-model-switch");
	expect(m.delivery?.status).toBe("admitted");
	m.pendingSwitch = { model: "mock/worker-b", effort: "low" };
	await settle();
	expect(sent("worker")).toEqual([]);
	expect(m.delivery).toBeUndefined();
	step.release.resolve();
	await until(() => m.model === "mock/worker-b" && sent("worker").length > 0, 2000, "same worker on new model receives pending post");
	expect(m.gen).toBe(g);
	expect(sent("worker")[0]?.content).toContain("wait-for-model-switch");
	await until(() => m.phase === "idle");
	expect(sent("worker").map(w => w.content)).toEqual([expect.stringContaining("wait-for-model-switch")]);
	const next = latch();
	h.factory.brains.set("worker", t => hold(t, next));
	void h.session("worker").prompt("a normal next turn");
	await next.entered.promise;
	commit("@worker wait-for-spend");
	expect(m.delivery?.status).toBe("admitted");
	h.rt.spendUnknown = "test usage had no price";
	await settle();
	expect(sent("worker")).toHaveLength(1);
	expect(m.delivery).toBeUndefined();
	expect(h.rt.memberStatus(m).owed).toEqual([h.rt.board.head]);
	next.release.resolve();
});

test("sparse receipts survive reopening for workers and the coordinator without consuming chatter", async () => {
	h = new Harness({ mode: "rpc" });
	const first = latch();
	const second = latch();
	await addWorking("worker", first, t => hold(t, second));
	const c = h.rt.coordinator;
	const m = h.member("worker");
	const floor = m.lastReadSeq;
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	const chatter = commit("unaddressed visible history");
	const directed = commit("@worker ack across process restart");
	const main = h.rt.commitPost(m, "@coordinator ack across process restart");
	if ("error" in main) throw new Error(main.error);
	await until(() => sent("worker").length === 1 && h.binding.wakes.length === 1);
	h.rt.onMainMessageEnd({ ...h.binding.wakes[0]!, role: "custom" });
	first.release.resolve();
	await second.entered.promise;
	expect(m.addressedRead?.has(directed)).toBe(true);
	expect(c.addressedRead?.has(main.msg.seq)).toBe(true);
	h.binding.streaming = false;
	await h.rt.shutdown();
	h.reopen();
	const restored = h.member("worker");
	expect(restored.lastReadSeq).toBe(floor);
	expect(restored.addressedRead?.has(directed)).toBe(true);
	expect(h.rt.memberStatus(restored).owed).toEqual([]);
	expect(h.rt.coordinator.addressedRead?.has(main.msg.seq)).toBe(true);
	const read = await h.call("read_board", {});
	const seen = (read.details.messages as { seq: number }[]).map(p => p.seq);
	expect(seen).toContain(chatter);
	expect(seen).not.toContain(main.msg.seq);
	expect(h.rt.coordinator.addressedRead).toBeUndefined();
});

for (const ending of ["error", "aborted", "cost"] as const) {
	test(`a pending worker model switch does not block the next idle wake after ${ending}`, async () => {
		h = new Harness();
		const step = latch();
		await addWorking("worker", step, async t => {
			if (ending === "error") t.fail("provider error in test");
		});
		const m = h.member("worker");
		const s = h.session("worker");
		m.pendingSwitch = { model: "mock/worker-b", effort: "low" };
		if (ending === "aborted") await s.abort();
		else {
			if (ending === "cost") s.costCapRefusal = { message: "cost cap refused the request" };
			step.release.resolve();
		}
		await until(() => m.phase === "idle" && !s.isStreaming);
		if (ending !== "aborted") expect(m.failure?.kind).toBe(ending);
		expect(m.pendingSwitch).toBeDefined();
		const seq = commit("@worker please continue");
		await until(() => !m.pendingSwitch && m.model === "mock/worker-b" && m.lastReadSeq >= seq, 2000, "idle retry then switch");
		expect(sent("worker").filter(w => w.content.includes("please continue"))).toHaveLength(1);
		expect(m.failure).toBeNull();
	});
}

test("an awaiting TUI coordinator keeps its in-flight aside and can receive idle wakes when none is queued", async () => {
	h = new Harness({ mode: "tui" });
	const c = h.rt.coordinator;
	await addWorking("worker", latch());
	const w = h.member("worker");
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	h.rt.commitPost(w, "@coordinator only once");
	await until(() => h.binding.wakes.length === 1);
	const queued = h.binding.wakes[0]!;
	h.binding.streaming = false;
	h.rt.onMainAgentEnd({ willContinue: true, awaitingAsyncWork: true });
	expect(c.phase).toBe("idle");
	expect(c.awaiting).toBe(true);
	await settle(40);
	expect(c.delivery?.id).toBe(String(queued.details.delivery_id));
	expect(h.binding.wakes).toHaveLength(1);
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	h.rt.onMainMessageEnd({ ...queued, role: "custom" });
	expect(c.awaiting).toBe(false);
	expect(h.rt.memberStatus(c).owed).toEqual([]);
	h.binding.streaming = false;
	h.rt.onMainAgentEnd({ willContinue: true, awaitingAsyncWork: true });
	h.rt.commitPost(w, "@coordinator after pause");
	await until(() => h.binding.wakes.length === 2);
	expect(c.delivery?.addressedSeqs).toBeUndefined();
	expect(h.binding.wakes[1]?.content).toContain("after pause");
});

test("an awaiting TUI coordinator applies its self-switch before starting a board wake", async () => {
	h = new Harness({ mode: "tui" });
	await addWorking("worker", latch());
	const c = h.rt.coordinator;
	const slow = Promise.withResolvers<void>();
	h.binding.setModelDelay = slow.promise;
	const modelsAtWake: (string | undefined)[] = [];
	h.binding.onWake = () => { modelsAtWake.push(h.binding.currentModel?.id); };
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	await h.swarm({ action: "model", model: "mock/worker-b", effort: "low" });
	h.binding.streaming = false;
	h.rt.onMainAgentEnd({ willContinue: true, awaitingAsyncWork: true });
	expect(c.awaiting).toBe(true);
	expect(c.phase).toBe("switching");
	h.rt.commitPost(h.member("worker"), "@coordinator wake after switching");
	await settle();
	expect(h.binding.wakes).toEqual([]);
	slow.resolve();
	await until(() => h.binding.wakes.length === 1, 1000, "wake on the switched model");
	expect(c.model).toBe("mock/worker-b");
	expect(c.effort).toBe("low");
	expect(modelsAtWake).toEqual(["worker-b"]);
	expect(h.binding.wakes[0]?.content).toContain("wake after switching");
});

test("a coordinator effort failure records the successful model switch and unblocks pending delivery", async () => {
	h = new Harness({ mode: "tui" });
	await addWorking("worker", latch());
	const c = h.rt.coordinator;
	const slow = Promise.withResolvers<void>();
	h.binding.setModelDelay = slow.promise;
	h.binding.setThinkingLevel = () => { throw new Error("could not apply effort"); };
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	await h.swarm({ action: "model", model: "mock/worker-b", effort: "low" });
	h.rt.commitPost(h.member("worker"), "@coordinator before switch");
	await settle();
	expect(h.binding.wakes).toEqual([]);
	h.binding.streaming = false;
	h.rt.onMainAgentEnd({});
	expect(c.phase).toBe("switching");
	h.rt.commitPost(h.member("worker"), "@coordinator during switch");
	await settle();
	expect(c.phase).toBe("switching");
	expect(h.binding.wakes).toEqual([]);
	slow.resolve();
	await until(() => h.binding.wakes.length === 1);
	expect(c.phase).toBe("starting");
	expect(h.binding.wakes[0]?.content).toContain("could not apply effort");
	expect(h.binding.wakes[0]?.content).toContain("Your model is now mock/worker-b (high), but applying effort low failed");
	expect(h.binding.wakes[0]?.content).not.toContain("Your model switch failed");
	expect(c.model).toBe("mock/worker-b");
	expect(c.effort).toBe("high");
	const saved = JSON.parse(readFileSync(join(h.dir, "members.json"), "utf8"));
	expect(saved.members.coordinator).toMatchObject({ model: "mock/worker-b", effort: "high" });
	expect(h.binding.wakes[0]?.content).toContain("before switch");
	expect(h.binding.wakes[0]?.content).toContain("during switch");
});

test("a runtime opened during a coordinator turn pages around queued asides while history remains readable", async () => {
	h = new Harness({ mode: "rpc" });
	await h.rt.shutdown();
	h.binding.streaming = true;
	h.reopen();
	const c = h.rt.coordinator;
	expect(c.phase).toBe("working");
	expect(c.runId).toBe(1);
	await addWorking("worker", latch());
	const w = h.member("worker");
	for (let i = 0; i < 3; i++) {
		const before = commit(`unaddressed before ${i}`);
		const address = h.rt.commitPost(w, `@coordinator addressed during exercise ${i}`);
		if ("error" in address) throw new Error(address.error);
		const after = commit(`unaddressed after ${i}`);
		await until(() => h.binding.wakes.length === i + 1);
		expect(h.binding.wakes[i]?.content).toContain(`addressed during exercise ${i}`);
		expect(h.binding.wakes[i]?.content).not.toContain(`unaddressed after ${i}`);
		const wake = { ...h.binding.wakes[i]!, role: "custom" } as const;
		const reading = h.call("read_board", {});
		if (i === 2) {
			h.rt.onMainMessageEnd(wake);
			expect(h.rt.memberStatus(c).owed).toEqual([]);
			expect(c.lastReadSeq).toBe(before - 1);
		}
		const read = await reading;
		const seqs = (read.details.messages as { seq: number }[]).map(m => m.seq);
		expect(seqs).toContain(before);
		expect(seqs).toContain(after);
		expect(seqs).not.toContain(address.msg.seq);
		if (i < 2) {
			expect(c.lastReadSeq).toBe(before);
			expect(h.rt.memberStatus(c).owed).toEqual([address.msg.seq]);
			const historical = await h.call("read_board", { since: 0 });
			expect((historical.details.messages as { seq: number }[]).map(m => m.seq)).toContain(address.msg.seq);
			expect(c.lastReadSeq).toBe(before);
			h.rt.onMainMessageEnd(wake);
		}
		expect(c.lastReadSeq).toBe(after);
	}
});

test("headless gate omits a receipt restored from a streaming coordinator", async () => {
	h = new Harness({ mode: "tui" });
	await addWorking("worker", latch());
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	const w = h.member("worker");
	h.rt.commitPost(w, "unaddressed-for-headless-gate");
	const address = h.rt.commitPost(w, "@coordinator already-receipted-by-tui");
	if ("error" in address) throw new Error(address.error);
	await until(() => h.binding.wakes.length === 1);
	h.rt.onMainMessageEnd({ ...h.binding.wakes[0]!, role: "custom" });
	expect(h.rt.coordinator.addressedRead?.has(address.msg.seq)).toBe(true);
	h.binding.streaming = false;
	await h.rt.shutdown();
	h.binding.mode = "print";
	h.reopen();
	const res = await stopGate(h.rt, { signal: new AbortController().signal, lastStopReason: "stop" });
	expect(res?.reason).toContain("unaddressed-for-headless-gate");
	expect(res?.reason).not.toContain("already-receipted-by-tui");
});

test("an aside at the stop boundary prompts another model turn in the same scripted run", async () => {
	h = new Harness();
	const ending = latch();
	const injected = Promise.withResolvers<string>();
	h.factory.brains.set("worker", async t => {
		if (t.input.includes("You are `worker`")) {
			ending.entered.resolve();
			await ending.release.promise;
		} else {
			injected.resolve(t.input);
			await t.call("post_message", { text: "responded within the original run" });
		}
	});
	await h.swarm({ action: "add", name: "worker", brief: "First input." });
	await ending.entered.promise;
	const m = h.member("worker");
	const run = m.runId;
	m.reminders.compacted = "compaction reminder sentinel";
	commit("@worker stop-boundary prompt");
	await until(() => sent("worker").length === 1);
	ending.release.resolve();
	const input = await injected.promise;
	expect(input).toContain("stop-boundary prompt");
	expect(input).toContain("compaction reminder sentinel");
	await until(() => m.phase === "idle");
	expect(m.reminders.compacted).toBeUndefined();
	expect(m.runId).toBe(run);
	expect(h.rt.board.messages.at(-1)?.text).toBe("responded within the original run");
});

test("a failed loop blocks further mid-turn sends even after a host-owned aside resumes the run", async () => {
	h = new Harness();
	const first = latch();
	const resumed = latch();
	const received: string[] = [];
	h.factory.brains.set("worker", async t => {
		received.push(t.input);
		if (t.input.includes("You are `worker`")) {
			first.entered.resolve();
			await first.release.promise;
			t.fail("first loop failed");
		} else if (t.input.includes("already-queued") && !t.input.includes("posted-after-error")) {
			await hold(t, resumed);
			t.fail("continuation failed");
		} else {
			await t.call("post_message", { text: "handled the new post" });
		}
	});
	await h.swarm({ action: "add", name: "worker", brief: "Start working." });
	await first.entered.promise;
	const m = h.member("worker");
	const s = h.session("worker");
	const starts: ("running" | "idle")[] = [];
	s.subscribeRunState(state => starts.push(state));
	const queued = commit("@worker already-queued");
	await until(() => sent("worker").length === 1);
	first.release.resolve();
	await resumed.entered.promise;
	expect(starts).toEqual([]);
	expect(received[1]).toContain("already-queued");
	expect(m.lastReadSeq).toBe(queued);
	expect(m.failure).toBeNull();
	const later = commit("@worker posted-after-error");
	await settle(20);
	expect(sent("worker")).toHaveLength(1);
	expect(m.delivery).toBeUndefined();
	expect(h.rt.memberStatus(m).owed).toEqual([later]);
	resumed.release.resolve();
	await until(() => m.lastReadSeq >= later && m.phase === "idle", 2000, "post delivered by the normal idle wake");
	expect(sent("worker")).toHaveLength(2);
	expect(received[2]).toContain("posted-after-error");
	expect(received[2]).not.toContain("already-queued");
	expect(starts).toEqual(["idle", "running", "idle"]);
	expect(h.rt.coordinator.notices.filter(n => n.kind === "failure").map(n => n.text)).toEqual([expect.stringContaining("continuation failed")]);
});

test("an RPC coordinator fences a failed run through resumed loops and awaiting pauses", async () => {
	h = new Harness({ mode: "rpc" });
	await addWorking("worker", latch());
	const c = h.rt.coordinator;
	const post = (text: string) => {
		const r = h.rt.commitPost(h.member("worker"), `@coordinator ${text}`);
		if ("error" in r) throw new Error(r.error);
		return r.msg.seq;
	};
	const receive = (i: number) => h.rt.onMainMessageEnd({ ...h.binding.wakes[i]!, role: "custom" });
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	post("queued before the error");
	await until(() => h.binding.wakes.length === 1);
	h.rt.onMainMessageEnd({ role: "assistant", stopReason: "error", errorMessage: "provider failed", content: "" });
	h.rt.onMainAutoRetryEnd(false);
	h.binding.streaming = false;
	h.rt.onMainAgentEnd({ willContinue: true });
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	receive(0);
	const pending = post("after the resumed loop started");
	await settle();
	expect(h.binding.wakes).toHaveLength(1);
	expect(c.delivery).toBeUndefined();
	expect(h.rt.memberStatus(c).owed).toEqual([pending]);

	h.binding.streaming = false;
	h.rt.onMainAgentEnd({ willContinue: true, awaitingAsyncWork: true });
	expect(c.awaiting).toBe(true);
	post("after the awaiting pause");
	await settle();
	expect(h.binding.wakes).toHaveLength(1);
	expect(c.delivery).toBeUndefined();

	h.rt.onMainAgentEnd({});
	await until(() => h.binding.wakes.length === 2);
	expect(c.delivery?.addressedSeqs).toBeUndefined();
	expect(h.binding.wakes[1]?.content).toContain("after the resumed loop started");
	expect(h.binding.wakes[1]?.content).toContain("after the awaiting pause");
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	receive(1);
	post("in a new run");
	await until(() => h.binding.wakes.length === 3);
	expect(c.delivery?.addressedSeqs).toEqual([h.rt.board.head]);
	expect(h.binding.wakes[2]?.content).toContain("in a new run");
});

test("the spend ceiling leaves Main's reporting wakes enabled both idle and mid-turn", async () => {
	h = new Harness({ mode: "tui", env: { maxCostUsd: 5 } });
	await addWorking("worker", latch());
	const c = h.rt.coordinator;
	const w = h.member("worker");
	h.binding.streaming = true;
	h.rt.onMainAgentStart();
	h.rt.commitPost(w, "@coordinator report while busy at the ceiling");
	const owed = commit("@worker no new work after the cap");
	expect(c.delivery?.status).toBe("admitted");
	expect(w.delivery?.status).toBe("admitted");
	// Spend changes after admission but before either delivery is dispatched.
	h.rt.recordUsage(c, { role: "assistant", content: "", usage: { totalTokens: 1, cost: { total: 5 } } });
	expect(h.rt.spendExceeded()).toBe(true);
	await until(() => h.binding.wakes.length === 1);
	expect(c.delivery?.addressedSeqs).toHaveLength(1);
	expect(h.binding.wakes[0]?.content).toContain("report while busy at the ceiling");
	expect(h.binding.wakes[0]?.content).toContain("ceiling $5");
	expect(w.delivery).toBeUndefined();
	expect(sent("worker")).toEqual([]);
	expect(h.rt.memberStatus(w).owed).toEqual([owed]);
	h.rt.onMainMessageEnd({ ...h.binding.wakes[0]!, role: "custom" });
	h.rt.commitPost(w, "@coordinator new mid-turn wake after hitting the cap");
	await until(() => h.binding.wakes.length === 2);
	expect(c.delivery?.addressedSeqs).toEqual([h.rt.board.head]);
	expect(h.binding.wakes[1]?.content).toContain("new mid-turn wake after hitting the cap");
	h.rt.onMainMessageEnd({ ...h.binding.wakes[1]!, role: "custom" });
	h.binding.streaming = false;
	h.rt.onMainAgentEnd({});
	h.rt.commitPost(w, "@coordinator report while idle at the ceiling");
	await until(() => h.binding.wakes.length === 3);
	expect(h.rt.spendExceeded()).toBe(true);
	expect(c.delivery?.addressedSeqs).toBeUndefined();
	expect(h.binding.wakes[2]?.content).toContain("report while idle at the ceiling");
});

for (const recovery of ["retry", "clear"] as const) {
	test(`an interactive coordinator can receive mid-turn asides after ${recovery}`, async () => {
		h = new Harness({ mode: "tui" });
		await addWorking("worker", latch());
		const c = h.rt.coordinator;
		h.binding.streaming = true;
		h.rt.onMainAgentStart();
		h.rt.onMainMessageEnd({ role: "assistant", stopReason: "error", errorMessage: "overloaded", content: "" });
		h.binding.streaming = false;
		h.rt.onMainAgentEnd({ willContinue: true, awaitingAsyncWork: recovery === "clear" });
		h.rt.commitPost(h.member("worker"), "@coordinator queued during recovery");
		await settle();
		expect(h.binding.wakes).toEqual([]);
		if (recovery === "clear") h.rt.onSessionClear();
		h.binding.streaming = true;
		h.rt.onMainAgentStart();
		if (recovery === "retry") {
			await settle();
			expect(h.binding.wakes).toEqual([]);
			h.rt.onMainAutoRetryEnd(true);
			h.rt.onMainMessageEnd({ role: "assistant", stopReason: "toolUse", content: [] });
		}
		await until(() => h.binding.wakes.length === 1);
		expect(c.phase).toBe("working");
		const wake = h.binding.wakes[0]!;
		expect(wake.content).toContain("queued during recovery");
		h.rt.onMainMessageEnd({ ...wake, role: "custom" });
		expect(h.rt.memberStatus(c).owed).toEqual([]);
	});
}
