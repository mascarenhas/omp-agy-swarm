import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RosterFile } from "../../src/board/types.ts";
import { type Ctx, readJson } from "../e2e/check.ts";
import { MockLlm } from "../e2e/mock-llm/server.ts";
import { runOmp, tool } from "../e2e/scenario.ts";

test("compiled --continue in the same terminal resumes Main, not its most recent worker", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-swarm-continue-"));
	const mock = new MockLlm({
		coord: {
			rules: [
				{ when: "^user:.*start-breadcrumb-test$", reply: { tools: [tool("swarm", { action: "add", name: "worker", brief: "Report and park.", model: "mock/worker-a" })] } },
				{ when: '"completion":"accepted"', reply: { text: "MAIN-FINISHED" } },
				{ when: "WORKER-PERSISTED", reply: { tools: [tool("swarm", { action: "finish", summary: "Worker reported." })] } },
				{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
			],
		},
		"worker-a": { rules: [
			{ when: "You are `worker`", reply: { tools: [tool("post_message", { text: "@coordinator WORKER-PERSISTED" })] } },
			{ when: "^tool:", reply: { tools: [tool("swarm_wait")] } },
		] },
	});
	const ctx: Ctx = { id: "continue", T: root, repo: join(root, "work"), swarm: "unused", agent: join(root, "agent"), sessions: join(root, "sessions"), mock, runs: [] };
	try {
		mkdirSync(ctx.repo);
		mkdirSync(ctx.agent);
		const home = join(root, "home");
		mkdirSync(home);
		const env = {
			HOME: home, OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_DIR: ".omp",
			XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
			XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
			// Two headless child processes stand in for two launches in the same Tern PTY.
			ZELLIJ_SESSION_NAME: "swarm-continue", ZELLIJ_PANE_ID: "17",
		};
		mock.start();
		const first = await runOmp(ctx, { prompt: "start-breadcrumb-test", env, args: ["--max-time", "25"] }, true);
		expect(first.code, first.stderr).toBe(0);
		expect(first.stdout).toContain("MAIN-FINISHED");
		const [file] = readdirSync(ctx.sessions).filter(name => name.endsWith(".jsonl"));
		if (!file) throw new Error("Main transcript was not persisted");
		const main = join(ctx.sessions, file);
		const swarm = main.slice(0, -".jsonl".length) + "/swarm";
		const roster = readJson<RosterFile>(join(swarm, "members.json"));
		const worker = roster?.members.worker;
		if (!worker?.session_file) throw new Error("Worker transcript was not recorded");
		const workerFile = join(swarm, "sessions", worker.session_file);
		const workerBefore = readFileSync(workerFile, "utf8");
		expect(workerBefore).toContain("WORKER-PERSISTED");
		const breadcrumb = join(ctx.agent, "terminal-sessions", "zellij-swarm-continue-17");
		const beforeContinue = readFileSync(breadcrumb, "utf8").split("\n")[1];

		mock.setScript({ coord: { rules: [], default: { text: "CONTINUED" } } });
		const continued = await runOmp(ctx, { prompt: "check resumed conversation", env, args: ["--continue", "--mode", "json", "--max-time", "25"] }, true);
		expect(continued.code, continued.stderr).toBe(0);
		const header = JSON.parse(continued.stdout.split("\n")[0] ?? "null");
		expect(header).toMatchObject({ type: "session", id: roster?.id });
		expect(header.id).not.toBe(worker.conversation_id);
		expect(beforeContinue).toBe(main);
		expect(readFileSync(workerFile, "utf8")).toBe(workerBefore);
	} finally {
		mock.stop();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
