import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RosterFile } from "../../src/board/types.ts";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { type Ctx, readJson } from "../e2e/check.ts";
import { MockLlm, type Script } from "../e2e/mock-llm/server.ts";
import { REPO, runOmp, tool } from "../e2e/scenario.ts";
import { paddedAdd } from "../fixtures/zero-filled.ts";
import { until } from "../helpers/harness.ts";

const finish = tool("swarm", { action: "finish", summary: "Scout evidence verified." });
const probe = (action: string) => tool("scouts_probe", { action });
const add = (name: string, brief: string) => tool("swarm", { action: "add", name, brief, model: "mock/worker-a" });
type TaskItem = { name: string; task: string; agent: string; solutionSpace: string };
const scout = (name: string, task: string, agent = "scout"): TaskItem => ({ name, task, agent, solutionSpace: "Report the requested marker only." });
const batch = (...tasks: TaskItem[]) => tool("task", { context: "Independent read-only investigations.", tasks });
const readRows = (log: string): Record<string, unknown>[] => existsSync(log)
	? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

async function compiled(script: Script, options: {
	config: string;
	ceiling?: string;
	prep?: (c: Ctx) => void;
	held?: { resolve(): void };
	releaseAt?: string;
	earlyBill?: boolean;
	exitCode?: number;
	captureWorkerLedger?: boolean;
	highCostModel?: boolean;
}) {
	const root = mkdtempSync(join(tmpdir(), "omp-native-scouts-"));
	const log = join(root, "scouts.log");
	const requestMark = join(root, "scout-requested");
	const mock = new MockLlm(script);
	const c: Ctx = { id: "scouts", T: root, repo: join(root, "work"), swarm: join(root, "swarm"), agent: join(root, "agent"), sessions: join(root, "sessions"), mock, runs: [] };
	try {
		const home = join(root, "home");
		for (const dir of [c.repo, c.agent, home]) mkdirSync(dir);
		writeFileSync(join(c.agent, "config.yml"), options.config);
		options.prep?.(c);
		mock.start();
		const run = runOmp(c, {
			prompt: "start-native-scouts",
			pluginArgs: ["--no-extensions", "-e", join(REPO, "test/fixtures/scouts-probe.ts"), "-e", REPO],
			args: ["--max-time", "23", "--approval-mode", "yolo"],
			env: {
				SWARM_SCOUT_LOG: log, HOME: home, PI_CONFIG_DIR: ".omp", OMP_PROFILE: "", PI_PROFILE: "",
				OMP_SWARM_MAX_COST_USD: options.ceiling, OMP_SWARM_WORKER_TOOLS: undefined,
				SWARM_SCOUT_EARLY_BILL: options.earlyBill ? "1" : undefined,
				SWARM_SCOUT_HIGH_COST: options.highCostModel ? "1" : undefined,
				SWARM_SCOUT_REQUEST_MARK: requestMark,
				XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
				XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
			},
		}, false);
		let barrierError: unknown;
		if (options.held) {
			try {
				let requested = false;
				await until(() => {
					if (!requested && mock.log.some(r => r.model === "worker-b" && r.rule === 0)) {
						requested = true;
						writeFileSync(requestMark, "");
					}
					return readRows(log).some(r => r.stage === (options.releaseAt ?? "held"));
				}, 10_000, "compiled scout barrier");
			}
			catch (error) { barrierError = error; }
			finally { options.held.resolve(); }
		}
		const result = await run;
		const rows = readRows(log);
		const requests = mock.requests();
		const diagnostic = JSON.stringify({ result, rows, requests: requests.map(r => [r.model, r.rule, r.last]) });
		expect(barrierError, diagnostic).toBeUndefined();
		expect(result.code, diagnostic).toBe(options.exitCode ?? 0);
		const roster = readJson<RosterFile>(join(c.swarm, "members.json"));
		const file = roster?.members.worker?.session_file;
		const workerLedger = options.captureWorkerLedger && file
			? readFileSync(join(c.swarm, "sessions", file), "utf8").trim().split("\n").flatMap(line => {
				const entry = JSON.parse(line) as SessionEntry;
				if (entry.type === "model_usage" && entry.purpose !== "discarded-turn") return [entry.usage];
				return entry.type === "message" && entry.message.role === "assistant" ? [entry.message.usage] : [];
			})
			: [];
		return { ...result, rows, requests, diagnostic, roster, workerLedger,
			metrics: readJson<{ spend: { cost: number; unknown?: string }; outcome: { value: string } }>(join(c.swarm, "metrics.json")),
			config: readFileSync(join(c.agent, "config.yml"), "utf8") };
	} finally {
		options.held?.resolve();
		mock.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

const concurrentConfig = `task:
  batch: true
  maxConcurrency: 2
  agentModelOverrides:
    scout: [mock/worker-b:low, mock/plain]
    task: mock/plain
modelRoles:
  smol: mock/plain
  judge: mock/plain
eval:
  autoProvision: false
  autoBackground:
    enabled: false
`;
const threadedConfig = concurrentConfig.replace("  maxConcurrency: 2\n", "  maxConcurrency: 10\n  workerThreads: 1\n") + "async:\n  maxJobs: 16\n";

test("compiled worker batches native scouts, wakes from its own results, and bills direct and child requests once", async () => {
	const held = Promise.withResolvers<void>();
	const refused = `
for (const profile of ["task", "extra"]) {
  try { await agent("REFUSED-EVAL-SCOUT", { agent: profile, label: "blocked" }); }
  catch (err) { console.log(String(err)); }
}
try { await workpool("extra", { name: "blocked-pool" }); }
catch (err) { console.log(String(err)); }
const completed = await completion("EVAL-AUX-SCOUT-BILL", { model: "smol" });
console.log(await completed.wait());
const judgement = await judge("EVAL-JUDGE-SCOUT-BILL", { ok: { type: "bool", instructions: "Is the marker present?" } });
console.log("JUDGE-AUX-RESULT", judgement.ok.bool);
`;
	const { diagnostic, rows, requests, roster, metrics } = await compiled({
		coord: { rules: [
			{ when: "^user:.*start-native-scouts$", reply: { tools: [add("worker", "Run the scout batch.")] } },
			{ when: '"added"', reply: { tools: [probe("held")] } },
			{ when: "SCOUT-BATCH-DONE", whenNot: "SCOUTS-PROBE-settled|Cannot finish", times: 1, reply: { tools: [probe("settled")] } },
			{ when: "SCOUTS-PROBE-settled", reply: { tools: [tool("swarm", { action: "kill", name: "worker" })] } },
			{ when: '"killed":\\["worker"\\]', reply: { tools: [probe("retired")] } },
			{ when: "SCOUTS-PROBE-retired", reply: { tools: [finish] } },
			{ when: '"completion":"accepted"', reply: { text: "FINISHED-SCOUTS" } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [batch(scout("block-task", "REFUSED-NATIVE-SCOUT", "task"))] } },
			{ when: "Cannot spawn 'task'", whenNot: "Cannot spawn 'extra'", times: 1, reply: { tools: [batch(scout("block-extra", "REFUSED-NATIVE-SCOUT", "extra"))] } },
			{ when: "Cannot spawn 'extra'", whenNot: "EVAL-AUX-RESULT", times: 1, reply: { tools: [tool("eval", { language: "js", title: "Check scout policy and completion bill", code: refused })] } },
			{ when: "EVAL-AUX-RESULT", times: 1, reply: { tools: [batch(scout("Alpha", "SCOUT-ALPHA"), scout("Beta", "SCOUT-BETA"), scout("Gamma", "SCOUT-GAMMA"))] } },
			{ when: "RESULT-GAMMA", times: 1, reply: { tools: [tool("post_message", { text: "@coordinator SCOUT-BATCH-DONE" })] } },
		], default: { text: "Waiting for native results." } },
		"worker-b": { rules: [
			{ when: "SCOUT-ALPHA", reply: { text: "RESULT-ALPHA", wait: held.promise } },
			{ when: "SCOUT-BETA", reply: { text: "RESULT-BETA", wait: held.promise } },
			{ when: "SCOUT-GAMMA", reply: { text: "RESULT-GAMMA" } },
		] },
		plain: { rules: [
			{ when: "EVAL-AUX-SCOUT-BILL", reply: { text: "EVAL-AUX-RESULT" } },
			{ when: "EVAL-JUDGE-SCOUT-BILL", reply: { text: "yes" } },
		] },
	}, {
		config: concurrentConfig, held, ceiling: "1", earlyBill: true,
		prep: c => {
			mkdirSync(join(c.repo, ".omp", "agents"), { recursive: true });
			writeFileSync(join(c.repo, ".omp", "agents", "extra.md"), "---\nname: extra\ndescription: A valid non-scout project profile\nmodel: mock/plain\n---\nExtra project profile.\n");
		},
	});
	const paused = rows.find(r => r.stage === "held");
	expect(paused, diagnostic).toMatchObject({ workerId: "swarm~worker", children: ["swarm~worker.Alpha", "swarm~worker.Beta"] });
	expect(paused?.jobs, diagnostic).toEqual([false, false, true].map(queued => ({ ownerId: "swarm~worker", status: "running", queued })));
	const regs = rows.filter(r => r.stage === "registered");
	expect(regs.map(r => [r.id, r.parentId]), diagnostic).toEqual(["Alpha", "Beta", "Gamma"].map(n => [`swarm~worker.${n}`, "swarm~worker"]));
	expect(rows.findIndex(r => r.id === "swarm~worker.Gamma" && r.stage === "registered"), diagnostic)
		.toBeGreaterThan(rows.findIndex(r => r.stage === "status_changed" && r.status === "idle"));
	expect(rows.some(r => r.stage === "worker-result" && JSON.stringify(r.content).includes("RESULT-GAMMA")), diagnostic).toBe(true);
	const last = rows.find(r => r.stage === "settled") as { directCost: number; requests: { purpose: string; tokens: number; cost: number }[]; jobs: string[]; childMetrics: { parentId: string; model: string; status: string; metrics: { cost: number; requests: number } }[] } | undefined;
	const child = rows.filter(r => r.stage === "scout-bill");
	expect(child, diagnostic).toHaveLength(3);
	expect(last?.requests.filter(r => r.purpose === "completion"), diagnostic).toHaveLength(1);
	expect(last?.jobs, diagnostic).toEqual(["completed", "completed", "completed"]);
	expect(last?.childMetrics.map(r => [r.parentId, r.status, r.metrics.requests]), diagnostic).toEqual(Array(3).fill(["swarm~worker", "completed", 1]));
	const rawChildPrice = child.reduce((sum, row) => sum + Number(row.price), 0);
	expect(last?.childMetrics.reduce((sum, row) => sum + row.metrics.cost, 0), diagnostic).toBeCloseTo(rawChildPrice, 10);
	const early = rows.filter(r => r.stage === "early-bill");
	expect(early, diagnostic).toHaveLength(3);
	const earlyPrice = early.reduce((sum, row) => sum + Number(row.price), 0);
	const earlyTokens = early.reduce((sum, row) => sum + Number(row.tokens), 0);
	expect(roster?.members.worker?.stats?.cost, diagnostic).toBeCloseTo((last?.directCost ?? 0) + rawChildPrice + earlyPrice, 10);
	expect(roster?.members.worker?.stats?.tokens, diagnostic)
		.toBe((last?.requests.reduce((sum, request) => sum + request.tokens, 0) ?? 0) + child.reduce((sum, row) => sum + Number(row.tokens), 0) + earlyTokens);
	expect(requests.filter(r => r.model === "worker-b" && r.rule >= 0).map(r => r.reasoning_effort), diagnostic).toEqual(["low", "low", "low"]);
	expect(requests.some(r => /REFUSED-(NATIVE|EVAL)-SCOUT/.test(r.last) && r.roles.at(-1) === "user"), diagnostic).toBe(false);
	expect(requests.some(r => /Cannot spawn 'task'.*Cannot spawn 'extra'/s.test(r.last) && r.last.includes("EVAL-AUX-RESULT")), diagnostic).toBe(true);
	expect(requests.some(r => r.last.includes("JUDGE-AUX-RESULT 1")), diagnostic).toBe(true);
	expect(rows.find(r => r.stage === "retired"), diagnostic).toMatchObject({ remainingRefs: [] });
	expect(metrics?.spend.unknown, diagnostic).toBeUndefined();
	expect(metrics?.outcome.value, diagnostic).toBe("complete");
}, 60_000);

test("compiled scout billing follows exact nested parents, deduplicates old generations and fails closed", async () => {
	const { diagnostic, metrics, roster, rows, stdout, requests } = await compiled({
		coord: { rules: [
			{ when: "^user:.*start-native-scouts$", reply: { tools: [add("worker", "Stand by.")] } },
			{ when: '"added"', reply: { tools: [probe("settled")] } },
			{ when: "SCOUTS-PROBE-settled", reply: { tools: [probe("inject")] } },
			{ when: "SCOUTS-PROBE-inject", reply: { tools: [probe("denied")] } },
			{ when: "SCOUTS-PROBE-denied", reply: { tools: [add("denied", "This must not start.")] } },
		] },
		"worker-a": { rules: [{ when: "You are `worker`", reply: { tools: [tool("post_message", { text: "Standing by." })] } }] },
	}, { config: concurrentConfig, ceiling: "1" });
	const before = rows.find(r => r.stage === "settled");
	expect(rows.find(r => r.stage === "injected"), diagnostic).toMatchObject({ workerId: "swarm~worker" });
	expect(roster?.members.worker?.stats?.cost, diagnostic).toBeCloseTo(Number(before?.directCost) + 0.005, 10);
	expect(roster?.members.denied, diagnostic).toBeUndefined();
	expect(metrics?.outcome.value, diagnostic).toBe("incomplete");
	expect(metrics?.spend.unknown, diagnostic).toMatch(/worker.*mock\/synthetic.*4 tokens without a price/);
	expect(rows.find(row => row.stage === "denied"), diagnostic).toMatchObject({
		message: expect.stringMatching(/Cannot spawn 'scout'/), eval: expect.stringContaining("unknown spend"),
	});
	expect(requests.some(r => r.last.includes("CAP-REFUSED-EVAL")), diagnostic).toBe(false);
	expect(stdout, diagnostic).not.toContain("This must not start");
}, 60_000);

test("compiled scoped scout overrides preserve native profile discovery, settings snapshots, and non-spawning roles", async () => {
	const { diagnostic, rows, requests, config, roster, stdout } = await compiled({
		coord: { rules: [
			{ when: "^user:.*start-native-scouts$", reply: { tools: [tool("swarm", { ...paddedAdd, action: "scout", model: "mock/worker-b:low" })] } },
			{ when: '"scout":\\{"model":"mock/worker-b","effort":"low"', reply: { tools: [add("worker", "Wait for the existing-worker assignment.")] } },
			{ when: '"added":\\[\\{"name":"worker"', reply: { tools: [tool("swarm", { action: "scout", effort: "high" })] } },
			{ when: '"scout":\\{"effort":"high"', reply: { tools: [add("fresh", "Run a new-worker scout."),
				tool("swarm", { action: "add", role: "narrator", model: "mock/worker-a" }), tool("swarm", { action: "add", role: "monitor", model: "mock/worker-a" })] } },
			{ when: '"added"', whenAny: '"effort":"high"', times: 1, reply: { tools: [tool("post_message", { text: "@worker Run the old-worker scout OLD-REQUEST." }), probe("settings")] } },
			{ when: "SCOUTS-PROBE-settings", reply: { tools: [tool("eval", { language: "js", title: "Measure a coordinator completion",
				code: 'const response = await completion("MAIN-AUX-REQUEST", { model: "smol" }); console.log(await response.wait());' })] } },
			{ when: "MAIN-AUX-REPLY", reply: { tools: [batch(scout("MainScout", "COORD-SCOUT"), scout("Other", "COORD-OTHER", "extra"))] } },
			{ when: "PROJECT-OLD|PROJECT-NEW|PROJECT-MAIN", whenAny: "(?=.*PROJECT-OLD)(?=.*PROJECT-NEW)(?=.*PROJECT-MAIN)", times: 1, reply: { tools: [probe("park")] } },
			{ when: "SCOUTS-PROBE-park", reply: { tools: [tool("swarm", { action: "revive", name: "worker" })] } },
			{ when: '"reviving":\\["worker"\\]', reply: { tools: [tool("post_message", { text: "@worker Run the revived scout REVIVED-REQUEST." })] } },
			{ when: "PROJECT-REVIVED", whenNot: "Cannot finish", reply: { tools: [finish] } },
			{ when: '"completion":"accepted"', reply: { text: "ROUTING-FINISHED" } },
			{ when: "^tool:|^user:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `fresh`", reply: { tools: [batch(scout("New", "NEW-SCOUT"))] } },
			{ when: "OLD-REQUEST", reply: { tools: [batch(scout("Old", "OLD-SCOUT"))] } },
			{ when: "REVIVED-REQUEST", times: 1, reply: { tools: [batch(scout("Revived", "REVIVED-SCOUT"))] } },
			{ when: "PROJECT-OLD", times: 1, reply: { tools: [tool("post_message", { text: "@coordinator PROJECT-OLD" })] } },
			{ when: "PROJECT-NEW", times: 1, reply: { tools: [tool("post_message", { text: "@coordinator PROJECT-NEW" })] } },
			{ when: "PROJECT-REVIVED", times: 1, reply: { tools: [tool("post_message", { text: "@coordinator PROJECT-REVIVED" })] } },
		], default: { tools: [tool("swarm_wait")] } },
		"worker-b": { rules: [
			{ when: "OLD-SCOUT", reply: { text: "PROJECT-OLD" } },
			{ when: "NEW-SCOUT", reply: { text: "PROJECT-NEW" } },
			{ when: "COORD-SCOUT", reply: { text: "PROJECT-MAIN" } },
			{ when: "REVIVED-SCOUT", reply: { text: "PROJECT-REVIVED" } },
		] },
		plain: { rules: [
			{ when: "COORD-OTHER", reply: { text: "UNROUTED-OTHER" } },
			{ when: "MAIN-AUX-REQUEST", reply: { text: "MAIN-AUX-REPLY" } },
		] },
	}, {
		config: concurrentConfig,
		prep: c => {
			for (const [root, tools] of [[join(c.repo, ".omp"), "read"], [c.agent, "grep"]] as const) {
				mkdirSync(join(root, "agents"), { recursive: true });
				writeFileSync(join(root, "agents", "scout.md"), `---\nname: scout\ndescription: Native shadow scout\ntools: ${tools}\nmodel: mock/plain\n---\nReport the requested marker.\n`);
			}
			writeFileSync(join(c.repo, ".omp", "agents", "extra.md"), "---\nname: extra\ndescription: Native unmodified sibling\ntools: read\nmodel: mock/plain\n---\nReport the requested marker.\n");
		},
	});
	const settings = rows.find(r => r.stage === "settings")?.roles as { name: string; tools: string[]; models: Record<string, unknown> }[] | undefined;
	expect(settings?.map(r => [r.name, r.tools?.includes("task"), r.tools?.includes("wait")]), diagnostic)
		.toEqual([["worker", true, false], ["fresh", true, false], ["narrator", false, false], ["monitor", false, false]]);
	expect(settings?.[0]?.models, diagnostic).toMatchObject({ scout: "mock/worker-b:low", task: "mock/plain" });
	expect(settings?.[1]?.models, diagnostic).toMatchObject({ scout: ["mock/worker-b:low", "mock/plain"], task: "mock/plain" });
	const served = requests.filter(r => r.model === "worker-b" && r.rule >= 0);
	expect(rows.find(r => r.stage === "park"), diagnostic).toMatchObject({ disposed: true, missing: true });
	expect(served.map(r => [r.rule, r.reasoning_effort]).sort(), diagnostic)
		.toEqual([[0, "low"], [1, "high"], [2, "low"], [3, "high"]]);
	expect(requests.some(r => r.model === "plain" && r.rule === 0), diagnostic).toBe(true);
	expect(served.every(r => r.tools.includes("read") && !r.tools.includes("grep")), diagnostic).toBe(true);
	expect(roster?.scout, diagnostic).toEqual({ effort: "high" });
	const mainDirect = rows.find(r => r.stage === "main-bill")?.direct as { purpose: string; price: number; tokens: number }[];
	const mainScouts = rows.filter(r => r.stage === "main-scout-bill");
	expect(mainScouts, diagnostic).toHaveLength(1);
	expect(mainDirect.filter(row => row.purpose === "completion"), diagnostic).toHaveLength(1);
	expect(roster?.members.coordinator?.stats?.cost, diagnostic)
		.toBeCloseTo([...mainDirect, ...mainScouts].reduce((sum, bill) => sum + Number(bill.price), 0), 10);
	expect(roster?.members.coordinator?.stats?.tokens, diagnostic)
		.toBe([...mainDirect, ...mainScouts].reduce((sum, bill) => sum + Number(bill.tokens), 0));
	expect(config, diagnostic).toBe(concurrentConfig);
	expect(stdout, diagnostic).toContain("ROUTING-FINISHED");
}, 60_000);

test("compiled effort-only scout follows a worker model switch and preserves approved eval model pins", async () => {
	const { diagnostic, rows, requests, roster } = await compiled({
		coord: { rules: [
			{ when: "^user:.*start-native-scouts$", reply: { tools: [tool("swarm", { action: "scout", effort: "high" })] } },
			{ when: '"scope":"newly added or revived workers"', reply: { tools: [add("worker", "Wait for a model switch.")] } },
			{ when: "READY-FOR-SWITCH", times: 1, reply: { tools: [tool("swarm", { action: "model", name: "worker", model: "mock/worker-b", effort: "low" })] } },
			{ when: '"model":"mock/worker-b"', whenNot: '"added"', times: 1, reply: { tools: [tool("post_message", { text: "@worker RUN-EVAL-SCOUT" })] } },
			{ when: "EVAL-SCOUT-DONE", times: 1, reply: { tools: [probe("settled")] } },
			{ when: "SCOUTS-PROBE-settled", reply: { tools: [finish] } },
			{ when: '"completion":"accepted"', reply: { text: "Switched scout verified." } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [tool("post_message", { text: "@coordinator READY-FOR-SWITCH" })] } },
		], default: { tools: [tool("swarm_wait")] } },
		"worker-b": { rules: [
			{ when: "SWITCHED-EVAL-CHILD", reply: { text: "EVAL-CHILD-RESULT" } },
			{ when: "RUN-EVAL-SCOUT", reply: { tools: [tool("eval", { language: "js", title: "Use a native scout",
				code: `const child = await agent("SWITCHED-EVAL-CHILD", { agent: "scout", label: "Eval" });
console.log(await child.wait());
const pinned = await agent("PINNED-EVAL-CHILD", { agent: "scout", label: "Pinned", model: "mock/worker-limited:low" });
console.log(await pinned.wait());` })] } },
			{ when: "PINNED-CHILD-RESULT", times: 1, reply: { tools: [tool("post_message", { text: "@coordinator EVAL-SCOUT-DONE" })] } },
			{ when: '^tool: \\{"seq":', reply: { text: "Waiting after reporting." } },
		], default: { tools: [tool("swarm_wait")] } },
		"worker-limited": { rules: [{ when: "PINNED-EVAL-CHILD", reply: { text: "PINNED-CHILD-RESULT" } }] },
	}, {
		config: concurrentConfig.replace("    scout: [mock/worker-b:low, mock/plain]\n", "")
			.replace("  maxConcurrency: 2\n", '  maxConcurrency: 2\n  perCallModel: "eval"\n')
			.replace("modelRoles:\n", "modelRoles:\n  slow: mock/worker-limited\n"),
		prep: c => {
			mkdirSync(join(c.repo, ".omp", "agents"), { recursive: true });
			writeFileSync(join(c.repo, ".omp", "agents", "scout.md"), "---\nname: scout\ndescription: Inherit caller model\ntools: read\n---\nReturn only a short text result.\n");
		},
	});
	const children = rows.filter(r => r.stage === "scout-bill");
	expect(children, diagnostic).toHaveLength(2);
	expect(rows.find(r => r.stage === "registered"), diagnostic).toMatchObject({ parentId: "swarm~worker" });
	const child = requests.find(r => r.rule === 0 && r.last.includes("SWITCHED-EVAL-CHILD") && r.roles.at(-1) === "user");
	expect(child, diagnostic).toMatchObject({ model: "worker-b", reasoning_effort: "high" });
	expect(requests.find(r => r.last.includes("PINNED-EVAL-CHILD") && r.roles.at(-1) === "user"), diagnostic)
		.toMatchObject({ model: "worker-limited", reasoning_effort: "high" });
	expect(roster?.members.worker?.stats?.cost, diagnostic)
		.toBeCloseTo(Number(rows.find(r => r.stage === "settled")?.directCost) + children.reduce((sum, row) => sum + Number(row.price), 0), 10);
}, 60_000);

test("compiled operator revive bills only new scout journal entries from the reopened transcript", async () => {
	const { diagnostic, rows, roster, metrics } = await compiled({
		coord: { rules: [
			{ when: "^user:.*start-native-scouts$", reply: { tools: [add("worker", "Run a native scout.")] } },
			{ when: "WARM-SCOUT-DONE", times: 1, reply: { tools: [probe("revive-child")] } },
			{ when: "SCOUTS-PROBE-revive-child", reply: { tools: [probe("settled")] } },
			{ when: "SCOUTS-PROBE-settled", reply: { tools: [finish] } },
			{ when: '"completion":"accepted"', reply: { text: "Revived scout verified." } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [batch(scout("Warm", "SCOUT-WARM-FIRST"))] } },
			{ when: "WARM-SCOUT-RESULT", times: 1, reply: { tools: [tool("post_message", { text: "@coordinator WARM-SCOUT-DONE" })] } },
		], default: { text: "Standing by." } },
		"worker-b": { rules: [
			{ when: "SCOUT-WARM-FIRST", reply: { text: "WARM-SCOUT-RESULT" } },
			{ when: "SCOUT-WARM-SECOND", reply: { text: "WARM-SCOUT-REVIVED" } },
		] },
	}, { config: concurrentConfig, earlyBill: true, ceiling: "1" });
	expect(rows.find(row => row.stage === "revived-child"), diagnostic).toMatchObject({
		parked: true, freshSession: true, sameRef: true, sameTranscript: true,
	});
	const early = rows.filter(row => row.stage === "early-bill");
	const chat = rows.filter(row => row.stage === "scout-bill");
	expect(early, diagnostic).toHaveLength(2);
	expect(chat, diagnostic).toHaveLength(2);
	const direct = rows.find(row => row.stage === "settled");
	expect(roster?.members.worker?.stats?.cost, diagnostic)
		.toBeCloseTo(Number(direct?.directCost) + [...early, ...chat].reduce((sum, bill) => sum + Number(bill.price), 0), 10);
	expect(metrics?.outcome.value, diagnostic).toBe("complete");
}, 60_000);

test("compiled worker scout cold revival cannot bypass a spent swarm cap", async () => {
	const { diagnostic, rows, requests, metrics } = await compiled({
		coord: { rules: [
			{ when: "^user:.*start-native-scouts$", reply: { tools: [add("worker", "Run the cold-revival scout.")] } },
			{ when: "COLD-SCOUT-DONE", times: 1, reply: { tools: [probe("cold-child")] } },
			{ when: "SCOUTS-PROBE-cold-child", reply: { text: "Cold revival checked." } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [batch(scout("Cold", "COLD-SCOUT-FIRST"), scout("Parked", "COLD-SCOUT-FIRST"))] } },
			{ when: "COLD-SCOUT-RESULT", times: 1, reply: { tools: [tool("post_message", { text: "@coordinator COLD-SCOUT-DONE" })] } },
		], default: { text: "Standing by." } },
		"worker-b": { rules: [{ when: "COLD-SCOUT-FIRST", reply: { text: "COLD-SCOUT-RESULT" } }] },
	}, { config: concurrentConfig, ceiling: "1" });
	expect(rows.find(row => row.stage === "cold-child"), diagnostic).toMatchObject({
		transcript: true, removed: true, refusal: expect.stringContaining('Unknown agent "swarm~worker.Cold"'),
		parkedRemoved: true, parkedRefusal: expect.stringContaining("replaced or became terminal"),
	});
	expect(requests.some(r => /(?:COLD|PARKED)-SCOUT-AFTER-CAP/.test(r.last)), diagnostic).toBe(false);
	expect(metrics?.outcome.value, diagnostic).toBe("incomplete");
}, 60_000);

for (const parent of ["worker", "main"] as const) {
	test(`compiled ${parent} scout bills remote journal deltas once${parent === "main" ? " and fails closed" : " without a ceiling"}`, async () => {
		const held = Promise.withResolvers<void>();
		const count = parent === "main" ? 10 : 9;
		const fanout = batch(...Array.from({ length: count }, (_, i) => scout(`Thread${i}`, `REMOTE-HELD-${i}`)));
		const collect = probe(`remote-${parent}`);
		const { diagnostic, rows, roster, workerLedger, metrics, config } = await compiled({
			coord: { rules: [
				{ when: "^user:.*start-native-scouts$", reply: { tools: [parent === "main"
					? tool("swarm", { action: "title", title: "Remote Main scouts" }) : add("worker", "Run the threaded fanout.")] } },
				{ when: '"title":"Remote Main scouts"', reply: { tools: [fanout] } },
				{ when: "Spawned 10 background agents|\"added\"", reply: { tools: [collect] } },
				{ when: "SCOUTS-PROBE-remote-", reply: { tools: [tool("swarm", { action: "status" })] } },
			], default: { text: "Threaded billing checked." } },
			"worker-a": { rules: [{ when: "You are `worker`", reply: { tools: [fanout] } }], default: { text: "Waiting for scouts." } },
			"worker-b": { rules: [{ when: "REMOTE-HELD-", reply: { text: "THREADED-SCOUT-RESULT", wait: held.promise } }] },
		}, {
			config: threadedConfig, held,
			releaseAt: parent === "main" ? "remote-status" : "remote-billed",
			ceiling: parent === "main" ? "1" : undefined, captureWorkerLedger: parent === "worker",
		});
		expect(rows.find(row => row.stage === "remote-billed"), diagnostic).toMatchObject({
			parentId: parent === "main" ? "Main" : "swarm~worker",
			home: expect.stringMatching(/^w\d+$/), populated: 2, live: true,
		});
		if (parent === "worker") expect(rows.find(row => row.stage === "remote-billed")?.local, diagnostic).toBe(8);
		const raw = rows.filter(row => row.stage === (parent === "main" ? "main-scout-bill" : "scout-bill"));
		const direct = parent === "main" ? rows.find(row => row.stage === "main-bill")?.direct as { price: number; tokens: number }[]
			: workerLedger.map(usage => ({ price: usage.cost.total, tokens: usage.totalTokens }));
		const stats = roster?.members[parent === "main" ? "coordinator" : "worker"]?.stats;
		expect(stats?.cost, diagnostic).toBeCloseTo([...raw, ...direct].reduce((sum, row) => sum + Number(row.price), 0.1), 10);
		expect(stats?.tokens, diagnostic).toBe([...raw, ...direct].reduce((sum, row) => sum + Number(row.tokens), 14));
		if (parent === "main") {
			expect(metrics?.outcome.value, diagnostic).toBe("incomplete");
			expect(metrics?.spend.unknown, diagnostic).toMatch(/mock-remote\/worker-b reported 7 tokens without a price/);
		} else expect(metrics?.spend.unknown, diagnostic).toBeUndefined();
		expect(config, diagnostic).toContain("workerThreads: 1");
	}, 60_000);
}

test("compiled capped worker scouts deny the second paid completion inside one eval cell", async () => {
	const held = Promise.withResolvers<void>();
	const fanout = batch(
		...Array.from({ length: 8 }, (_, i) => scout(`Hold${i}`, `CHAIN-HOLD-${i}`)),
		scout("Chain", "RUN-CAPPED-CHAIN"),
	);
	const code = `
const first = await completion("FIRST-CAPPED-AUX", { model: "slow" });
console.log("FIRST-OK", await first.wait());
try {
  const second = await completion("SECOND-CAPPED-AUX", { model: "slow" });
  console.log("UNEXPECTED", await second.wait());
} catch (error) {
  console.log("CHAIN-DENIED", String(error));
}
`;
	const { diagnostic, rows, requests, roster, metrics } = await compiled({
		coord: { rules: [
			{ when: "^user:.*start-native-scouts$", reply: { tools: [add("worker", "Run the capped scout batch.")] } },
			{ when: '"added"', reply: { tools: [probe("chain-placement")] } },
			{ when: "SCOUTS-PROBE-chain-placement", reply: { tools: [probe("chain-result")] } },
			{ when: "SCOUTS-PROBE-chain-result", reply: { text: "Cap checked." } },
		] },
		"worker-a": { rules: [{ when: "You are `worker`", reply: { tools: [fanout] } }], default: { text: "Awaiting scout results." } },
		"worker-b": { rules: [
			{ when: "CHAIN-HOLD-", reply: { text: "Scout done.", wait: held.promise } },
			{ when: "RUN-CAPPED-CHAIN", reply: { tools: [tool("eval", { language: "js", title: "Run two completions in sequence", code })], wait: held.promise } },
		] },
		expensive: { rules: [
			{ when: "FIRST-CAPPED-AUX", reply: { text: "First paid result." } },
			{ when: "SECOND-CAPPED-AUX", reply: { text: "Second paid result." } },
		] },
	}, {
		config: threadedConfig.replace("modelRoles:\n", "modelRoles:\n  slow: mock/expensive\n"),
		ceiling: "1", highCostModel: true, held, releaseAt: "chain-placed",
		prep: c => {
			mkdirSync(join(c.repo, ".omp", "agents"), { recursive: true });
			writeFileSync(join(c.repo, ".omp", "agents", "scout.md"), "---\nname: scout\ndescription: Loopback accounting profile\ntools: eval\n---\nRun the assigned check.\n");
		},
	});
	expect(rows.find(row => row.stage === "chain-placed"), diagnostic).toMatchObject({
		local: 9, mainThreads: 1, workerThreads: 0, maxConcurrency: 10,
	});
	expect(rows.find(row => row.stage === "chain-result")?.result, diagnostic)
		.toMatch(/FIRST-OK.*First paid result.*CHAIN-DENIED.*Swarm spend ceiling/s);
	expect(requests.filter(r => r.model === "expensive").map(r => r.last), diagnostic).toEqual(["user: FIRST-CAPPED-AUX"]);
	expect(metrics?.outcome.value, diagnostic).toBe("incomplete");
	expect(roster?.members.worker?.stats?.cost, diagnostic).toBeGreaterThanOrEqual(15);
	expect(roster?.members.worker?.stats?.cost, diagnostic).toBeLessThan(16);
}, 60_000);

test("compiled cap blocks further worker spawns and native scout-result model turns", async () => {
	const held = Promise.withResolvers<void>();
	const { diagnostic, metrics, rows, requests } = await compiled({
		coord: { rules: [
			{ when: "^user:.*start-native-scouts$", reply: { tools: [add("worker", "Run a scout and wait for its results.")] } },
			{ when: '"added"', reply: { tools: [probe("one")] } },
			{ when: "SCOUTS-PROBE-one", reply: { tools: [probe("burn")] } },
			{ when: "SCOUTS-PROBE-burn", reply: { tools: [probe("denied")] } },
			{ when: "SCOUTS-PROBE-denied", reply: { tools: [batch(scout("MainDenied", "CAP-REFUSED-MAIN"))] } },
			{ when: "Swarm spend ceiling", reply: { tools: [probe("settled")] } },
			{ when: "SCOUTS-PROBE-settled", reply: { text: "Cap verified." } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [batch(scout("Held", "CAP-HELD-SCOUT"))] } },
			{ when: "CAP-RESULT", reply: { tools: [batch(scout("After", "CAP-REFUSED-SCOUT"))] } },
		] },
		"worker-b": { rules: [{ when: "CAP-HELD-SCOUT", reply: { text: "CAP-RESULT", wait: held.promise } }] },
	}, { config: concurrentConfig, ceiling: "0.005", held, releaseAt: "burn" });
	expect(metrics?.outcome.value, diagnostic).toBe("incomplete");
	expect(rows.find(row => row.stage === "denied"), diagnostic).toMatchObject({
		message: expect.stringMatching(/Cannot spawn 'scout'/), eval: expect.stringContaining("Swarm spend ceiling"),
	});
	expect(requests.some(r => r.last.includes("CAP-REFUSED-EVAL")), diagnostic).toBe(false);
	expect(rows.filter(row => row.stage === "registered"), diagnostic).toHaveLength(1);
	expect(rows.filter(row => row.stage === "main-scout-bill"), diagnostic).toHaveLength(0);
	expect(requests.some(r => r.model === "worker-a" && r.rule === 1), diagnostic).toBe(false);
	expect(requests.find(r => r.model === "coord" && r.rule === 5)?.last, diagnostic)
		.toContain("restart without OMP_SWARM_MAX_COST_USD or switch to a session without this swarm");
}, 60_000);

for (const how of ["kill", "abandon", "shutdown"] as const) {
	test(`compiled ${how} drains a worker's in-flight scout without a late post or live ref`, async () => {
		const held = Promise.withResolvers<void>();
		const stop = how === "kill" ? tool("swarm", { action: "kill", name: "worker" })
			: how === "abandon" ? tool("swarm", { action: "finish", abandon: true, summary: "Cancel held scout." })
				: probe("user-stop");
		const { diagnostic, metrics, rows, requests, roster } = await compiled({
			coord: { rules: [
				{ when: "^user:.*start-native-scouts$", reply: { tools: [add("worker", "Start a held native scout.")] } },
				{ when: '"added"', reply: { tools: [probe("one")] } },
				{ when: "SCOUTS-PROBE-one", reply: { tools: [stop] } },
				{ when: '"killed"|"completion":"accepted"', times: 1, reply: { tools: [probe("retired")] } },
				{ when: "SCOUTS-PROBE-retired", reply: how === "kill" ? { tools: [finish] } : { text: "Abandoned." } },
				{ when: '"completion":"accepted"', reply: { text: "Killed." } },
			] },
			"worker-a": { rules: [
				{ when: "You are `worker`", reply: { tools: [batch(scout("Held", "IN-FLIGHT-HELD-SCOUT"))] } },
				{ when: "IN-FLIGHT-TURN", reply: { tools: [tool("post_message", { text: "@coordinator FORBIDDEN-AFTER-STOP" })] } },
			] },
			"worker-b": { rules: [{ when: "IN-FLIGHT-HELD-SCOUT", reply: { text: "IN-FLIGHT-TURN", wait: held.promise } }] },
		}, { config: concurrentConfig, held, releaseAt: "shutdown", exitCode: how === "shutdown" ? 143 : 0 });
		expect(requests.some(r => r.model === "worker-b" && r.rule === 0), diagnostic).toBe(true);
		expect(requests.some(r => r.model === "worker-a" && r.rule === 1), diagnostic).toBe(false);
		expect(rows.find(r => r.stage === "shutdown"), diagnostic).toMatchObject({ refs: [], disposed: true });
		if (how !== "shutdown") expect(rows.find(r => r.stage === "retired"), diagnostic).toMatchObject({ remainingRefs: [] });
		expect(roster?.members.worker?.killed, diagnostic).toBe(how === "kill");
		expect(metrics?.outcome.value, diagnostic).toBe(how === "kill" ? "complete" : how === "abandon" ? "complete_with_abandonment" : "aborted");
	}, 60_000);
}
