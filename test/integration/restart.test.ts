// I10 restart and revival (with the SW-09 authorization boundary), I11 kill fence and shutdown,
// and the SW-06 rule that a worktree is retained when its worker did not finish stopping.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SwarmRuntime } from "../../src/runtime/runtime.ts";
import { NOT_A_MEMBER } from "../../src/tools/ops.ts";
import { fastTimers, Harness, MODELS, settle, until } from "../helpers/harness.ts";
import type { TurnCtx } from "../helpers/scripted-session.ts";

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => {
	await h?.close();
});

function waitingWorker(inputs: string[]) {
	return async (t: TurnCtx) => {
		inputs.push(t.input);
		await t.call("post_message", { text: "@coordinator ok" });
		await t.call("swarm_wait", {});
	};
}

describe("restart and revival (I10, SW-09)", () => {
	test("load → stopped; a post naming a stopped member does not start it; revive delivers the owed post once", async () => {
		h = new Harness();
		const inputs: string[] = [];
		h.factory.brains.set("lexer", waitingWorker(inputs));
		await h.swarm({ action: "add", name: "lexer", brief: "x" });
		await until(() => h.member("lexer").phase === "parked", 1000, "parked");
		const conv = h.member("lexer").conversationId;
		await h.rt.shutdown();
		const rt = h.reopen();
		const m = rt.members.get("lexer");
		expect(m?.phase).toBe("stopped");
		expect(m?.lastPark?.mode).toBe("mentions");
		expect(rt.coordinator.reminders.restored).toContain("1 members stopped");
		const p = await h.post("@lexer please continue");
		expect(p.details.woke).toEqual([]);
		expect(p.details.stopped).toEqual(["lexer"]);
		expect(String(p.details.hint)).toContain('swarm{action:"revive"');
		expect(rt.coordinator.notices.some(n => n.kind === "revive_needed")).toBe(true);
		await settle(10);
		expect(h.factory.sessions.has("lexer")).toBe(false);
		const st = await h.swarm({ action: "status" });
		expect((st.details.members as { name: string; owed: number[] }[])[0]?.owed).toEqual([Number(p.details.seq)]);
		const r = await h.swarm({ action: "revive" });
		expect(r.details.reviving).toEqual(["lexer"]);
		const again = await h.swarm({ action: "revive", name: "lexer" });
		expect(String((again.details.skipped as { reason: string }[])[0]?.reason)).toMatch(/reviving|not stopped/);
		await until(() => (h.factory.sessions.get("lexer")?.inputs.length ?? 0) === 1, 1000, "revived and woken");
		const s = h.session("lexer");
		expect(s.sessionId).toBe(conv);
		expect(s.opts.mode.kind).toBe("revive");
		expect(s.inputs[0]).toContain("You were stopped by a restart");
		expect(s.inputs[0]).toContain("please continue");
		await until(() => h.member("lexer").lastReadSeq >= Number(p.details.seq), 1000, "cursor");
	});

	test("failure kinds: lost (never revived again), workspace_missing, model_unavailable repaired by model", async () => {
		h = new Harness();
		h.factory.brains.set("a", waitingWorker([]));
		h.factory.brains.set("b", waitingWorker([]));
		h.factory.brains.set("c", waitingWorker([]));
		await h.swarm({ action: "add", name: "a", brief: "x" });
		await h.swarm({ action: "add", name: "b", brief: "x" });
		await h.swarm({ action: "add", name: "c", brief: "x", model: "mock/worker-b" });
		await until(() => ["a", "b", "c"].every(n => h.member(n).phase === "parked"), 2000, "parked");
		await h.rt.shutdown();
		const roster = JSON.parse(readFileSync(join(h.dir, "members.json"), "utf8"));
		roster.members.b.workspace.path = "/nonexistent/swarm-test";
		writeFileSync(join(h.dir, "members.json"), JSON.stringify(roster));
		h.binding.models_ = MODELS.filter(m => m.id !== "worker-b");
		h.factory.failCreate.set("a", "ENOENT: no such file or directory");
		const rt = h.reopen();
		await h.swarm({ action: "revive", name: "a" });
		await h.swarm({ action: "revive", name: "b" });
		await h.swarm({ action: "revive", name: "c" });
		await until(() => ["a", "b", "c"].every(n => rt.members.get(n)?.failure), 1000, "failures recorded");
		expect(rt.members.get("a")?.failure?.kind).toBe("lost");
		expect(rt.members.get("b")?.failure?.kind).toBe("workspace_missing");
		expect(rt.members.get("c")?.failure?.kind).toBe("model_unavailable");
		const lost = await h.swarm({ action: "revive", name: "a" });
		expect(String((lost.details.skipped as { reason: string }[])[0]?.reason)).toContain("lost");
		expect(rt.coordinator.notices.filter(n => n.kind === "revive_failed").length).toBe(3);
		await h.swarm({ action: "model", name: "c", model: "mock/worker-a" });
		expect(rt.members.get("c")?.failure).toBeNull();
		await h.swarm({ action: "revive", name: "c" });
		await until(() => rt.members.get("c")?.phase !== "stopped" && rt.members.get("c")?.phase !== "starting", 1000, "c revived");
		expect(h.session("c").model?.id).toBe("worker-a");
	});

	test("kill during revive disposes the late session", async () => {
		h = new Harness();
		h.factory.brains.set("r", waitingWorker([]));
		await h.swarm({ action: "add", name: "r", brief: "x" });
		await until(() => h.member("r").phase === "parked", 1000, "parked");
		await h.rt.shutdown();
		h.reopen();
		const gate = Promise.withResolvers<void>();
		h.factory.gates.set("r", gate.promise);
		await h.swarm({ action: "revive", name: "r" });
		const kill = h.swarm({ action: "kill", name: "r" });
		gate.resolve();
		await kill;
		await settle(10);
		const late = h.factory.all.filter(s => s.name === "r").at(-1);
		expect(late?.disposed).toBe(true);
	});

	test("an unpresented brief at the restart is replayed by the revival, formatted exactly once (H3)", async () => {
		h = new Harness();
		h.factory.sendModes.set("nb-1", ["drop"]);
		h.factory.brains.set("nb-1", waitingWorker([]));
		await h.swarm({ action: "add", name: "nb", brief: "the real brief", tasks: ["slice one"] });
		await settle(5);
		const first = h.session("nb-1").inputs;
		expect(h.member("nb-1").briefPresented).toBe(false);
		const seq = h.member("nb-1").briefSeq;
		await h.rt.shutdown();
		h.reopen();
		expect(h.member("nb-1").brief).toBe("");
		await h.swarm({ action: "revive", name: "nb-1" });
		await until(() => (h.factory.sessions.get("nb-1")?.inputs.length ?? 0) >= 1, 1000, "brief replayed");
		const replay = h.session("nb-1").inputs[0] ?? "";
		expect(replay).toBe(`[swarm] You are \`nb-1\`. Brief from coordinator (board #${seq}):\n\nthe real brief\n\nYour slice: slice one`);
		expect(replay.split("Your slice:").length).toBe(2);
		expect(first.length).toBe(0); // the dropped prompt never started a run
		await until(() => h.member("nb-1").briefPresented, 1000, "presented after the replay");
	});
});

describe("kill fence and shutdown (I11, SW-06)", () => {
	test("a killed member's tools refuse; helpers survive; names are never reused", async () => {
		h = new Harness();
		let helperAdded = false;
		h.factory.brains.set("lead", async t => {
			if (!helperAdded) {
				helperAdded = true;
				const r = await t.call("swarm", { action: "add", name: "helper", brief: "help" });
				expect(r.isError).toBeUndefined();
			}
			await t.call("post_message", { text: "@coordinator ok" });
			await t.call("swarm_wait", {});
		});
		h.factory.brains.set("helper", waitingWorker([]));
		await h.swarm({ action: "add", name: "lead", brief: "x" });
		await until(() => h.rt.members.get("helper")?.phase === "parked" && h.member("lead").phase === "parked", 2000, "both parked");
		const leadTools = h.session("lead").tools;
		await h.swarm({ action: "kill", name: "lead" });
		const r = await leadTools.get("post_message")?.execute("x1", { text: "still here?" }, undefined, { sessionManager: { getSessionId: () => h.session("lead").sessionId, getBranch: () => [] } });
		expect(r?.details.error).toBe(NOT_A_MEMBER);
		expect(h.member("helper").killed).toBe(false);
		const again = await h.swarm({ action: "add", name: "lead", brief: "x" });
		expect(again.isError).toBe(true);
	});

	test("a worker can kill only its own helpers (per-member errors)", async () => {
		h = new Harness();
		let result: Record<string, unknown> | undefined;
		h.factory.brains.set("w", async t => {
			result = (await t.call("swarm", { action: "kill", name: "g" })).details;
			await t.call("post_message", { text: "@coordinator done" });
		});
		await h.swarm({ action: "add", name: "g", brief: "x", n: 2 });
		await h.swarm({ action: "add", name: "w", brief: "kill g" });
		await until(() => !!result, 1000, "kill attempted");
		expect((result?.errors as unknown[]).length).toBe(2);
		expect(h.member("g-1").killed).toBe(false);
	});

	test("shutdown: synchronous checkpoint, lease released, returns within the budget with a hanging dispose", async () => {
		h = new Harness();
		h.factory.brains.set("hang", waitingWorker([]));
		await h.swarm({ action: "add", name: "hang", brief: "x" });
		await until(() => h.member("hang").phase === "parked", 1000, "parked");
		h.factory.disposeHangs.add("hang");
		const t0 = performance.now();
		await h.rt.shutdown();
		expect(performance.now() - t0).toBeLessThan(1000);
		const rt2 = SwarmRuntime.open(h.binding, h.deps, h.dir, false);
		expect(rt2.members.get("hang")?.phase).toBe("stopped");
		await rt2.shutdown();
	});

	test("a worktree is retained when the worker does not finish stopping; retry is idempotent", async () => {
		h = new Harness();
		const repo = h.binding.cwd;
		execFileSync("git", ["init", "-q", repo]);
		execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
		h.factory.brains.set("wt", waitingWorker([]));
		const r = await h.swarm({ action: "add", name: "wt", brief: "x", workspace: "branch" });
		expect(r.isError).toBeUndefined();
		await until(() => h.member("wt").phase === "parked", 1000, "parked");
		h.factory.disposeHangs.add("wt");
		const k = await h.swarm({ action: "kill", name: "wt" });
		const ws = (k.details.workspaces as { state: string; reason: string; cleanup: string }[])[0];
		expect(ws?.state).toBe("retained");
		expect(ws?.reason).toContain("did not finish stopping");
		expect(ws?.cleanup).not.toContain("--force");
		const again = await h.swarm({ action: "kill", name: "wt" });
		expect((again.details.workspaces as { state: string }[])[0]?.state).toBe("retained");
		expect(h.member("wt").workspace.state).toBe("retained");
	});
});
