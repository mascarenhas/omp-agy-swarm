// The live host and paid checks on the loopback mock only. These are not paid receipts.
// bun test test/e2e/paid-loopback.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOmpBin } from "../../scripts/omp-bin.ts";
import type { Rule, Script, ToolCallSpec } from "./mock-llm/server.ts";
import { directBill, type Entry, evidence, jsonl, type PaidCtx, type Trace } from "./paid-evidence.ts";
import { HUB_DIRTY, HUB_MARKER } from "./paid-fixtures.ts";
import { runPaidCase, untouchedHubStartup } from "./paid-runner.ts";
import { tool } from "./scenario.ts";
import { NATIVE_PAID } from "./scenarios/paid-native.ts";

const call = (when: string, ...tools: ToolCallSpec[]): Rule => ({ when, reply: { tools } });
const say = (when: string, text: string): Rule => ({ when, reply: { text } });
const swarm = (action: string, args: Record<string, unknown> = {}) => tool("swarm", { action, ...args });
const add = (name: string, workspace = "inherit", model = "mock/worker-a") => swarm("add", { name, model, workspace, brief: `Perform ${name}'s loopback steps.` });
const wait = tool("swarm_wait");
const post = (text: string) => tool("post_message", { text });
const finish = (summary: string) => swarm("finish", { summary });
const bash = (command: string, async = false) => tool("bash", { command, async, timeout: 45 });
const accepted = '"completion":"accepted"';
const workerStart = (name: string) => `You are \`${name}\``;

const scripts: Record<string, Script> = {
	R9: {
		coord: { rules: [
			call("This is a native UI exercise", add("lens", "branch")),
			say('"added"', "Ready to open the Hub: R9-MAIN-READY."),
			say("permanently killed in the swarm", "R9-NOTICE-ACK"),
			call("Attempt one post_message addressed to @lens", post("@lens R9-RESUME-PROBE")),
			say(accepted, "R9-MAIN-COMPLETE. Hub check finished."),
			call('^tool:.*"seq":\\d+,"channel":"main"', tool("read_board")),
			call('^tool:.*"messages"', finish("R9 Hub check finished")),
		] },
		"worker-a": { rules: [
			call(workerStart("lens"), bash(`printf '%s\\n' '${HUB_DIRTY}' > dirty-hub.txt; cat hub-marker.txt`)),
			{ when: `^tool:.*${HUB_MARKER}`, reply: { text: HUB_MARKER, tools: [wait] } },
			call('"woke":"nudge"', wait),
		] },
	},
	R10: {
		coord: { rules: [
			call("Add one worker named asyncworker", add("asyncworker")),
			call('"added"', bash("/usr/bin/python3 barrier.py wait worker && echo HELD-WORKER")),
			call("HELD-WORKER", finish("R10 early probe")),
			say("Cannot finish.*background work|waiting on background work", "The held job prevents finish."),
			call("The swarm still has outstanding work", wait),
			call("R10-WORKER-ef328d8a", bash("/usr/bin/python3 barrier.py nonce main", true)),
			call("R10-MAIN-e174c301", finish("R10-MAIN-e174c301")),
			say(accepted, "R10 complete"),
			say('^tool:|^user:', "I will yield to native work."),
		] },
		"worker-a": { rules: [
			call(workerStart("asyncworker"), bash("/usr/bin/python3 barrier.py nonce worker", true)),
			call("R10-WORKER-ef328d8a", post("@coordinator [done] R10-WORKER-ef328d8a")),
		], default: { tools: [wait] } },
	},
	R11: {
		coord: { rules: [
			call("Add one worker named finder", swarm("scout", { model: "mock/worker-b:low" })),
			call('"scout":\\{"model":"mock/worker-b"', tool("eval", { language: "js", title: "Measure a loopback side call",
				code: 'const probe = await completion("R11-AUX-PROBE", { model: "smol" }); console.log(await probe.wait());' })),
			call("R11-AUX-RESULT", add("finder")),
			call("FACT-A-38f420a1.*FACT-B-b16a0ef2", finish("Both facts verified")),
			say(accepted, "R11 complete"),
		], default: { tools: [wait] } },
		"worker-a": { rules: [
			call(workerStart("finder"), tool("task", { context: "Locate facts in this fixture only", tasks: [
				{ name: "Alpha", agent: "scout", task: "Read facts/alpha.txt and report its path:line and exact nonce", solutionSpace: "one fact" },
				{ name: "Beta", agent: "scout", task: "Read facts/beta.txt and report its path:line and exact nonce", solutionSpace: "one fact" },
			] })),
			{ when: "FACT-A-38f420a1|FACT-B-b16a0ef2", whenAny: "(?=.*FACT-A-38f420a1)(?=.*FACT-B-b16a0ef2)", times: 1,
				reply: { tools: [post("@coordinator [done] facts/alpha.txt:2 FACT-A-38f420a1; facts/beta.txt:3 FACT-B-b16a0ef2")] } },
		], default: { tools: [wait] } },
		"worker-b": { rules: [
			{ when: "facts/alpha.txt", reply: { delay: 500, tools: [tool("read", { path: "facts/alpha.txt" })] } },
			{ when: "facts/beta.txt", reply: { delay: 500, tools: [tool("read", { path: "facts/beta.txt" })] } },
			say("alpha: FACT-A", "facts/alpha.txt:2 FACT-A-38f420a1"),
			say("beta: FACT-B", "facts/beta.txt:3 FACT-B-b16a0ef2"),
		] },
		plain: { rules: [say("R11-AUX-PROBE", "R11-AUX-RESULT")] },
	},
	R12: {
		coord: { rules: [
			call("Add exactly two workers", add("cancelled")),
			call('"added":\\[\\{"name":"cancelled"', add("abandoned", "inherit", "mock/worker-b")),
			call('"added":\\[\\{"name":"abandoned"', bash("/usr/bin/python3 barrier.py wait both && echo BOTH-HELD")),
			call("BOTH-HELD", swarm("kill", { name: "cancelled" })),
			call('"killed":\\["cancelled"\\]', bash("/usr/bin/python3 barrier.py wait survivor && echo SURVIVOR-HELD")),
			call("SURVIVOR-HELD", swarm("finish", { abandon: true, summary: "R12 cancellation fence" })),
			say(accepted, "R12 complete"),
		] },
		"worker-a": { rules: [call(workerStart("cancelled"), bash("/usr/bin/python3 barrier.py cancel cancelled", true))], default: { tools: [wait] } },
		"worker-b": { rules: [call(workerStart("abandoned"), bash("/usr/bin/python3 barrier.py cancel abandoned", true))], default: { tools: [wait] } },
	},
};

test("R11 direct bill excludes transcript mirrors, child aggregates and discarded-turn replacements", () => {
	const assistants = [{ cost: 1, tokens: 5 }, { cost: 2, tokens: 10 }];
	const journal: Entry[] = [
		{ type: "message", message: { role: "assistant", usage: { totalTokens: 5, cost: { total: 1 } } } },
		{ type: "model_usage", purpose: "discarded-turn", usage: { totalTokens: 10, cost: { total: 2 } } },
		{ type: "message", message: { role: "toolResult", usage: { totalTokens: 50, cost: { total: 32 } } } },
		{ type: "model_usage", purpose: "completion", usage: { totalTokens: 20, cost: { total: 4 } } },
		{ type: "model_usage", purpose: "judge", usage: { totalTokens: 7, cost: { total: 0 } } },
	];
	expect(directBill(journal, assistants)).toEqual({ cost: 7, unpriced: 1 });
});

test("R9 missing metrics prove zero spend only before any input and materialization", () => {
	const T = mkdtempSync(join(tmpdir(), "swarm-r9-startup-"));
	const sessionFile = join(T, "sessions", "main.jsonl");
	const c: PaidCtx = { T, swarm: join(T, "sessions", "main", "swarm"), repo: join(T, "repo"),
		trace: join(T, "evidence.jsonl"), stdout: "", stderr: "", code: 143 };
	const rows: Trace[] = [
		{ kind: "root", at: 1, swarm: c.swarm, sessionFile, agentDir: T, agentDb: join(T, "agent.db"), terminalSessionsDir: T },
		{ kind: "ref", at: 1, id: "Main", generation: 1, status: "running", change: "initial", attached: true, sessionFile },
	];
	try {
		expect(untouchedHubStartup(c, rows)).toBe(true);
		expect(untouchedHubStartup(c, [])).toBe(false);
		expect(untouchedHubStartup(c, [...rows, { kind: "harness", at: 2, action: "hub-launch-input" }])).toBe(false);
		mkdirSync(join(T, "sessions"));
		writeFileSync(sessionFile, "{}\n");
		expect(untouchedHubStartup(c, rows)).toBe(false);
	} finally {
		rmSync(T, { recursive: true, force: true });
	}
});

for (const scenario of NATIVE_PAID) {
	test.skipIf(scenario.id === "R12" && process.platform !== "linux")(`${scenario.id} loopback smoke (no paid evidence)`, async () => {
		const result = await runPaidCase(scenario, { omp: resolveOmpBin(), cap: 1, deadline: performance.now() + 55_000,
			// Reproduce the paid profile's glyph, rather than relying on the loopback default.
			loopbackSymbolPreset: scenario.id === "R9" ? "nerd" : undefined,
			scoutOverride: scenario.id === "R11" ? "mock/worker-b:low" : undefined, loopback: scripts[scenario.id]! });
		// The two model-route failures are intentional: loopback is not an authorized paid scout route.
		const failures = result.k.failures.filter(f => !(scenario.id === "R11" && f.startsWith("actual priced usage on an approved route:")));
		expect(failures, `Retained loopback artifacts: ${result.c.T}`).toEqual([]);
		if (scenario.id === "R11") {
			expect(result.k.failures).toHaveLength(2);
			const transcript = evidence(result.c).find(row => row.kind === "root")?.sessionFile;
			expect(transcript && jsonl<Entry>(transcript).some(row => row.type === "model_usage" && (row.usage?.cost?.total ?? 0) > 0)).toBe(true);
		}
		rmSync(result.c.T, { recursive: true, force: true });
	}, 90_000);
}
