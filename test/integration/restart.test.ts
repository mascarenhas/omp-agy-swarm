// I10 restart and revival (with the SW-09 authorization boundary), I11 kill fence and shutdown,
// and the SW-06 rule that a worktree is retained when its worker did not finish stopping.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	test("migrates missing ids and preserves exact legacy ids without changing transcripts", async () => {
		h = new Harness();
		for (const name of ["legacy", "missing", "dead"]) await h.swarm({ action: "add", name, brief: "x" });
		await until(() => h.member("legacy").phase === "idle" && h.member("missing").phase === "idle", 1000, "idle");
		await h.swarm({ action: "kill", name: "dead" });
		await h.rt.shutdown();
		const path = join(h.dir, "members.json");
		const saved = JSON.parse(readFileSync(path, "utf8"));
		const legacyId = `swarm-${h.rt.sid}-legacy`;
		saved.members.legacy.agent_id = legacyId;
		delete saved.members.missing.agent_id;
		delete saved.members.dead.agent_id;
		writeFileSync(path, JSON.stringify(saved));
		h.reopen();
		const migrated = JSON.parse(readFileSync(path, "utf8")).members;
		expect(migrated.legacy.agent_id).toBe(legacyId);
		expect(migrated.missing.agent_id).toBe("swarm~missing");
		expect(migrated.dead.agent_id).toBe("swarm~dead");
		expect(h.rt.revive(h.member("dead"))).toBe("killed");
		for (const name of ["legacy", "missing"]) {
			await h.swarm({ action: "revive", name });
			await until(() => h.member(name).phase === "idle", 1000, `${name} revived`);
			expect(h.session(name).agentId).toBe(migrated[name].agent_id);
			expect(h.session(name).sessionId).toBe(saved.members[name].conversation_id);
		}
	});

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
		expect(s.inputs[0]).toContain("Background jobs from the previous session are not resumed");
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
		const [reminder, brief] = replay.split("\n\n[swarm]");
		expect(reminder).toContain("Background jobs from the previous session are not resumed");
		expect(`[swarm]${brief}`).toBe(`[swarm] You are \`nb-1\`. Brief from coordinator (board #${seq}):\n\nthe real brief\n\nYour slice: slice one`);
		expect(replay.split("Your slice:").length).toBe(2);
		expect(first.length).toBe(0); // the dropped prompt never started a run
		await until(() => h.member("nb-1").briefPresented, 1000, "presented after the replay");
	});
});

describe("kill fence and shutdown (I11, SW-06)", () => {
	for (const phase of ["working", "parked", "idle"] as const) {
		test(`native stop fences ${phase} immediately and never reenters worker disposal`, async () => {
			h = new Harness();
			const releaseBrain = Promise.withResolvers<void>();
			h.factory.brains.set("native", async t => {
				if (phase === "working") await releaseBrain.promise;
				if (phase === "parked") {
					await t.call("post_message", { text: "ready to park" });
					await t.call("swarm_wait", {});
				}
			});
			await h.swarm({ action: "add", name: "native", brief: "x" });
			const m = h.member("native");
			const s = h.session("native");
			await until(() => m.phase === phase && m.briefPresented, 1000, phase);
			const oldGen = m.gen;
			const head = h.rt.board.head;
			s.hostKill();
			expect(m.gen).toBe(oldGen + 1);
			expect(m.state).toBe("killed");
			expect(m.session).toBeUndefined();
			expect(s.disposed).toBe(false);
			if (phase === "parked") {
				expect(s.waitTransitions).toHaveLength(2);
				expect(s.waitTransitions[1]?.id).toBe(s.waitTransitions[0]?.id);
				expect(s.waitTransitions.map(w => w.waiting)).toEqual([true, false]);
			}
			const tool = s.tools.get("post_message");
			const late = await tool?.execute("late", { text: "@coordinator late" }, undefined, { sessionManager: { getSessionId: () => s.sessionId } });
			expect(late?.details.error).toBe(NOT_A_MEMBER);
			expect(h.rt.board.head).toBe(head);
			const joining = h.rt.kill(m, { discardIgnored: false, keepWorkspace: false });
			expect(m.killPromise).toBe(joining);
			const released = s.hostRelease(true);
			releaseBrain.resolve();
			await released;
			await joining;
			s.hostKill(); // duplicate/stale source
			expect(s.teardown.slice(0, 3)).toEqual(["hostKill", "dispose", "hostRelease"]);
			expect(s.teardown.filter(step => step === "dispose")).toHaveLength(1);
			expect(h.rt.coordinator.notices.filter(n => n.kind === "worker_stopped")).toHaveLength(1);
			expect(h.rt.revive(m)).toBe("killed");
		});
	}

	test("native kill retains dirty work if disposal is late, then preserves WIP on explicit cleanup", async () => {
		h = new Harness();
		const repo = h.binding.cwd;
		execFileSync("git", ["init", "-q", repo]);
		execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
		await h.swarm({ action: "add", name: "native", brief: "x", workspace: "branch" });
		const m = h.member("native");
		const s = h.session("native");
		await until(() => m.phase === "idle", 1000, "idle");
		const edited = join(m.workspace.path, "uncommitted.txt");
		writeFileSync(edited, "work survives native stop");
		const drain = Promise.withResolvers<void>();
		h.factory.disposeGates.set("native", drain.promise);
		s.hostKill();
		const cleanup = m.killPromise;
		expect(cleanup).toBeDefined();
		expect(existsSync(edited)).toBe(true);
		expect(m.workspace.state).toBe("active");
		const hostDone = s.hostRelease(true);
		expect(await cleanup).toMatchObject({ state: "retained", reason: expect.stringContaining("did not finish stopping") });
		expect(existsSync(edited)).toBe(true);
		expect(m.stoppedCleanly).toBe(false);
		drain.resolve();
		await hostDone;
		await until(() => m.stoppedCleanly, 1000, "late stop confirmation");
		const result = await h.rt.kill(m, { discardIgnored: false, keepWorkspace: false });
		expect(result).toMatchObject({ state: "removed", wip_ref: `refs/swarm/${h.rt.sid}/native/wip` });
		expect(existsSync(edited)).toBe(false);
		expect(execFileSync("git", ["-C", repo, "show", `${result?.wip_ref}:uncommitted.txt`], { encoding: "utf8" })).toBe("work survives native stop");
	});

	test("host removal followed by an idle revival does not taint a later shutdown", async () => {
		h = new Harness({ mode: "tui" });
		const finishing = Promise.withResolvers<void>();
		h.factory.brains.set("removed", async () => { await finishing.promise; });
		await h.swarm({ action: "add", name: "removed", brief: "x" });
		const m = h.member("removed");
		await until(() => m.phase === "working" && m.briefPresented, 1000, "worker has live work");
		const old = h.session("removed");
		const stopping = old.hostRelease(false);
		expect(m.phase).toBe("stopped");
		expect(h.rt.revive(m)).toBe("the previous session has not finished closing");
		finishing.resolve();
		await stopping;
		await until(() => !m.drain, 1000, "real disposal barrier settled");
		expect(h.rt.revive(m)).toBeUndefined();
		await until(() => m.phase === "idle" && m.session !== old, 1000, "replacement idle");
		await h.rt.shutdown();
		expect(h.rt.outcome).toBeNull();
	});

	test("clear and normal host removal preserve parks and revivable ids", async () => {
		h = new Harness({ mode: "tui" });
		h.factory.brains.set("root", async t => {
			await t.call("post_message", { text: "ready to park" });
			await t.call("swarm_wait", { timeout_seconds: 60 });
		});
		h.factory.resolvedIds.set("root", "swarm~root~2");
		await h.swarm({ action: "add", name: "root", brief: "x" });
		const m = h.member("root");
		const old = h.session("root");
		await until(() => m.phase === "parked", 1000, "parked");
		h.rt.onSessionClear();
		expect(m.session).toBe(old);
		expect(m.phase).toBe("parked");
		await old.hostRelease(false);
		expect(m.phase).toBe("stopped");
		expect(m.killed).toBe(false);
		expect(m.lastPark?.mode).toBe("mentions");
		await h.rt.shutdown();
		expect(h.rt.outcome).toBeNull();
		expect(old.teardown).toEqual(["dispose", "hostRelease"]);
		h.reopen();
		h.factory.resolvedIds.clear();
		await h.swarm({ action: "revive", name: "root" });
		await until(() => h.member("root").phase === "parked", 1000, "revived and parked");
		const revived = h.session("root");
		expect(revived).not.toBe(old);
		expect(revived.agentId).toBe("swarm~root~2");
		expect(revived.sessionId).toBe(old.sessionId);
		old.hostKill();
		expect(h.member("root").session).toBe(revived);
		expect(h.member("root").killed).toBe(false);
	});

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
