// I2 park/wake matrix, I3 claims, I4 deliveries, I5 cycles and nudges, I6 failures, I12
// compaction reminders, and the restricted-worker sole-call batch rule.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { claim } from "../../src/runtime/waits.ts";
import { fastTimers, Harness, settle, until } from "../helpers/harness.ts";
import type { ToolOut, TurnCtx } from "../helpers/scripted-session.ts";

let h: Harness;
beforeAll(() => fastTimers());
afterEach(async () => {
	await h?.close();
});

interface Woken {
	woke: string;
	seqs: number[];
	notices: string[];
}

/** A brain that posts once (so no nudge) and then waits in a loop, recording every result. */
function parker(log: Woken[], opts: { mentionsOnly?: boolean; first?: string } = {}) {
	return async (t: TurnCtx) => {
		await t.call("post_message", { text: opts.first ?? "ready" });
		for (;;) {
			const r: ToolOut = await t.call("swarm_wait", opts.mentionsOnly === false ? { mentions_only: false } : {});
			const d = r.details;
			// Only wakes carrying posts are recorded (a direct wake is followed by a nudge on the
			// next wait, since this brain never posts again).
			if (d.woke === "post" || d.woke === "notice")
				log.push({
					woke: String(d.woke),
					seqs: Array.isArray(d.messages) ? (d.messages as { seq: number }[]).map(m => m.seq) : [],
					notices: Array.isArray(d.notices) ? (d.notices as string[]) : [],
				});
			if (["closing", "killed", "aborted", "switch", "interrupted"].includes(String(d.woke))) return;
		}
	};
}

async function addParked(name: string, log: Woken[], opts: { mentionsOnly?: boolean; channels?: string[] } = {}) {
	h.factory.brains.set(name, parker(log, opts));
	const r = await h.swarm({ action: "add", name, brief: "wait for work", ...(opts.channels ? { channels: opts.channels } : {}) });
	expect(r.isError).toBeUndefined();
	await until(() => h.member(name).phase === "parked", 2000, `${name} parked`);
}

const woken = (log: Woken[], seq: unknown): boolean => log.some(w => w.seqs.includes(Number(seq)));

/** Waits until every named member is parked and nothing has changed for a few ticks. */
async function quiet(names: string[]): Promise<void> {
	let v = -1;
	await until(() => {
		const parked = names.every(n => h.member(n).phase === "parked");
		const stable = parked && h.rt.version === v;
		v = h.rt.version;
		return stable;
	}, 2000, "quiet");
}

describe("park/wake matrix (I2)", () => {
	test("mentions vs anything, prefix, @all", async () => {
		h = new Harness();
		const a: Woken[] = [];
		const b: Woken[] = [];
		const g1: Woken[] = [];
		await addParked("alpha", a);
		await addParked("beta", b, { mentionsOnly: false });
		await addParked("grp-1", g1);
		await quiet(["alpha", "beta", "grp-1"]);
		const p1 = await h.post("status update for nobody");
		expect(p1.details.woke).toEqual(["beta"]);
		await until(() => woken(b, p1.details.seq), 1000, "beta woke on any post");
		await quiet(["alpha", "beta", "grp-1"]);
		expect(woken(a, p1.details.seq) || woken(g1, p1.details.seq)).toBe(false);
		const p2 = await h.post("@grp please look");
		expect((p2.details.woke as string[]).sort()).toEqual(["beta", "grp-1"]);
		await until(() => woken(g1, p2.details.seq), 1000, "group prefix woke grp-1");
		await quiet(["alpha", "beta", "grp-1"]);
		expect(woken(a, p2.details.seq)).toBe(false);
		const p3 = await h.post("@all rule: no pushes");
		expect((p3.details.woke as string[]).sort()).toEqual(["alpha", "beta", "grp-1"]);
	});

	test("@#channel wakes subscribers only, never after archive", async () => {
		h = new Harness();
		await h.swarm({ action: "channel", op: "create", channel: "parser", topic: "the parser" });
		const sub: Woken[] = [];
		const other: Woken[] = [];
		await addParked("lexer", sub, { channels: ["parser"] });
		await addParked("docs", other);
		await quiet(["lexer", "docs"]);
		const r = await h.post("@#parser please rebase");
		expect(r.details.woke).toEqual(["lexer"]);
		expect(r.details.channel_mentions).toEqual(["parser"]);
		await until(() => woken(sub, r.details.seq), 1000, "subscriber woke");
		expect(woken(other, r.details.seq)).toBe(false);
		await quiet(["lexer", "docs"]);
		await h.swarm({ action: "channel", op: "archive", channel: "parser" });
		const r2 = await h.post("@#parser anyone?");
		expect(r2.details.woke).toEqual([]);
		const bad = await h.post("@#main hello");
		expect(bad.isError).toBe(true);
	});
});

describe("claims (I3)", () => {
	test("post + timeout + abort in one tick: exactly one claim wins", async () => {
		h = new Harness();
		const log: Woken[] = [];
		await addParked("alpha", log);
		const m = h.member("alpha");
		const id = m.waiter?.id as string;
		const wins = [claim(h.rt, m, id, "post"), claim(h.rt, m, id, "timeout"), claim(h.rt, m, id, "aborted")];
		expect(wins).toEqual([true, false, false]);
		expect(m.phase).toBe("resuming");
	});

	test("a second post after a claim joins the same result; no second delivery", async () => {
		h = new Harness();
		const log: Woken[] = [];
		await addParked("alpha", log);
		await quiet(["alpha"]);
		const [one, two] = await Promise.all([h.post("@alpha one"), h.post("@alpha two")]);
		await until(() => woken(log, one?.details.seq), 1000, "one wake");
		const w = log.find(x => x.seqs.includes(Number(one?.details.seq)));
		expect(w?.seqs).toContain(Number(two?.details.seq));
		expect(h.factory.sent.filter(s => s.name === "alpha").length).toBe(0);
		await until(() => h.member("alpha").lastReadSeq >= Number(two?.details.seq), 1000, "cursor advanced on receipt");
	});

	test("main-session batch rule and worker sole-call rule", async () => {
		h = new Harness();
		const r = await h.call("swarm_wait", {}, { id: "w1", batch: ["w1", "p1"] });
		expect(r.details.woke).toBe("not_parked");
		expect(r.useless).toBe(true);
		const results: ToolOut[] = [];
		h.factory.brains.set("solo", async t => {
			await t.call("post_message", { text: "ready" });
			results.push(...(await t.batch([["post_message", { text: "note" }], ["swarm_wait", {}]])));
		});
		await h.swarm({ action: "add", name: "solo", brief: "x" });
		await until(() => results.length === 2, 1000, "batch ran");
		expect(results[1]?.details.woke).toBe("not_parked");
		expect(String(results[1]?.details.note)).toContain("only tool call");
	});

	test("an aborted wait consumes nothing; since beyond head is rejected", async () => {
		h = new Harness();
		await h.post("hello");
		const ac = new AbortController();
		const p = h.call("swarm_wait", {}, { signal: ac.signal });
		await until(() => h.rt.coordinator.phase === "parked", 1000, "coordinator parked");
		const cursor = h.rt.coordinator.lastReadSeq;
		ac.abort();
		const r = await p;
		expect(r.details.woke).toBe("aborted");
		expect(h.rt.coordinator.lastReadSeq).toBe(cursor);
		const bad = await h.call("swarm_wait", { since: 99 });
		expect(bad.isError).toBe(true);
	});
});

describe("deliveries (I4)", () => {
	test("idle worker: @mention admits one aside; receipt advances the cursor", async () => {
		h = new Harness();
		const seen: string[] = [];
		h.factory.brains.set("idle", async t => {
			seen.push(t.input);
			if (t.input.includes("You are `idle`")) await t.call("post_message", { text: "@coordinator ok" });
			else await t.call("post_message", { text: "@coordinator got it" });
		});
		await h.swarm({ action: "add", name: "idle", brief: "x" });
		await until(() => h.member("idle").phase === "idle" && seen.length === 1, 1000, "idle");
		const p = await h.post("@idle take #2");
		expect(p.details.woke).toEqual(["idle"]);
		await until(() => seen.length === 2, 1000, "woken");
		expect(seen[1]).toContain(`#${p.details.seq} coordinator → @you`);
		await until(() => h.member("idle").lastReadSeq >= Number(p.details.seq), 1000, "cursor");
	});

	test("two same-tick posts batch into one delivery", async () => {
		h = new Harness();
		const seen: string[] = [];
		h.factory.brains.set("idle", async t => {
			seen.push(t.input);
			await t.call("post_message", { text: "@coordinator ok" });
		});
		await h.swarm({ action: "add", name: "idle", brief: "x" });
		await until(() => h.member("idle").phase === "idle" && seen.length === 1, 1000, "idle");
		void h.post("@idle a");
		void h.post("@idle b");
		await until(() => seen.length === 2, 1000, "woken once");
		await settle(10);
		expect(seen.length).toBe(2);
		expect(seen[1]).toContain("a");
		expect(seen[1]).toContain("@idle b");
	});

	test("dropped and rejected sends are released and replayed; exhausted retries notify the coordinator", async () => {
		h = new Harness();
		const seen: string[] = [];
		h.factory.brains.set("flaky", async t => {
			seen.push(t.input);
			await t.call("post_message", { text: "@coordinator ok" });
		});
		await h.swarm({ action: "add", name: "flaky", brief: "x" });
		await until(() => h.member("flaky").phase === "idle" && seen.length === 1, 1000, "idle");
		h.factory.sendModes.set("flaky", ["drop", "reject"]);
		const p = await h.post("@flaky please");
		await until(() => seen.length === 2, 2000, "delivered on the third attempt");
		expect(h.member("flaky").lastReadSeq).toBeGreaterThanOrEqual(Number(p.details.seq));
		h.factory.sendModes.set("flaky", ["drop", "drop", "drop", "drop"]);
		await h.post("@flaky again");
		await until(() => h.rt.coordinator.notices.some(n => n.kind === "delivery"), 3000, "delivery notice");
		expect(h.member("flaky").redeliveryExhausted).toBe(true);
	});

	test("a folded aside is acknowledged without a run", async () => {
		h = new Harness();
		h.factory.brains.set("f", async t => {
			await t.call("post_message", { text: "@coordinator ok" });
		});
		await h.swarm({ action: "add", name: "f", brief: "x" });
		await until(() => h.member("f").phase === "idle" && h.member("f").briefPresented, 1000, "idle");
		h.factory.sendModes.set("f", ["fold"]);
		const p = await h.post("@f fyi");
		await until(() => h.member("f").lastReadSeq >= Number(p.details.seq) && h.member("f").phase === "idle", 1000, "folded receipt");
	});

	test("an oversized backlog pages with more and names the trigger outside the page", async () => {
		h = new Harness();
		const seen: string[] = [];
		h.factory.brains.set("big", async t => {
			seen.push(t.input);
			await t.call("post_message", { text: "@coordinator ok" });
		});
		await h.swarm({ action: "add", name: "big", brief: "x" });
		await until(() => h.member("big").phase === "idle" && seen.length === 1, 1000, "idle");
		h.factory.sendModes.set("big", ["drop"]);
		await h.post("@big start");
		for (let i = 0; i < 24; i++) await h.post(`chatter ${i}`);
		await until(() => seen.length === 2, 2000, "woken");
		expect(seen[1]).toContain('More posts follow: read_board until "more" is false.');
	});

	test("interactive coordinator: aside on @coordinator, released without receipt", async () => {
		h = new Harness({ mode: "tui" });
		h.factory.brains.set("w", async t => {
			await t.call("post_message", { text: "@coordinator [done] report" });
		});
		await h.swarm({ action: "add", name: "w", brief: "x" });
		await until(() => h.binding.wakes.length >= 1, 1000, "coordinator wake");
		const c = h.rt.coordinator;
		expect(c.delivery?.kind).toBe("aside");
		await until(() => !c.delivery, 1000, "released after the receipt window");
		expect(c.lastReadSeq).toBe(0);
		const d0 = h.binding.wakes[0];
		h.rt.onMainAgentStart();
		h.rt.onMainAgentEnd({});
		await until(() => !!c.delivery, 1000, "redelivered once per run end");
		const d = c.delivery;
		h.rt.onMainAgentStart();
		h.rt.onMainMessageEnd({ role: "custom", customType: "swarm-wake", content: "", details: d ? { delivery_id: d.id } : {} });
		expect(c.lastReadSeq).toBe(2);
		expect(d0?.customType).toBe("swarm-wake");
	});
});

describe("cycles and nudges (I5)", () => {
	test("a silent finish after the brief is nudged once; a broadcast wake is not", async () => {
		h = new Harness();
		const seen: string[] = [];
		h.factory.brains.set("quiet", async t => {
			seen.push(t.input);
		});
		await h.swarm({ action: "add", name: "quiet", brief: "answer me" });
		await until(() => seen.length === 2, 1000, "nudged");
		expect(seen[1]).toContain("You were asked something and have not posted");
		await settle(20);
		expect(seen.length).toBe(2);
		await h.post("@all broadcast");
		await until(() => seen.length === 3, 1000, "broadcast wake");
		await settle(20);
		expect(seen.length).toBe(3);
	});

	test("swarm_wait before posting returns nudge once; role workers are never nudged", async () => {
		h = new Harness();
		const r: string[] = [];
		h.factory.brains.set("w", async t => {
			r.push(String((await t.call("swarm_wait", {})).details.woke));
			r.push(String((await t.call("swarm_wait", { timeout_seconds: 1 })).details.woke));
		});
		await h.swarm({ action: "add", name: "w", brief: "answer me" });
		await until(() => r.length === 2, 3000, "two waits");
		expect(r).toEqual(["nudge", "timeout"]);
		const m: string[] = [];
		h.factory.brains.set("monitor", async t => {
			m.push(t.input);
		});
		await h.swarm({ action: "add", role: "monitor" });
		await until(() => m.length === 1, 1000, "monitor prompt");
		await settle(20);
		expect(m.length).toBe(1);
	});
});

describe("failures (I6)", () => {
	test("one report per failed run; no automatic retry of old debt; a post by name retries", async () => {
		h = new Harness();
		let runs = 0;
		const posted = Promise.withResolvers<void>();
		h.factory.brains.set("f", async t => {
			runs++;
			if (runs === 2) {
				// A qualifying post arrives while this run fails: the failure path allows one retry.
				await h.post("@f arrived during the failing run");
				posted.resolve();
			}
			t.fail("HTTP 429 RESOURCE_EXHAUSTED: quota");
		});
		await h.swarm({ action: "add", name: "f", brief: "x" });
		await until(() => h.member("f").failure?.count === 1, 1000, "failed");
		const m = h.member("f");
		expect(m.failure?.kind).toBe("quota");
		expect(m.briefPresented).toBe(true);
		await settle(30);
		expect(runs).toBe(1);
		await h.post("@f try again");
		await posted.promise;
		await until(() => m.failure?.count === 2, 1000, "second failure");
		await settle(40);
		// count reached 2: the post that arrived during the failed run is not retried automatically.
		expect(runs).toBe(2);
		expect(h.rt.coordinator.notices.filter(n => n.kind === "failure").length).toBe(2);
		await h.post("@f once more");
		await until(() => runs === 3, 1000, "explicit retry by name");
	});

	test("compaction reminder rides the next wake only after a completed compaction (I12)", async () => {
		h = new Harness();
		const seen: string[] = [];
		h.factory.brains.set("c", async t => {
			seen.push(t.input);
			await t.call("post_message", { text: "@coordinator ok" });
		});
		await h.swarm({ action: "add", name: "c", brief: "x" });
		await until(() => h.member("c").phase === "idle" && seen.length === 1, 1000, "idle");
		const s = h.session("c");
		s.emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false });
		expect(h.member("c").reminders.compacted).toBeUndefined();
		s.emit({ type: "auto_compaction_end", result: { summary: "x" }, aborted: false, willRetry: false });
		expect(h.member("c").reminders.compacted).toContain("compacted");
		await h.post("@c next");
		await until(() => seen.length === 2, 1000, "woken");
		expect(seen[1]).toContain("Your context was compacted");
		await until(() => h.member("c").reminders.compacted === undefined, 1000, "reminder consumed");
	});
});
