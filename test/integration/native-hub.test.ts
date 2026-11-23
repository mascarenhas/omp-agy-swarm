import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RosterFile } from "../../src/board/types.ts";
import { type Ctx, type Metrics, readJson } from "../e2e/check.ts";
import { MockLlm } from "../e2e/mock-llm/server.ts";
import { REPO, runOmp, tool } from "../e2e/scenario.ts";

test("compiled Headless: real CAS and reservations, board wait, stop-gate, terminal fencing and root disposal", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-native-hub-"));
	const probe = join(root, "hub.log");
	const mock = new MockLlm({
		coord: {
			rules: [
				{ when: "^user:.*start-hub-registry$", reply: { tools: [tool("swarm", { action: "add", name: "early", brief: "not delivered", model: "mock/worker-a" })] } },
				{ when: "^tool:", times: 1, reply: { tools: [tool("swarm", { action: "add", name: "lens", brief: "send a private report", model: "mock/worker-a" })] } },
				{ when: "^tool:", times: 1, reply: { tools: [tool("swarm", { action: "add", name: "normal", brief: "wait on the board", model: "mock/worker-b" })] } },
				{ when: "^tool:", times: 1, reply: { tools: [tool("swarm", { action: "add", name: "cycle", brief: "wait on the board", model: "mock/worker-b" })] } },
				{ when: "^tool:", times: 1, reply: { tools: [tool("hub_probe", { action: "collide" })] } },
				{ when: "^tool: HUB-PROBE-collide", reply: { tools: [tool("hub_probe", { action: "wait" })] } },
				{ when: "^tool: HUB-PROBE-wait", reply: { text: "HUB-WAIT-VERIFIED" } },
				{ when: "^user:.*NATIVE-GATE-MESSAGE", reply: { tools: [tool("hub_probe", { action: "stop" })] } },
				{ when: "^tool: HUB-PROBE-stop", reply: { tools: [tool("hub_probe", { action: "park" })] } },
				{ when: "^tool: HUB-PROBE-park", reply: { tools: [tool("swarm", { action: "revive", name: "cycle" })] } },
				{ when: '^tool: \\{"reviving":\\["cycle"\\]', times: 1, reply: { tools: [tool("hub_probe", { action: "dispose" })] } },
				{ when: "^tool: HUB-PROBE-dispose", reply: { tools: [tool("swarm", { action: "revive", name: "cycle" })] } },
				{ when: '^tool: \\{"reviving":\\["cycle"\\]', times: 1, reply: { tools: [tool("hub_probe", { action: "unregister" })] } },
				{ when: "^tool: HUB-PROBE-unregister", reply: { tools: [tool("swarm", { action: "revive", name: "cycle" })] } },
				{ when: '^tool: \\{"reviving":\\["cycle"\\]', reply: { tools: [tool("hub_probe", { action: "before_kill" })] } },
				{ when: "^tool: HUB-PROBE-before_kill", reply: { tools: [tool("swarm", { action: "kill", name: "cycle" })] } },
				{ when: '^tool: \\{"killed":\\["cycle"\\]', reply: { tools: [tool("hub_probe", { action: "after_kill" })] } },
			],
			default: { text: "HUB-END" },
		},
		"worker-a": { rules: [
			{ when: "You are `lens`", reply: { tools: [tool("post_message", { text: "@coordinator NATIVE-GATE-MESSAGE" })] } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
		"worker-b": { rules: [], default: { tools: [tool("swarm_wait")] } },
	}, join(root, "mock.log"));
	const resetScript = {
		coord: {
			rules: [
				{ when: "^user:.*start-reset-shutdown$", reply: { tools: [tool("swarm", { action: "add", name: "normal", brief: "wait with a deadline", model: "mock/worker-b" })] } },
				{ when: '"added"', reply: { tools: [tool("hub_probe", { action: "shutdown" })] } },
			],
		},
		"worker-b": { rules: [], default: { tools: [tool("swarm_wait", { timeout_seconds: 60 })] } },
	};
	const ctx: Ctx = { id: "hub", T: root, repo: join(root, "work"), swarm: "unused", agent: join(root, "agent"), sessions: join(root, "sessions"), mock, runs: [] };
	try {
		mkdirSync(ctx.repo);
		mkdirSync(ctx.agent);
		const physicalSessions = join(root, "physical-sessions");
		mkdirSync(physicalSessions);
		symlinkSync(physicalSessions, ctx.sessions, "dir");
		const home = join(root, "home");
		mkdirSync(home);
		writeFileSync(join(ctx.agent, "config.yml"), "retry:\n  maxRetries: 1\n  baseDelayMs: 20\n");
		mock.start();
		const launch = {
			pluginArgs: ["--no-extensions", "-e", join(REPO, "test/fixtures/hub-probe.ts"), "-e", REPO],
			args: ["--max-time", "25"], env: {
				SWARM_TEST_HUB_LOG: probe, HOME: home, OMP_PROFILE: "", PI_PROFILE: "", XDG_CONFIG_HOME: join(home, "config"),
				PI_CONFIG_DIR: ".omp",
				XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
			},
		};
		const result = await runOmp(ctx, { ...launch, prompt: "start-hub-registry" }, true);
		expect(result.code, result.stderr).toBe(0);
		const snapshots = existsSync(probe) ? readFileSync(probe, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
		expect(result.stdout, JSON.stringify({ stderr: result.stderr, snapshots, requests: mock.requests("coord").map(r => [r.rule, r.last]) })).toContain("HUB-END");
		const row = (stage: string) => snapshots.find(value => value.stage === stage);
		expect(row("collide")).toMatchObject({ distinct: true, live: true, ids: ["swarm~race~2", "swarm~race~3"], nativeUnchanged: true, ownRefsGone: true, customOutOfRoot: true });
		expect(row("suffix-fallback")).toMatchObject({ preferred: "swarm~rebase~2", fallback: "swarm~rebase", suffixUnchanged: true });
		expect(row("init-failure")).toMatchObject({ rolledBack: true, initError: "injected initializeExtensions rejection", sameId: true });
		const parked = row("parked");
		expect(parked).toMatchObject({ status: "running", activity: "waiting on board", parentless: true, raw: true, ownsFocus: true, contextStatus: "active", mainWakeAgents: [], inRoot: true });
		expect(String(parked?.file).startsWith(`${ctx.sessions}/`)).toBe(true);
		expect(parked?.history).toBe(parked?.file);
		expect(snapshots.some(s => s.stage === "session-stop" && s.runningWorker === true)).toBe(true);
		expect(row("stopped")).toMatchObject({ synchronousTombstone: true, cannotRefocus: true, noRef: true, observer: "aborted" });
		expect(row("early-release")).toMatchObject({ unattached: true, registeredAfterRelease: false });
		expect(row("host-park")).toMatchObject({ noRef: true, disposed: true });
		expect(row("direct-dispose")).toMatchObject({ noRef: true, error: "injected transcript close failure", closeCalls: 2, sameConversation: true, sameFile: true, baseUnchanged: true });
		expect(row("external-unregister")).toMatchObject({
			removed: true, before: "active", observer: "aborted", noRef: true, sameProgress: true, lifecycleFrames: ["aborted"],
		});
		expect(row("explicit-kill")).toMatchObject({
			noRef: true, cannotRefocus: true, disposed: true, sameConversation: true, explicitOrder: ["abort finished", "dispose started"],
		});
		expect(row("root-shutdown")).toMatchObject({ normalGone: true, parkedUnchanged: true, abortedUnchanged: true });
		const swarm = dirname(dirname(String(parked?.file)));
		const roster = readJson<RosterFile>(join(swarm, "members.json"))?.members;
		expect(roster?.lens).toMatchObject({ agent_id: "swarm~lens~3", killed: true });
		expect(roster?.early).toMatchObject({ agent_id: "swarm~early", killed: true, brief_seq: 0 });
		expect(roster?.normal).toMatchObject({ agent_id: "swarm~normal", killed: false, last_park: { mode: "mentions" } });
		expect(roster?.cycle).toMatchObject({ agent_id: "swarm~cycle~3", killed: true });
		expect(mock.requests("coord").some(req => req.last.startsWith("user:") && req.last.includes("NATIVE-GATE-MESSAGE"))).toBe(true);
		mock.setScript(resetScript);
		const shutdownProbe = join(root, "shutdown.log");
		const exited = await runOmp(ctx, { ...launch, prompt: "start-reset-shutdown",
			env: { ...launch.env, SWARM_TEST_HUB_LOG: shutdownProbe, SWARM_TEST_RESET_MAIN: "1" } }, true);
		const shutdown = existsSync(shutdownProbe) ? readFileSync(shutdownProbe, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
		expect(exited.code, JSON.stringify({ stdout: exited.stdout, stderr: exited.stderr, shutdown })).toBe(143);
		expect(shutdown.find(s => s.stage === "reset")).toMatchObject({ reset: true, sameConversation: true, providerRotated: true });
		const beforeExit = shutdown.find(s => s.stage === "before-shutdown");
		expect(beforeExit).toMatchObject({ workerRunning: true });
		expect(shutdown.find(s => s.stage === "root-shutdown")).toMatchObject({ normalGone: true });
		const resetSwarm = dirname(dirname(String(beforeExit?.file)));
		expect(readJson<Metrics>(join(resetSwarm, "metrics.json"))?.outcome)
			.toMatchObject({ value: "aborted", reason: "shutdown with live work" });
		expect(readJson<RosterFile>(join(resetSwarm, "members.json"))?.members.normal)
			.toMatchObject({ killed: false, last_park: { mode: "mentions" } });
		expect(existsSync(join(ctx.agent, "agents"))).toBe(false);
	} finally {
		mock.stop();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
