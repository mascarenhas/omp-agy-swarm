// I1 (add, reservation, construction failure, kill/shutdown during construction), the R2 startup
// brief floor and the structural crash windows.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "../../src/runtime/workspace.ts";
import { fastTimers, Harness, settle, until } from "../helpers/harness.ts";

/** A harness whose coordinator works in `<repo>/sub`, a directory the base commit does not have. */
function repoHarness(): Harness {
	const root = mkdtempSync(join(tmpdir(), "swarm-it-"));
	const repo = join(root, "repo");
	mkdirSync(join(repo, "sub"), { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
	return new Harness({ root, cwd: join(repo, "sub") });
}

let h: Harness;
afterEach(async () => {
	await h?.close();
});

describe("add", () => {
	test("reserves names synchronously, posts the brief after the session exists, prompt is acknowledged", async () => {
		h = new Harness();
		h.factory.brains.set("alpha", async t => {
			await t.call("post_message", { text: "@coordinator [done] wrote it" });
		});
		const r = await h.swarm({ action: "add", name: "alpha", brief: "write it" });
		expect(r.isError).toBeUndefined();
		const added = r.details.added as { name: string; brief_seq: number }[];
		expect(added[0]?.name).toBe("alpha");
		expect(added[0]?.brief_seq).toBe(1);
		await until(() => h.member("alpha").briefPresented && h.member("alpha").phase === "idle", 2000, "alpha idle");
		expect(h.member("alpha").lastReadSeq).toBe(1);
		expect(h.session("alpha").inputs[0]).toContain("You are `alpha`. Brief from coordinator (board #1)");
		expect(h.rt.board.messages[1]?.text).toBe("@coordinator [done] wrote it");
	});

	test("two concurrent adds of the same name: exactly one wins", async () => {
		h = new Harness();
		const [a, b] = await Promise.all([
			h.swarm({ action: "add", name: "dup", brief: "x" }),
			h.swarm({ action: "add", name: "dup", brief: "y" }),
		]);
		const errs = [a, b].filter(r => r.isError);
		expect(errs.length).toBe(1);
		expect(String(errs[0]?.details.error)).toContain("already used");
	});

	test("role singleton and canonical role names", async () => {
		h = new Harness();
		const n1 = await h.swarm({ action: "add", role: "narrator" });
		expect((n1.details.added as { name: string }[])[0]?.name).toBe("narrator");
		const n2 = await h.swarm({ action: "add", role: "narrator" });
		expect(n2.isError).toBe(true);
		const bad = await h.swarm({ action: "add", role: "monitor", name: "watcher" });
		expect(bad.isError).toBe(true);
		const w = await h.swarm({ action: "add", name: "monitor-3", brief: "x" });
		expect(w.isError).toBe(true);
	});

	test("caps count reservations", async () => {
		h = new Harness({ env: { maxWorkers: 2 } });
		const r = await h.swarm({ action: "add", name: "g", brief: "x", n: 3 });
		expect(r.isError).toBe(true);
		expect(String(r.details.error)).toContain("limited to 2");
	});

	test("construction failure frees the name and slot", async () => {
		h = new Harness();
		h.factory.failCreate.set("boom", "no such model");
		const r = await h.swarm({ action: "add", name: "boom", brief: "x" });
		expect((r.details.errors as { name: string }[])[0]?.name).toBe("boom");
		expect(h.rt.members.has("boom")).toBe(false);
		h.factory.failCreate.delete("boom");
		const again = await h.swarm({ action: "add", name: "boom", brief: "x" });
		expect((again.details.added as unknown[]).length).toBe(1);
	});

	test("a mention while starting is not a wake; the member gets it with its brief (reservation floor)", async () => {
		h = new Harness();
		h.factory.brains.set("other", async () => {});
		await h.swarm({ action: "add", name: "other", brief: "idle" });
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		h.factory.gates.set("late", gate);
		const adding = h.swarm({ action: "add", name: "late", brief: "do it" });
		await until(() => h.rt.members.get("late")?.phase === "starting", 1000, "late reserved");
		const p = await h.post("@late here is context for you");
		expect(p.details.woke).toEqual([]);
		resolve();
		await adding;
		const s = h.session("late");
		await until(() => s.inputs.length > 0, 1000, "late prompt");
		expect(s.inputs[0]).toContain("here is context for you");
		await until(() => h.member("late").briefPresented, 1000, "brief presented");
		expect(h.member("late").lastReadSeq).toBe(h.member("late").briefSeq);
	});

	test("unaddressed posts made while starting ride with the brief; none is skipped by the cursor (H3)", async () => {
		h = new Harness();
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		h.factory.gates.set("late", gate);
		const adding = h.swarm({ action: "add", name: "late", brief: "do it" });
		await until(() => h.rt.members.get("late")?.phase === "starting", 1000, "late reserved");
		await h.post("general context nobody was named in");
		await h.post("@late addressed context");
		resolve();
		await adding;
		const s = h.session("late");
		await until(() => h.member("late").briefPresented, 1000, "brief presented");
		expect(s.inputs[0]).toContain("general context nobody was named in");
		expect(s.inputs[0]).toContain("addressed context");
		expect(h.member("late").lastReadSeq).toBe(h.member("late").briefSeq);
	});

	test("a page truncated before the brief advances the cursor only through what was presented (H3)", async () => {
		h = new Harness();
		const inputs: string[] = [];
		const hold = Promise.withResolvers<void>();
		h.factory.brains.set("late", async t => {
			inputs.push(t.input);
			if (inputs.length === 1) await hold.promise;
		});
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		h.factory.gates.set("late", gate);
		const adding = h.swarm({ action: "add", name: "late", brief: "do it" });
		await until(() => h.rt.members.get("late")?.phase === "starting", 1000, "late reserved");
		for (let i = 1; i <= 25; i++) await h.post(`note ${i}`);
		resolve();
		await adding;
		const m = h.member("late");
		await until(() => m.briefPresented, 1000, "brief presented");
		expect(inputs[0]).toContain("You are `late`");
		expect(inputs[0]).toContain("note 20");
		expect(inputs[0]).not.toContain("note 21");
		expect(m.lastReadSeq).toBe(20);
		hold.resolve();
		await until(() => inputs.length >= 2, 1000, "the rest delivered");
		expect(inputs[1]).toContain("note 21");
		expect(inputs[1]).toContain("note 25");
		await until(() => m.lastReadSeq === m.briefSeq, 1000, "caught up");
	});

	test("only the user message carrying the sent prompt text is its receipt (H3)", async () => {
		h = new Harness();
		h.factory.sendModes.set("strict", ["hang"]);
		await h.swarm({ action: "add", name: "strict", brief: "do it" });
		const m = h.member("strict");
		await until(() => m.delivery?.status === "dispatched", 1000, "prompt dispatched");
		const s = h.session("strict");
		const sent = m.delivery?.text ?? "";
		s.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "an unrelated user message" }] } });
		expect(m.briefPresented).toBe(false);
		expect(m.delivery?.kind).toBe("prompt");
		s.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: sent }] } });
		expect(m.briefPresented).toBe(true);
		expect(m.delivery).toBeUndefined();
	});

	test("a rejected prompt leaves the brief unacknowledged and replays it", async () => {
		h = new Harness();
		fastTimers();
		h.factory.sendModes.set("flaky", ["reject"]);
		h.factory.brains.set("flaky", async () => {});
		await h.swarm({ action: "add", name: "flaky", brief: "do it" });
		const m = h.member("flaky");
		await until(() => m.briefPresented, 3000, "brief replayed");
		expect(h.session("flaky").inputs[0]).toContain("You are `flaky`");
	});

	test("kill during construction disposes the late session", async () => {
		h = new Harness();
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		h.factory.gates.set("slow", gate);
		const adding = h.swarm({ action: "add", name: "slow", brief: "x" });
		await until(() => h.rt.members.get("slow")?.phase === "starting", 1000, "reserved");
		const kill = h.swarm({ action: "kill", name: "slow" });
		resolve();
		await adding;
		await kill;
		await settle(5);
		expect(h.member("slow").killed).toBe(true);
		const s = h.factory.all.find(x => x.name === "slow");
		expect(s?.disposed).toBe(true);
		expect(h.rt.board.messages.some(m => m.text.startsWith("@slow"))).toBe(false);
	});

	test("shutdown during construction leaves nothing running", async () => {
		h = new Harness();
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		h.factory.gates.set("slow", gate);
		const adding = h.swarm({ action: "add", name: "slow", brief: "x" });
		await until(() => h.rt.members.get("slow")?.phase === "starting", 1000, "reserved");
		const down = h.rt.shutdown();
		resolve();
		await adding;
		await down;
		await settle(5);
		const s = h.factory.all.find(x => x.name === "slow");
		expect(!s || s.disposed).toBe(true);
	});

	test("agent ids use the full session id; two sids sharing a prefix do not collide", async () => {
		h = new Harness({ sid: "01a1fc2e-0000-0000-0000-000000000001" });
		await h.swarm({ action: "add", name: "w", brief: "x" });
		expect(h.member("w").agentId).toBe("swarm-01a1fc2e-0000-0000-0000-000000000001-w");
		const h2 = new Harness({ sid: "01a1fc2e-0000-0000-0000-000000000002" });
		try {
			await h2.swarm({ action: "add", name: "w", brief: "x" });
			expect(h2.member("w").agentId).not.toBe(h.member("w").agentId);
		} finally {
			await h2.close();
		}
	});
});

describe("crash windows", () => {
	test("a reservation checkpointed without a session reloads as stopped with failure start", async () => {
		h = new Harness();
		const { promise: gate } = Promise.withResolvers<void>();
		h.factory.gates.set("ghost", gate);
		void h.swarm({ action: "add", name: "ghost", brief: "x" });
		await until(() => h.rt.members.get("ghost")?.phase === "starting", 1000, "reserved");
		const roster = JSON.parse(readFileSync(join(h.dir, "members.json"), "utf8"));
		expect(roster.members.ghost).toBeDefined();
		// Simulate a crash: release the lease without any shutdown bookkeeping.
		h.rt.store.close();
		h.rt.closing = true;
		const rt = h.reopen();
		const g = rt.members.get("ghost");
		expect(g?.phase).toBe("stopped");
		expect(g?.failure?.kind).toBe("start");
		expect(rt.revive(g as never)).toContain("never started");
	});

	test("a torn last journal line is cut; a complete last line missing its newline is kept", async () => {
		h = new Harness();
		await h.post("first").catch(() => {});
		await h.swarm({ action: "title", title: "t" });
		const rt0 = h.rt;
		await rt0.shutdown();
		const path = join(h.dir, "board.jsonl");
		writeFileSync(path, `${JSON.stringify({ seq: 1, agent: "coordinator", text: "a", time: "2026-01-01 00:00:00" })}\n${JSON.stringify({ seq: 2, agent: "coordinator", text: "b", time: "2026-01-01 00:00:01" })}`);
		const rt = h.reopen();
		expect(rt.board.head).toBe(2);
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		await rt.shutdown();
		writeFileSync(path, `${JSON.stringify({ seq: 1, agent: "coordinator", text: "a", time: "2026-01-01 00:00:00" })}\n{"seq":2,"agent":"coor`);
		const rt2 = h.reopen();
		expect(rt2.board.head).toBe(1);
		expect(rt2.recovered).toBe(true);
	});
});

describe("group preparation (M4)", () => {
	test("each worktree's notes reach the add result", async () => {
		h = repoHarness();
		const r = await h.swarm({ action: "add", name: "g", brief: "x", n: 2, workspace: "branch" });
		expect((r.details.added as unknown[]).length).toBe(2);
		const notes = JSON.stringify(r.details.notes ?? r.details);
		expect(notes).toContain("g-1 starts at the worktree root");
		expect(notes).toContain("g-2 starts at the worktree root");
	});

	test("killing one member during the shared preparation does not fail its siblings", async () => {
		h = repoHarness();
		const hold = Promise.withResolvers<void>();
		let gate: Promise<void> | undefined = hold.promise;
		const slow: GitRunner = async (args, o) => {
			if (gate) {
				const g = gate;
				gate = undefined;
				await g;
			}
			return defaultGit(args, o);
		};
		(h.deps as { git: GitRunner }).git = slow;
		const adding = h.swarm({ action: "add", name: "g", brief: "x", n: 2, workspace: "branch" });
		await until(() => h.rt.members.get("g-1")?.phase === "starting", 1000, "reserved");
		const killing = h.swarm({ action: "kill", name: "g-1" });
		await settle(5);
		hold.resolve();
		const r = await adding;
		await killing;
		expect((r.details.added as { name: string }[]).map(a => a.name)).toEqual(["g-2"]);
		expect(h.member("g-2").workspace.mode).toBe("branch");
	});
});
