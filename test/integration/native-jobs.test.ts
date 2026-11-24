import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ctx, metrics, roster } from "../e2e/check.ts";
import { MockLlm, type Script } from "../e2e/mock-llm/server.ts";
import { REPO, runOmp, type RunSpec, tool } from "../e2e/scenario.ts";
import { until } from "../helpers/harness.ts";

async function probe(script: Script, run: Partial<RunSpec> = {}, prepare?: (cwd: string) => void, config = "", drive?: (c: Ctx) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "omp-native-jobs-"));
	const log = join(root, "probe.log");
	const mock = new MockLlm(script);
	const c: Ctx = { id: "jobs", T: root, repo: join(root, "work"), swarm: join(root, "swarm"), agent: join(root, "agent"), sessions: join(root, "sessions"), mock, runs: [] };
	try {
		const home = join(root, "home");
		for (const dir of [c.repo, c.agent, home]) mkdirSync(dir);
		writeFileSync(join(c.agent, "config.yml"), `async:\n  printWake: false\n${config}`);
		prepare?.(c.repo);
		mock.start();
		const running = runOmp(c, {
			prompt: "start-native-jobs",
			pluginArgs: ["--no-extensions", "-e", join(REPO, "test/fixtures/jobs-probe.ts"), "-e", REPO],
			args: ["--max-time", "25", "--approval-mode", "yolo", ...(run.args ?? [])],
			env: {
				SWARM_JOBS_LOG: log, HOME: home, PI_CONFIG_DIR: ".omp", OMP_PROFILE: "", PI_PROFILE: "",
				XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
				XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), ...run.env,
			},
		}, false);
		try { await drive?.(c); } catch (err) {
			await running;
			throw err;
		}
		const result = await running;
		const rows = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
		const diagnostic = JSON.stringify({ result, rows, requests: mock.requests().map(r => [r.model, r.rule, r.last]) });
		expect(result.code, diagnostic).toBe(0);
		return { result, rows, diagnostic, outcome: metrics(c)?.outcome?.value, roster: roster(c),
			requests: mock.requests(), config: readFileSync(join(c.agent, "config.yml"), "utf8") };
	} finally {
		mock.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

const finish = tool("swarm", { action: "finish", summary: "Verified." });

async function expectBusyWorkerAside(retry: boolean): Promise<void> {
	const question = "MIDTURN-QUESTION-bb73f1";
	const reply = "MIDTURN-REPLY-430bfc";
	const { rows, outcome, requests, diagnostic } = await probe({
		coord: { rules: [
			{ when: "^user:.*start-native-jobs$", reply: { tools: [tool("swarm", { action: "add", name: "worker", brief: "Start the held command.", model: "mock/worker-a" })] } },
			{ when: '"added"', reply: { tools: [tool("jobs_probe", { action: "await_busy" })] } },
			{ when: "^tool: JOBS-PROBE-await_busy", reply: { tools: [tool("post_message", { text: `@worker ${question}` })] } },
			{ when: '^tool:\\s*\\{"seq":2,', times: 1, reply: { tools: [tool("jobs_probe", { action: "release_busy" })] } },
			{ when: '"completion":"accepted"', reply: { text: "Mid-turn reply verified" } },
			{ when: reply, whenNot: "Cannot finish:", reply: { tools: [finish] } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", times: retry ? 1 : 0, reply: { status: 400, text: "overloaded_error: Overloaded" } },
			{ when: "You are `worker`", reply: { tools: [tool("bash", {
				command: "touch mid-turn-busy; i=0; while [ ! -f mid-turn-release ] && [ \"$i\" -lt 600 ]; do sleep .02; i=$((i+1)); done; test -f mid-turn-release && echo MIDTURN-TOOL-DONE",
				async: false, timeout: 16,
			})] } },
			{ when: question, times: 1, reply: { tools: [tool("post_message", { text: `@coordinator [done] ${reply}` })] } },
		], default: { text: "End the same run." } },
	}, { env: { OMP_SWARM_WORKER_TOOLS: "read,write,bash" } }, undefined, retry ? "retry:\n  enabled: true\n  baseDelayMs: 50\n" : "");
	expect(rows.filter(r => String(r.stage).startsWith("busy-")).map(r => r.stage), diagnostic).toEqual([
		"busy-tool-running", "busy-tool-released", "busy-tool-ended", "busy-aside-received", "busy-reply-posted", "busy-worker-ended",
	]);
	expect(rows.find(r => r.stage === "busy-aside-received"), diagnostic).toMatchObject({ text: expect.stringContaining(question) });
	expect(rows.find(r => r.stage === "busy-tool-ended"), diagnostic).toMatchObject({ isError: false });
	expect(rows.find(r => r.stage === "busy-reply-posted"), diagnostic).toMatchObject({ isError: false });
	const workerRequests = requests.filter(r => r.model === "worker-a" && r.rule !== -3);
	if (retry) expect(workerRequests.slice(0, 3).map(r => r.rule), diagnostic).toEqual([0, 1, 2]);
	expect(workerRequests[retry ? 2 : 1]?.last, diagnostic).toContain(question);
	expect(outcome, diagnostic).toBe("complete");
}

test("compiled worker receives and answers an aside at the next foreground tool boundary in the same run", () => expectBusyWorkerAside(false), 60_000);
test("compiled worker receives a mid-turn aside after native auto-retry succeeds", () => expectBusyWorkerAside(true), 60_000);

test("compiled worker handles a stop-boundary aside in its original loop", async () => {
	const final = Promise.withResolvers<void>();
	const question = "STOP-BOUNDARY-QUESTION-a137";
	const reply = "STOP-BOUNDARY-REPLY-98d4";
	const { rows, outcome, requests, diagnostic } = await probe({
		coord: { rules: [
			{ when: "^user:.*start-native-jobs$", reply: { tools: [tool("swarm", { action: "add", name: "worker", brief: "Do your work and end.", model: "mock/worker-a" })] } },
			{ when: '"added"', reply: { tools: [tool("jobs_probe", { action: "await_busy" })] } },
			{ when: "^tool: JOBS-PROBE-await_busy", reply: { tools: [tool("bash", {
				command: "i=0; while [ ! -f worker-final-request ] && [ \"$i\" -lt 500 ]; do sleep .02; i=$((i+1)); done; test -f worker-final-request && echo WORKER-READY-TO-END",
				async: false, timeout: 12,
			})] } },
			{ when: "WORKER-READY-TO-END", reply: { tools: [tool("post_message", { text: `@worker ${question}` })] } },
			{ when: '^tool:\\s*\\{"seq":2,', times: 1, reply: { tools: [tool("jobs_probe", { action: "release_busy" })] } },
			{ when: '"completion":"accepted"', reply: { text: "Verified" } },
			{ when: reply, whenNot: "Cannot finish:", reply: { tools: [finish] } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [tool("bash", { command: "touch mid-turn-busy; echo WORKER-WORK-DONE", async: false })] } },
			{ when: "WORKER-WORK-DONE", times: 1, reply: { text: "I am done with my work.", wait: final.promise } },
			{ when: question, times: 1, reply: { tools: [tool("post_message", { text: `@coordinator [done] ${reply}` })] } },
		], default: { text: "Now I am done." } },
	}, { env: { OMP_SWARM_WORKER_TOOLS: "read,bash" } }, undefined, "", async c => {
		try {
			await until(() => c.mock.requests("worker-a").some(r => r.rule === 1), 15_000, "worker final request");
			writeFileSync(join(c.repo, "worker-final-request"), "");
			await until(() => existsSync(join(c.repo, "mid-turn-release")), 10_000, "coordinator posted the question");
		} finally { final.resolve(); }
	});
	const workerRequests = requests.filter(r => r.model === "worker-a" && r.rule !== -3);
	expect(workerRequests.slice(0, 3).map(r => r.rule), diagnostic).toEqual([0, 1, 2]);
	expect(rows.filter(r => /^busy-(?:aside-received|reply-posted|worker-)/.test(String(r.stage))).map(r => r.stage), diagnostic)
		.toEqual(["busy-aside-received", "busy-reply-posted", "busy-worker-ended"]);
	expect(outcome, diagnostic).toBe("complete");
}, 60_000);

test("compiled swarm kill fences the native aside before abort can restart the worker", async () => {
	const question = "KILL-QUEUED-ASIDE-a930";
	const { rows, outcome, requests, diagnostic, roster: members } = await probe({
		coord: { rules: [
			{ when: "^user:.*start-native-jobs$", reply: { tools: [tool("swarm", { action: "add", name: "worker", brief: "Start the held command.", model: "mock/worker-a" })] } },
			{ when: '"added"', reply: { tools: [tool("jobs_probe", { action: "await_busy" })] } },
			{ when: "^tool: JOBS-PROBE-await_busy", reply: { tools: [tool("post_message", { text: `@worker ${question}` })] } },
			{ when: '^tool:\\s*\\{"seq":2,', times: 1, reply: { tools: [tool("swarm", { action: "kill", name: "worker" })] } },
			{ when: '"completion":"accepted"', reply: { text: "Verified" } },
			{ when: "^tool:", reply: { tools: [finish] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [tool("bash", { command: "touch mid-turn-busy; sleep 15", async: false, timeout: 18 })] } },
		], default: { text: "This unexpected turn must never run." } },
	}, { env: { OMP_SWARM_WORKER_TOOLS: "read,bash" } });
	expect(rows.find(r => r.stage === "busy-tool-running"), diagnostic).toBeDefined();
	// Host disposal may record the aside, but never wakes another loop with it.
	expect(rows.find(r => r.stage === "busy-aside-received"), diagnostic).toMatchObject({ text: expect.stringContaining(question) });
	expect(rows.filter(r => r.stage === "busy-worker-restarted" || r.stage === "busy-reply-posted"), diagnostic).toEqual([]);
	expect(requests.filter(r => r.model === "worker-a" && r.rule !== -3).map(r => r.rule), diagnostic).toEqual([0]);
	expect(members.worker, diagnostic).toMatchObject({ killed: true, last_read_seq: 1 });
	expect(outcome, diagnostic).toBe("complete");
}, 60_000);

for (const mode of ["print", "json", "cli-wait"] as const) {
	test(`compiled ${mode}: a headless swarm keeps Main jobs waking after finish, then restores its setting`, async () => {
		const { rows, outcome, config, diagnostic } = await probe({
			coord: {
				rules: [
					{ when: "^user:.*start-native-jobs$", reply: { tools: [tool("swarm", { action: "title", title: "Native Main job" })] } },
					{ when: '"title":"Native Main job"', reply: { tools: [tool("jobs_probe", { action: "hold" })] } },
					{ when: "^tool: JOBS-PROBE-hold", reply: { tools: [finish] } },
					{ when: '"completion":"accepted"', reply: { text: "Waiting for my own job" } },
					{ when: "MAIN-JOB-RESULT-271", reply: { text: "Delivered once" } },
				],
			},
		}, { args: mode === "json" ? ["--mode", "json"] : mode === "cli-wait" ? ["--wait-async"] : [],
			env: mode === "json" ? { SWARM_JOBS_PRIOR_OVERRIDE: "false" } : undefined });
		expect(rows.filter(r => r.stage === "main-result"), diagnostic).toHaveLength(1);
		expect(rows.filter(r => r.stage === "gate-reminder")).toHaveLength(0);
		expect(rows.find(r => r.stage === "main-paused")).toMatchObject({ effective: true });
		const start = rows.find(r => r.stage === "start");
		const end = rows.find(r => r.stage === "shutdown");
		expect(end?.effective, diagnostic).toBe(start?.effective);
		expect(end?.override).toBe(start?.override);
		expect(outcome).toBe("complete");
		expect(config).toContain("printWake: false");
	}, 60_000);
}

test("compiled print: cancelling Main's last job returns to the swarm gate instead of exiting early", async () => {
	const { rows, outcome, diagnostic } = await probe({
		coord: { rules: [
			{ when: "^user:.*start-native-jobs$", reply: { tools: [tool("swarm", { action: "add", name: "worker", brief: "Hold for instructions.", model: "mock/worker-a" })] } },
			{ when: '"added"', reply: { tools: [tool("jobs_probe", { action: "hold" })] } },
			{ when: "^tool: JOBS-PROBE-hold", reply: { text: "My job is still pending" } },
			{ when: "Your native background work ended without waking you", reply: { tools: [tool("swarm", { action: "finish", abandon: true, summary: "Cancel the remaining worker." })] } },
			{ when: '"completion":"accepted"', reply: { text: "Gate reached" } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [tool("post_message", { text: "Holding." })] } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait", { timeout_seconds: 60 })] } },
		] },
	}, { env: { SWARM_JOBS_CANCEL_MAIN: "1" } });
	expect(rows.filter(r => r.stage === "main-paused"), diagnostic).toHaveLength(1);
	expect(rows.filter(r => r.stage === "main-result"), diagnostic).toHaveLength(0);
	expect(rows.filter(r => r.stage === "gate-reminder"), diagnostic).toHaveLength(1);
	expect(rows.filter(r => r.stage === "session-stop"), diagnostic).toHaveLength(1);
	expect(outcome).toBe("complete_with_abandonment");
}, 60_000);

test("compiled stock print without a swarm does not acquire the print-wake lease", async () => {
	const { rows, outcome, diagnostic } = await probe({
		coord: { rules: [
			{ when: "^user:.*start-native-jobs$", reply: { tools: [tool("jobs_probe", { action: "hold" })] } },
			{ when: "^tool: JOBS-PROBE-hold", reply: { text: "Stock behaviour" } },
		] },
	});
	expect(rows.find(r => r.stage === "main-paused"), diagnostic).toMatchObject({ effective: false });
	expect(rows.filter(r => r.stage === "main-result")).toHaveLength(0);
	expect(outcome).toBeUndefined();
}, 60_000);

test("compiled print restores its lease when the active swarm exits without finish", async () => {
	const { rows, outcome, diagnostic } = await probe({
		coord: { rules: [
			{ when: "^user:.*start-native-jobs$", reply: { tools: [tool("swarm", { action: "title", title: "No completion marker" })] } },
			{ when: '"title":"No completion marker"', reply: { text: "Quiescent" } },
		] },
	});
	expect(rows.find(r => r.stage === "session-stop"), diagnostic).toMatchObject({ effective: true, override: true });
	const shutdown = rows.find(r => r.stage === "shutdown");
	expect(shutdown).toMatchObject({ effective: false });
	expect(shutdown?.override).toBeUndefined();
	expect(outcome).toBe("quiescent_no_done");
}, 60_000);

test.skipIf(!existsSync("/usr/bin/python3"))("compiled workers without task refuse even scouts through eval; background eval and bash still deliver", async () => {
	const code = `
try {
  await agent("PHASEA_CHILD_AGENT_SENTINEL", { agent: "task", label: "phasea-agent" });
  console.log("agent unexpectedly admitted");
} catch (err) {
  console.log(String(err));
}
try {
  const pool = await workpool("scout", { name: "phasea-pool" });
  await pool.push("PHASEA_CHILD_POOL_SENTINEL");
  console.log("workpool unexpectedly admitted");
} catch (err) {
  console.log(String(err));
}
`;
	const { rows, outcome, requests, diagnostic } = await probe({
		coord: { rules: [
			{ when: "^user:.*start-native-jobs$", reply: { tools: [tool("swarm", { action: "add", name: "worker", brief: "Run the background command.", model: "mock/worker-a" })] } },
			{ when: '"added"', reply: { tools: [tool("jobs_probe", { action: "release_worker" })] } },
			{ when: '"completion":"accepted"', reply: { text: "Worker job verified" } },
			{ when: "WORKER-JOB-POST", whenNot: "Cannot finish:", reply: { tools: [finish] } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [tool("eval", { language: "js", title: "Try disabled delegation", code })] } },
			{ when: "Cannot spawn 'task'.*Cannot spawn 'scout'", times: 1, reply: { tools: [tool("bash", { command: "/usr/bin/python3 result.py", async: true })] } },
			{ when: "LATCH-RELEASED-WORKER-NONCE-f43d2b", reply: { tools: [tool("post_message", { text: "@coordinator WORKER-JOB-POST" })] } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
	}, { env: { OMP_SWARM_WORKER_TOOLS: "read,write,bash,eval" } }, cwd => {
		writeFileSync(join(cwd, "result.py"), `import pathlib, sys, time
latch = pathlib.Path("release-job")
end = time.monotonic() + 12
while not latch.exists() and time.monotonic() < end:
    time.sleep(0.01)
if not latch.exists():
    sys.exit(7)
print(latch.read_text())
sys.exit(0)
`);
	}, `eval:
  autoProvision: false
  autoBackground:
    enabled: true
    thresholdMs: 0
task:
  agentModelOverrides:
    task: mock/worker-b
    scout: mock/worker-b
`);
	expect(rows.filter(r => r.stage === "worker-parked" || r.stage === "worker-woke-job" || r.stage === "worker-result").map(r => r.stage), diagnostic)
		.toEqual(["worker-parked", "worker-woke-job", "worker-result"]);
	expect(rows.find(r => r.stage === "eval-policy"), diagnostic).toMatchObject({
		status: "completed", childRefs: [], taskJobs: [],
		output: expect.stringMatching(/Cannot spawn 'task'.*Cannot spawn 'scout'/s),
	});
	expect(rows.find(r => r.stage === "worker-result"), diagnostic).toMatchObject({
		status: "completed", exitCode: 0, output: expect.stringContaining("LATCH-RELEASED-WORKER-NONCE-f43d2b"),
	});
	expect(requests.filter(r => r.model === "worker-b")).toEqual([]);
	expect(outcome).toBe("complete");
}, 60_000);

async function checkProcessOwnership(source: "swarm kill" | "native tombstone"): Promise<void> {
	const stop = source === "native tombstone" ? tool("jobs_probe", { action: "native_stop" }) : tool("swarm", { action: "kill", name: "alpha" });
	const worker = (name: string): Script[string] => ({
		rules: [{ when: `You are \`${name}\``, reply: { tools: [tool("bash", { command: `/usr/bin/python3 hold.py ${name}`, async: true })] } }],
		default: { tools: [tool("swarm_wait")] },
	});
	const { rows, outcome, diagnostic, roster: members } = await probe({
		coord: { rules: [
			{ when: "^user:.*start-native-jobs$", reply: { tools: [
				tool("swarm", { action: "add", name: "alpha", brief: "Start the alpha command.", model: "mock/worker-a" }),
				tool("swarm", { action: "add", name: "beta", brief: "Start the beta command.", model: "mock/worker-b" }),
			] } },
			{ when: '"added"', reply: { tools: [tool("jobs_probe", { action: "running" })] } },
			{ when: "^tool: JOBS-PROBE-running", reply: { tools: [stop] } },
			{ when: '"killed":\\["alpha"\\]|JOBS-PROBE-native_stop', reply: { tools: [tool("jobs_probe", { action: "one_gone" })] } },
			{ when: "^tool: JOBS-PROBE-one_gone", reply: { tools: [tool("swarm", { action: "finish", abandon: true, summary: "Cancel beta." })] } },
			{ when: '"completion":"accepted"', reply: { tools: [tool("jobs_probe", { action: "both_gone" })] } },
			{ when: "^tool: JOBS-PROBE-both_gone", reply: { text: "All reaped" } },
		] },
		"worker-a": worker("alpha"), "worker-b": worker("beta"),
	}, {}, cwd => {
		writeFileSync(join(cwd, "hold.py"), "import os, pathlib, subprocess, sys\np = subprocess.Popen(['/usr/bin/sleep', '12'])\npathlib.Path(sys.argv[1] + '.pids').write_text(f'{os.getpid()} {p.pid}')\np.wait()\n");
	});
	expect(rows.find(r => r.stage === "running"), diagnostic).toMatchObject({ scopes: true, owners: [1, 1], alpha: [true, true], beta: [true, true] });
	expect(rows.find(r => r.stage === "proc-scope"), diagnostic).toMatchObject({
		ownReadable: true, checks: [{ readDenied: true, killDenied: true }, { readDenied: true, killDenied: true }],
		betaUnaffected: true, mainUnaffected: true,
	});
	expect(members.alpha?.killed).toBe(true);
	expect(rows.find(r => r.stage === "one_gone"), diagnostic).toMatchObject({ alpha: [false, false], beta: [true, true], alphaRef: false, betaRef: true });
	expect(rows.find(r => r.stage === "both_gone"), diagnostic).toMatchObject({ alpha: [false, false], beta: [false, false], alphaRef: false, betaRef: false });
	expect(outcome).toBe("complete_with_abandonment");
}

for (const source of ["swarm kill", "native tombstone"] as const) {
	test.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/python3") || !existsSync("/usr/bin/sleep"))(
		`compiled Linux: ${source}, abandon and native proc:// respect job owners`, () => checkProcessOwnership(source), 60_000,
	);
}
