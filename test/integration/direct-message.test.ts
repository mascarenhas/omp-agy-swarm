// Direct user-to-participant steering (@handle <message>): parsing and runtime delivery
// across working, parked (swarm_wait), idle, and refused states.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { directMessageText, parseDirectMessage } from "../../src/runtime/prompts.ts";
import { fastTimers, Harness, until } from "../helpers/harness.ts";

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => {
	await h?.close();
});

describe("parseDirectMessage", () => {
	test("parses @handle <message> with optional punctuation, multiline body, and case folding", () => {
		expect(parseDirectMessage("@parser focus on edge cases")).toEqual({ handle: "parser", body: "focus on edge cases" });
		expect(parseDirectMessage("@Parser: focus on edge cases")).toEqual({ handle: "parser", body: "focus on edge cases" });
		expect(parseDirectMessage("@worker-1, check\nline 2")).toEqual({ handle: "worker-1", body: "check\nline 2" });
		expect(parseDirectMessage("  @ui_2   check layout  ")).toEqual({ handle: "ui_2", body: "check layout" });
		expect(parseDirectMessage("@parser", true)).toEqual({ handle: "parser", body: "" });
	});

	test("ignores file mentions, empty handles, and non-leading mentions", () => {
		expect(parseDirectMessage("@parser")).toBeUndefined();
		expect(parseDirectMessage("@parser   ")).toBeUndefined();
		expect(parseDirectMessage("@src/index.ts review this")).toBeUndefined();
		expect(parseDirectMessage("@README.md summarize")).toBeUndefined();
		expect(parseDirectMessage("@parser.ts fix bug")).toBeUndefined();
		expect(parseDirectMessage("@@parser hi")).toBeUndefined();
		expect(parseDirectMessage("tell @parser hi")).toBeUndefined();
		expect(parseDirectMessage("plain message")).toBeUndefined();
	});
});

describe("steerMember", () => {
	test("steers a parked worker out of swarm_wait without posting to the board or moving cursors", async () => {
		h = new Harness({ mode: "tui" });
		const waitResults: unknown[] = [];
		const seenInputs: string[] = [];
		h.factory.brains.set("parser", async t => {
			seenInputs.push(t.input);
			if (seenInputs.length === 1) {
				await t.call("post_message", { text: "@coordinator ready" });
				const r = await t.call("swarm_wait", {});
				waitResults.push(r.details.woke);
			}
		});
		await h.swarm({ action: "add", name: "parser", brief: "initial brief" });
		await until(() => h.member("parser").phase === "parked", 2000, "parked");
		const headBefore = h.rt.board.head;
		const cursorBefore = h.member("parser").lastReadSeq;
		const wakesBefore = h.binding.wakes.length;

		const res = await h.rt.steerMember("parser", "focus on recursion edge cases");
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.mode).toBe("steered");

		await until(() => seenInputs.length === 2, 2000, "worker received steering turn");
		expect(waitResults).toEqual(["interrupted"]);
		expect(seenInputs[1]).toBe(directMessageText("focus on recursion edge cases"));
		expect(h.rt.board.head).toBe(headBefore);
		expect(h.member("parser").lastReadSeq).toBe(cursorBefore);
		expect(h.binding.wakes.length).toBe(wakesBefore);
	});

	test("starts a turn on an idle worker and forwards image attachments", async () => {
		h = new Harness({ mode: "tui" });
		const seen: string[] = [];
		h.factory.brains.set("ui", async t => {
			seen.push(t.input);
			if (seen.length === 1) await t.call("post_message", { text: "@coordinator ready" });
		});
		await h.swarm({ action: "add", name: "ui", brief: "start" });
		await until(() => h.member("ui").phase === "idle", 2000, "idle");

		const img = [{ type: "image" as const, data: "AAAA", mimeType: "image/png", sourcePath: "/tmp/shot.png" }];
		const res = await h.rt.steerMember("ui", "check spacing", img);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.mode).toBe("started");

		await until(() => seen.length === 2, 2000, "idle worker ran DM");
		expect(seen[1]).toBe(directMessageText("check spacing"));
		expect(h.session("ui").steers).toHaveLength(1);
		expect(h.session("ui").steers[0]?.text).toBe(directMessageText("check spacing"));
		// Preserve exact attachment object identity and extra metadata for host attachment-source notices.
		expect(h.session("ui").steers[0]?.images?.[0]).toBe(img[0]);
	});

	test("steers a busy working worker mid-turn at the next boundary", async () => {
		h = new Harness({ mode: "tui" });
		const gate = Promise.withResolvers<void>();
		const seen: string[] = [];
		h.factory.brains.set("fixer", async t => {
			seen.push(t.input);
			if (seen.length === 1) {
				await t.call("post_message", { text: "@coordinator started" });
				await gate.promise;
			}
		});
		await h.swarm({ action: "add", name: "fixer", brief: "fix bugs" });
		await until(() => h.member("fixer").phase === "working", 2000, "working");

		const res = await h.rt.steerMember("fixer", "also check null inputs");
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.mode).toBe("steered");

		gate.resolve();
		await until(() => seen.length === 2, 2000, "busy worker handled steer");
		expect(seen[1]).toBe(directMessageText("also check null inputs"));
	});

	test("refuses coordinator, unknown, killed, stopped, switching, and over-budget targets", async () => {
		h = new Harness({ mode: "tui", env: { maxCostUsd: 1 } });
		h.factory.brains.set("a", async () => {});
		h.factory.brains.set("b", async () => {});
		await h.swarm({ action: "add", name: "a", brief: "work" });
		await h.swarm({ action: "add", name: "b", brief: "work" });
		await until(() => h.member("a").phase === "idle" && h.member("b").phase === "idle", 2000, "idle");

		expect(await h.rt.steerMember("coordinator", "hi")).toMatchObject({ ok: false });
		expect(await h.rt.steerMember("unknown", "hi")).toMatchObject({ ok: false });

		await h.swarm({ action: "kill", name: "a" });
		expect(await h.rt.steerMember("a", "hi")).toMatchObject({ ok: false, error: expect.stringContaining("killed") });

		h.member("b").phase = "stopped";
		expect(await h.rt.steerMember("b", "hi")).toMatchObject({ ok: false, error: expect.stringContaining("stopped") });

		h.member("b").phase = "switching";
		expect(await h.rt.steerMember("b", "hi")).toMatchObject({ ok: false, error: expect.stringContaining("switching") });

		h.member("b").phase = "idle";
		h.member("b").stats.cost = 2;
		expect(await h.rt.steerMember("b", "hi")).toMatchObject({ ok: false, error: expect.stringContaining("spend ceiling") });
	});

	test("DM queued right before swarm_wait wakes immediately instead of parking indefinitely", async () => {
		h = new Harness({ mode: "tui" });
		const beforeWait = Promise.withResolvers<void>();
		const waitResults: unknown[] = [];
		const seenInputs: string[] = [];
		h.factory.brains.set("parser", async t => {
			seenInputs.push(t.input);
			if (seenInputs.length === 1) {
				await t.call("post_message", { text: "@coordinator ready" });
				await beforeWait.promise;
				const r = await t.call("swarm_wait", {});
				waitResults.push(r.details.woke);
			}
		});
		await h.swarm({ action: "add", name: "parser", brief: "start" });
		await until(() => h.rt.board.head >= 2 && h.member("parser").phase === "working", 2000, "posted and still working");
		expect(h.member("parser").waiter).toBeUndefined();

		const res = await h.rt.steerMember("parser", "do not park");
		expect(res.ok).toBe(true);
		expect(h.session("parser").hasPendingSteering).toBe(true);

		beforeWait.resolve();
		await until(() => seenInputs.length === 2, 2000, "worker drained DM without parking");
		expect(waitResults).toEqual(["interrupted"]);
		expect(seenInputs[1]).toBe(directMessageText("do not park"));
	});

	test("dropped or rejected DM returns failure instead of a false receipt", async () => {
		h = new Harness({ mode: "tui" });
		h.factory.brains.set("ui", async t => {
			await t.call("post_message", { text: "@coordinator ready" });
		});
		await h.swarm({ action: "add", name: "ui", brief: "start" });
		await until(() => h.member("ui").phase === "idle", 2000, "idle");

		h.factory.sendModes.set("ui", ["drop"]);
		const dropped = await h.rt.steerMember("ui", "will drop");
		expect(dropped).toMatchObject({ ok: false, error: expect.stringContaining("dropped") });
		expect(h.member("ui").pendingSteers).toBe(0);

		h.factory.sendModes.set("ui", ["reject"]);
		const rejected = await h.rt.steerMember("ui", "will reject");
		expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("rejected") });
		expect(h.member("ui").pendingSteers).toBe(0);
	});

	test("pending DM on an idle worker blocks normal finish and is cancelled by finish(abandon: true)", async () => {
		h = new Harness({ mode: "tui" });
		let turns = 0;
		h.factory.brains.set("ui", async t => {
			turns++;
			await t.call("post_message", { text: "@coordinator [done] initial work" });
		});
		await h.swarm({ action: "add", name: "ui", brief: "start" });
		await until(() => h.member("ui").phase === "idle", 2000, "idle");
		await h.call("read_board", {});

		// Hold DM dispatch in flight before the session becomes streaming (like async image normalization).
		const gate = Promise.withResolvers<void>();
		h.factory.steerGates.set("ui", gate.promise);
		const pendingDm = h.rt.steerMember("ui", "one more change");
		await until(() => h.member("ui").pendingSteers === 1, 1000, "pending steer tracked");
		expect(h.session("ui").isStreaming).toBe(false);

		// Normal finish must refuse while the DM is pending.
		const refused = await h.swarm({ action: "finish", summary: "done" });
		expect(refused.isError).toBe(true);

		// Abandoning finish detaches the worker and fails the pending DM cleanly.
		const abandoned = await h.swarm({ action: "finish", summary: "done", abandon: true });
		expect(abandoned.isError).toBeUndefined();
		gate.resolve();
		const dmOutcome = await pendingDm;
		expect(dmOutcome.ok).toBe(false);
		expect(turns).toBe(1);
	});

	test("slow DM confirmation reports pending, keeps receipt tracking, and unblocks finish once delivered", async () => {
		h = new Harness({ mode: "tui" });
		let turns = 0;
		h.factory.brains.set("ui", async t => {
			turns++;
			if (turns === 1) {
				await t.call("post_message", { text: "@coordinator [done] phase 1" });
				return;
			}
			await t.call("post_message", { text: "@coordinator [done] handled delayed DM" });
			await t.call("swarm_wait", {});
		});
		await h.swarm({ action: "add", name: "ui", brief: "start" });
		await until(() => h.member("ui").phase === "idle", 2000, "idle");
		await h.call("read_board", {});

		const gate = Promise.withResolvers<void>();
		h.factory.steerGates.set("ui", gate.promise);
		fastTimers({ steerAckMs: 25 });
		try {
			const pending = await h.rt.steerMember("ui", "delayed follow-up");
			expect(pending.ok).toBe(true);
			if (pending.ok) expect(pending.mode).toBe("pending");
			expect(h.member("ui").pendingSteers).toBe(1);

			// Release dispatch after confirmation timed out; worker runs DM and then parks in untimed swarm_wait.
			gate.resolve();
			await until(() => turns === 2 && h.member("ui").phase === "parked", 2000, "worker handled DM and parked");
			expect(h.member("ui").pendingSteers).toBe(0);
			await until(() => !h.rt.coordinator.delivery, 1000, "aside released");
			await h.call("read_board", {});

			// Normal finish must now succeed even though the idle prompt promise stays open while parked.
			const fin = await h.swarm({ action: "finish", summary: "all done" });
			expect(fin.isError).toBeUndefined();
		} finally {
			fastTimers({ steerAckMs: 5000 });
		}
	});

	test("slow DM that fails after timing out clears pendingSteers and notifies the user", async () => {
		h = new Harness({ mode: "tui" });
		h.factory.brains.set("ui", async t => {
			await t.call("post_message", { text: "@coordinator [done] ready" });
		});
		await h.swarm({ action: "add", name: "ui", brief: "start" });
		await until(() => h.member("ui").phase === "idle", 2000, "idle");

		const gate = Promise.withResolvers<void>();
		h.factory.steerGates.set("ui", gate.promise);
		h.factory.sendModes.set("ui", ["drop"]);
		fastTimers({ steerAckMs: 25 });
		try {
			const pending = await h.rt.steerMember("ui", "will drop late");
			expect(pending.ok).toBe(true);
			if (pending.ok) expect(pending.mode).toBe("pending");
			expect(h.member("ui").pendingSteers).toBe(1);

			gate.resolve();
			await until(() => h.member("ui").pendingSteers === 0, 2000, "pendingSteers cleared after late drop");
			expect(h.binding.notes.some(n => n.includes("Could not deliver DM to @ui"))).toBe(true);
		} finally {
			fastTimers({ steerAckMs: 5000 });
		}
	});

	test("overlapping identical image-only DMs correlate receipts per submission and warn at most once on detach+reject", async () => {
		h = new Harness({ mode: "tui" });
		let turns = 0;
		h.factory.brains.set("ui", async t => {
			turns++;
			await t.call("post_message", { text: `@coordinator [done] turn ${turns}` });
		});
		await h.swarm({ action: "add", name: "ui", brief: "start" });
		await until(() => h.member("ui").phase === "idle", 2000, "idle");

		const gate1 = Promise.withResolvers<void>();
		const gate2 = Promise.withResolvers<void>();
		const img1 = [{ type: "image" as const, data: "AAA1", mimeType: "image/png" }];
		const img2 = [{ type: "image" as const, data: "AAA2", mimeType: "image/png" }];
		h.factory.steerGates.set("ui", gate1.promise);
		fastTimers({ steerAckMs: 25 });
		try {
			// First image-only DM times out as pending while still normalizing.
			const dm1 = await h.rt.steerMember("ui", "", img1);
			expect(dm1.ok).toBe(true);
			if (dm1.ok) expect(dm1.mode).toBe("pending");

			// Second identical-text image-only DM is queued behind gate2 and will drop.
			fastTimers({ steerAckMs: 5000 });
			h.factory.steerGates.set("ui", gate2.promise);
			h.factory.sendModes.set("ui", ["drop"]);
			const dm2Promise = h.rt.steerMember("ui", "", img2);
			await until(() => h.member("ui").pendingSteers === 2, 1000, "two pending steers");

			// Releasing gate1 delivers DM1; its identical user receipt must NOT confirm DM2.
			gate1.resolve();
			await until(() => turns === 2 && h.member("ui").pendingSteers === 1, 2000, "DM1 confirmed while DM2 remains pending");
			expect(h.member("ui").pendingSteers).toBe(1);

			// Releasing gate2 drops DM2 cleanly with failure.
			gate2.resolve();
			const dm2 = await dm2Promise;
			expect(dm2).toMatchObject({ ok: false, error: expect.stringContaining("dropped") });
			expect(h.member("ui").pendingSteers).toBe(0);

			// Detaching + late rejection after timeout notifies at most once.
			const gate3 = Promise.withResolvers<void>();
			h.factory.steerGates.set("ui", gate3.promise);
			h.factory.sendModes.set("ui", ["reject"]);
			const notesBefore = h.binding.notes.length;
			fastTimers({ steerAckMs: 25 });
			const dm3 = await h.rt.steerMember("ui", "will detach and reject");
			expect(dm3.ok).toBe(true);
			if (dm3.ok) expect(dm3.mode).toBe("pending");
			await h.swarm({ action: "kill", name: "ui" });
			gate3.resolve();
			await until(() => h.member("ui").killed, 1000, "killed");
			const dmWarnings = h.binding.notes.slice(notesBefore).filter(n => n.includes("@ui"));
			expect(dmWarnings).toHaveLength(1);
		} finally {
			fastTimers({ steerAckMs: 5000 });
		}
	});
});
