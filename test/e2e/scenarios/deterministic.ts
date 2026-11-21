// D0–D12 (§12.3): deterministic scenarios against the real omp binary and the scripted mock.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOmpBin, stripNodeModulesBins } from "../../../scripts/omp-bin.ts";
import { board, type Ctx, metrics, requests, roster } from "../check.ts";
import type { Rule, Script } from "../mock-llm/server.ts";
import { REPO, type Scenario, tool } from "../scenario.ts";

const SWARM_TOOLS = ["swarm", "post_message", "read_board", "swarm_wait"];
const NEVER = ["task", "wait", "manage_skill", "new_context"];

const all = (...markers: string[]) => `^${markers.map(m => `(?=.*${m})`).join("")}`;
const finish = (summary: string): Rule["reply"] => ({ tools: [tool("swarm", { action: "finish", summary })] });
const accepted: Rule = { when: '"completion":"accepted"', reply: { text: "FINAL: the swarm finished." } };
const waitAgain: Rule = { when: "^tool:", reply: { tools: [tool("swarm_wait", {})] } };

/** A worker that posts `text` on its brief, then waits. */
function reporter(name: string, text: string): Rule[] {
	return [
		{ when: `You are \`${name}\``, reply: { tools: [tool("post_message", { text })] } },
		{ when: `^tool: \\{"seq":`, reply: { tools: [tool("swarm_wait", {})] } },
	];
}

function gitOut(cwd: string, ...a: string[]): string {
	return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

/** The coordinator's own transcript (for tool results the mock log does not keep). */
function coordinatorTranscript(c: Ctx): string {
	if (!existsSync(c.sessions)) return "";
	return readdirSync(c.sessions, { recursive: true })
		.map(String)
		.filter(f => f.endsWith(".jsonl"))
		.map(f => readFileSync(join(c.sessions, f), "utf8"))
		.join("\n");
}

function basicCoordinator(add: Record<string, unknown>, markers: string[]): Script[string] {
	return {
		rules: [accepted, { when: "^tool:", whenAny: all(...markers), reply: finish("work verified") }, waitAgain],
		default: { tools: [tool("swarm", { action: "add", ...add })] },
	};
}

const D0a: Scenario = {
	id: "D0a",
	title: "launch with --no-extensions -e <dir>: tools on turn 1, skills resolve, mock provider survives workers",
	script: () => ({
		coord: {
			rules: [
				accepted,
				{ when: "^tool:", whenAny: all("DONE-w"), reply: finish("w reported") },
				{ when: "^tool:", whenAny: all("You are the swarm coordinator", "The swarm.s Overview"), times: 1, reply: { tools: [tool("swarm", { action: "add", name: "w", brief: "report", model: "mock/worker-a" })] } },
				waitAgain,
			],
			default: { tools: [tool("read", { path: "skill://swarm" }), tool("read", { path: "skill://swarm_pane" })] },
		},
		"worker-a": { rules: reporter("w", "@coordinator [done] DONE-w") },
	}),
	runs: [{ prompt: "start" }],
	check: (c, k) => {
		const first = requests(c, "coord")[0];
		for (const t of SWARM_TOOLS) k.ok(first?.tools.includes(t), `turn 1 offers ${t}`);
		k.eq(metrics(c)?.outcome?.value, "complete", "outcome");
		k.ok(requests(c, "coord").length >= 4, "the coordinator kept talking to the extension provider after workers existed");
	},
};

const D0b: Scenario = {
	id: "D0b",
	title: "launch via `omp plugin link`",
	setup: c => {
		execFileSync(resolveOmpBin(), ["plugin", "link", REPO], {
			env: { ...process.env, PATH: stripNodeModulesBins(process.env.PATH), PI_CODING_AGENT_DIR: c.agent },
			stdio: "ignore",
		});
	},
	script: D0a.script,
	runs: [{ prompt: "start", pluginArgs: [] }],
	check: (c, k) => {
		const first = requests(c, "coord")[0];
		for (const t of SWARM_TOOLS) k.ok(first?.tools.includes(t), `turn 1 offers ${t}`);
		k.eq(metrics(c)?.outcome?.value, "complete", "outcome");
	},
};

const D0c: Scenario = {
	id: "D0c",
	title: "--no-session: private ephemeral swarm dir",
	noSwarmDirEnv: true,
	script: () => ({ coord: basicCoordinator({ name: "w", brief: "report", model: "mock/worker-a" }, ["DONE-w"]), "worker-a": { rules: reporter("w", "@coordinator [done] DONE-w") } }),
	runs: [{ prompt: "start", args: ["--no-session"] }],
	check: (c, k) => {
		const m = /omp-agy-swarm: swarm directory (\S+)/.exec(c.runs[0]?.stderr ?? "");
		k.ok(m, "the ephemeral swarm dir is printed once on stderr");
		if (!m?.[1]) return;
		k.ok(m[1].includes("omp-agy-swarm-"), "mkdtemp dir");
		const met = JSON.parse(readFileSync(join(m[1], "metrics.json"), "utf8"));
		k.eq(met.outcome.value, "complete", "outcome");
		rmSync(m[1], { recursive: true, force: true });
	},
};

const D1: Scenario = {
	id: "D1",
	title: "3 workers on 3 models/efforts write files and report; coordinator verifies and finishes",
	script: () => ({
		coord: {
			rules: [accepted, { when: "^tool:", whenAny: all("DONE-alpha", "DONE-beta", "DONE-gamma"), reply: finish("alpha, beta and gamma wrote their files") }, waitAgain],
			default: {
				tools: [
					tool("swarm", { action: "add", name: "alpha", brief: "write alpha.txt", model: "mock/worker-a", effort: "low" }),
					tool("swarm", { action: "add", name: "beta", brief: "write beta.txt", model: "mock/worker-b", effort: "high" }),
					tool("swarm", { action: "add", name: "gamma", brief: "write gamma.txt", model: "mock/plain" }),
				],
			},
		},
		...Object.fromEntries(
			[
				["worker-a", "alpha"],
				["worker-b", "beta"],
				["plain", "gamma"],
			].map(([model, name]) => [
				model,
				{
					rules: [
						{ when: `You are \`${name}\``, reply: { tools: [tool("bash", { command: `printf ${name} > ${name}.txt && echo WROTE-${name}` })] } },
						{ when: `^tool: .*WROTE-${name}`, reply: { tools: [tool("post_message", { text: `@coordinator [done] DONE-${name} wrote ${name}.txt` })] } },
						{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
					],
				},
			]),
		),
	}),
	runs: [{ prompt: "split the work" }],
	check: (c, k) => {
		k.eq(metrics(c)?.outcome?.value, "complete", "outcome");
		const r = roster(c);
		k.eq([r.alpha?.model, r.alpha?.effort], ["mock/worker-a", "low"], "alpha model/effort");
		k.eq([r.beta?.model, r.beta?.effort], ["mock/worker-b", "high"], "beta model/effort");
		k.eq(r.gamma?.model, "mock/plain", "gamma model");
		k.ok(requests(c, "worker-a").length > 0 && requests(c, "worker-a").every(q => q.reasoning_effort === "low"), "worker-a requests carry reasoning_effort low");
		k.ok(requests(c, "worker-b").length > 0 && requests(c, "worker-b").every(q => q.reasoning_effort === "high"), "worker-b requests carry reasoning_effort high");
		k.ok(requests(c, "plain").length > 0 && requests(c, "plain").every(q => !q.hasReasoningField), "plain sends no reasoning field");
		for (const n of ["alpha", "beta", "gamma"]) k.eq(readFileSync(join(c.repo, `${n}.txt`), "utf8"), n, `${n}.txt written`);
		const b = board(c);
		k.ok(b.filter(m => m.text.includes("[done] DONE-")).length === 3, "three worker reports on the board");
		k.ok(b.at(-1)?.agent === "coordinator" && b.at(-1)?.text.startsWith("[done]"), "the coordinator's [done] is last");
		for (const model of ["worker-a", "worker-b", "plain"]) {
			const tools = requests(c, model)[0]?.tools ?? [];
			for (const t of SWARM_TOOLS) k.ok(tools.includes(t), `${model} worker has ${t}`);
			for (const t of ["read", "bash", "edit", "write"]) k.ok(tools.includes(t), `${model} worker has ${t}`);
			for (const t of NEVER) k.ok(!tools.includes(t), `${model} worker lacks ${t}`);
		}
	},
};

const D2: Scenario = {
	id: "D2",
	title: "effort clamp on worker-limited; parked worker switched a→b:high; effort-only change",
	script: () => ({
		coord: {
			rules: [
				accepted,
				{ when: "^tool:", whenAny: all("SW-ON-B", "LIM-HIGH"), reply: finish("switch verified") },
				// After the switches: wake both, so each answers on its new model/effort.
				{ when: '"switched":\\[', times: 1, reply: { tools: [tool("post_message", { text: "@sw report your model now. @lim report your effort now" })] } },
				{
					when: "^tool:",
					whenAny: all("READY-sw", "READY-lim"),
					times: 1,
					reply: { tools: [tool("swarm", { action: "model", name: "lim", effort: "high" }), tool("swarm", { action: "model", name: "sw", model: "mock/worker-b", effort: "high" })] },
				},
				waitAgain,
			],
			default: {
				tools: [
					tool("swarm", { action: "add", name: "lim", brief: "get ready", model: "mock/worker-limited", effort: "medium" }),
					tool("swarm", { action: "add", name: "sw", brief: "get ready", model: "mock/worker-a", effort: "low" }),
				],
			},
		},
		"worker-limited": {
			rules: [
				// Woken after the effort-only switch: this request must carry the new effort.
				{ when: '"woke":"post".*report your effort', reply: { tools: [tool("post_message", { text: "@coordinator LIM-HIGH" })] } },
				...reporter("lim", "READY-lim"),
			],
		},
		"worker-a": { rules: reporter("sw", "READY-sw") },
		"worker-b": {
			rules: [
				{ when: "Your model is now mock/worker-b", reply: { tools: [tool("post_message", { text: "@coordinator [done] SW-ON-B" })] } },
				{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
			],
		},
	}),
	runs: [{ prompt: "switch test" }],
	check: (c, k) => {
		k.eq(metrics(c)?.outcome?.value, "complete", "outcome");
		k.ok(coordinatorTranscript(c).includes("'medium' → 'low'"), "the clamp note reached the coordinator");
		const lim = requests(c, "worker-limited");
		// Rule 0 of worker-limited answers the post-switch wake (the logged `last` text is capped).
		const woke = lim.findIndex(q => q.rule === 0);
		k.ok(woke > 0, "lim was woken after the effort-only switch");
		k.ok(lim.slice(0, woke).every(q => q.reasoning_effort === "low"), "worker-limited wire effort low before the switch (clamped)");
		k.ok(woke > 0 && lim.slice(woke).every(q => q.reasoning_effort === "high"), "worker-limited wire effort high after the effort-only switch");
		const b = requests(c, "worker-b");
		k.ok(b.length > 0, "the switched worker ran on worker-b");
		k.eq(b[0]?.reasoning_effort, "high", "first worker-b request effort");
		k.ok(b[0]?.roles.includes("assistant") && b[0]?.roles.includes("tool"), "earlier tool call and result still in the history");
		const r = roster(c);
		k.eq([r.sw?.model, r.sw?.effort], ["mock/worker-b", "high"], "roster after the switch");
		k.eq([r.lim?.model, r.lim?.effort], ["mock/worker-limited", "high"], "effort-only change kept the model");
	},
};

const D3: Scenario = {
	id: "D3",
	title: "channels, @#channel and an n:2 group follow the wake matrix",
	script: () => ({
		coord: {
			rules: [
				accepted,
				{ when: "^tool:", whenAny: all("PONG-g.*PONG-g"), reply: finish("pings answered") },
				{ when: "^tool:", whenAny: all("PONG-api"), times: 1, reply: { tools: [tool("post_message", { text: "@g ping-group" })] } },
				{ when: "^tool:", whenAny: all("READY-x.*READY-x.*READY-x"), times: 1, reply: { tools: [tool("post_message", { text: "@#api ping-api" })] } },
				{
					when: '"channel":"api","seq"',
					times: 1,
					reply: {
						tools: [
							tool("swarm", { action: "add", name: "g", brief: "wait", n: 2, model: "mock/worker-a" }),
							tool("swarm", { action: "add", name: "solo", brief: "wait", channels: ["api"], model: "mock/worker-a" }),
						],
					},
				},
				waitAgain,
			],
			default: { tools: [tool("swarm", { action: "channel", op: "create", channel: "api", topic: "the api" })] },
		},
		"worker-a": {
			rules: [
				{ when: "You are `(g-1|g-2|solo)`", reply: { tools: [tool("post_message", { text: "READY-x" })] } },
				{ when: "^tool: .*ping-group", reply: { tools: [tool("post_message", { text: "@coordinator PONG-g" })] } },
				{ when: "^tool: .*ping-api", reply: { tools: [tool("post_message", { text: "@coordinator PONG-api" })] } },
				{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
			],
			default: { tools: [tool("swarm_wait", {})] },
		},
	}),
	runs: [{ prompt: "channels" }],
	check: (c, k) => {
		k.eq(metrics(c)?.outcome?.value, "complete", "outcome");
		const b = board(c);
		const by = (agent: string, text: string) => b.filter(m => m.agent === agent && m.text.includes(text)).length;
		k.eq(by("solo", "PONG-api"), 1, "solo answered @#api once");
		k.eq(by("g-1", "PONG-api") + by("g-2", "PONG-api"), 0, "the group was not woken by @#api");
		k.eq([by("g-1", "PONG-g"), by("g-2", "PONG-g")], [1, 1], "@g woke both group members once");
		k.eq(by("solo", "PONG-g"), 0, "solo was not woken by @g");
	},
};

const D4: Scenario = {
	id: "D4",
	title: "a worker on always-429 fails once, the coordinator is notified and switches it; it resumes",
	script: () => ({
		coord: {
			rules: [
				accepted,
				{ when: "^tool:", whenAny: all("RECOVERED"), reply: finish("q recovered") },
				{ when: '"woke":"notice"', times: 1, reply: { tools: [tool("swarm", { action: "model", name: "q", model: "mock/worker-a" })] } },
				waitAgain,
			],
			default: { tools: [tool("swarm", { action: "add", name: "q", brief: "do it", model: "mock/always-429", effort: "low" })] },
		},
		"always-429": { rules: [], default: { status: 429, text: "rate limit exceeded (429): RESOURCE_EXHAUSTED" } },
		"worker-a": {
			rules: [
				{ when: "Your model is now mock/worker-a", reply: { tools: [tool("post_message", { text: "@coordinator [done] RECOVERED" })] } },
				{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
			],
		},
	}),
	runs: [{ prompt: "quota" }],
	check: (c, k) => {
		const m = metrics(c);
		k.eq(m?.outcome?.value, "complete", "outcome");
		k.eq(m?.members.q?.failures, 1, "one failure");
		k.eq(m?.members.q?.killed, false, "not killed");
		k.eq(roster(c).q?.model, "mock/worker-a", "switched model");
		k.ok(coordinatorTranscript(c).includes("turn failed (quota)"), "the failure notice reached the coordinator");
	},
};

const D5: Scenario = {
	id: "D5",
	title: "share ×3 on a dirty repo, then kills: clean removed, dirty preserved as WIP, ignored retained",
	setup: c => {
		writeFileSync(join(c.repo, "app.txt"), "v2-dirty\n");
		writeFileSync(join(c.repo, "untracked.txt"), "u\n");
		writeFileSync(join(c.repo, "noise.log"), "ignored\n");
		(c as Ctx & { statusBefore?: string }).statusBefore = gitOut(c.repo, "status", "--porcelain=v1");
	},
	script: () => ({
		coord: {
			rules: [
				accepted,
				// The retained kill raises a workspace_retained notice (§9.4) that must be read before finish.
				{ when: '"woke":"notice".*s3.s workspace .* was kept', reply: finish("workspaces handled") },
				{
					when: "^tool:",
					whenAny: all("READY-s1", "READY-s2", "READY-s3"),
					times: 1,
					reply: { tools: [tool("swarm", { action: "kill", name: "s1" }), tool("swarm", { action: "kill", name: "s2" }), tool("swarm", { action: "kill", name: "s3" })] },
				},
				waitAgain,
			],
			default: {
				tools: ["s1", "s2", "s3"].map(n => tool("swarm", { action: "add", name: n, brief: "work in your worktree", workspace: "share", model: "mock/worker-a" })),
			},
		},
		"worker-a": {
			rules: [
				{ when: "You are `s1`", reply: { tools: [tool("post_message", { text: "READY-s1" })] } },
				{ when: "You are `s2`", reply: { tools: [tool("bash", { command: "echo wip > wip.txt && echo DID-s2" })] } },
				{ when: "You are `s3`", reply: { tools: [tool("bash", { command: "echo x > build.log && echo DID-s3" })] } },
				{ when: "^tool: .*DID-s2", reply: { tools: [tool("post_message", { text: "READY-s2" })] } },
				{ when: "^tool: .*DID-s3", reply: { tools: [tool("post_message", { text: "READY-s3" })] } },
				{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
			],
		},
	}),
	runs: [{ prompt: "worktrees" }],
	check: (c, k) => {
		k.eq(metrics(c)?.outcome?.value, "complete", "outcome");
		k.eq(gitOut(c.repo, "status", "--porcelain=v1"), (c as Ctx & { statusBefore?: string }).statusBefore, "the source repo status is unchanged");
		const r = roster(c);
		const sid = JSON.parse(readFileSync(join(c.swarm, "members.json"), "utf8")).id as string;
		k.eq(r.s1?.workspace.state, "removed", "clean worktree removed");
		k.eq(r.s2?.workspace.state, "removed", "dirty worktree removed after WIP");
		k.eq(r.s3?.workspace.state, "retained", "ignored files keep the worktree");
		k.ok(r.s3?.workspace.retained_reason?.includes("ignored entries"), "retained reason names the ignored files");
		const wip = gitOut(c.repo, "rev-parse", `refs/swarm/${sid}/s2/wip`).trim();
		k.eq(gitOut(c.repo, "show", `${wip}:wip.txt`), "wip\n", "WIP commit holds the uncommitted file");
		k.eq(gitOut(c.repo, "show", `${wip}:app.txt`), "v2-dirty\n", "the snapshot carried the coordinator's dirty work");
		k.ok(gitOut(c.repo, "branch", "--list", `swarm/${sid}/*`).split("\n").filter(Boolean).length === 3, "branches are never deleted");
	},
};

const D6: Scenario = {
	id: "D6",
	title: "the coordinator stops right after add: the gate holds the run until the worker reports",
	script: () => ({
		coord: {
			rules: [accepted, { when: "DONE-w", reply: finish("w reported") }, { when: "headless run", reply: { tools: [tool("swarm_wait", {})] } }, { when: '"added"', reply: { text: "I started the worker." } }],
			default: { tools: [tool("swarm", { action: "add", name: "w", brief: "report", model: "mock/worker-a" })] },
		},
		"worker-a": {
			rules: [
				{ when: "You are `w`", reply: { delay: 500, tools: [tool("post_message", { text: "@coordinator [done] DONE-w" })] } },
				{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
			],
		},
	}),
	runs: [{ prompt: "kick off and summarize" }],
	check: (c, k) => {
		const m = metrics(c);
		k.eq(m?.outcome?.value, "complete", "outcome");
		k.ok((m?.coordinator?.gate_refusals ?? 0) >= 1, "the gate refused at least one stop");
		const b = board(c);
		const w = b.findIndex(x => x.text.includes("DONE-w"));
		const d = b.findIndex(x => x.agent === "coordinator" && x.text.startsWith("[done]"));
		k.ok(w >= 0 && d > w, "the coordinator finished only after the worker's report");
	},
};

const D7: Scenario = {
	id: "D7",
	title: "an early [done] is not a completion until the later result is read and [done] is posted again",
	script: () => ({
		coord: {
			rules: [
				accepted,
				{ when: "^tool:.*DONE-w", reply: { tools: [tool("post_message", { text: "[done] verified after reading the result" })] } },
				{ when: '"completion":"pending', reply: { tools: [tool("swarm_wait", {})] } },
				{ when: '"added"', reply: { tools: [tool("post_message", { text: "[done] premature" })] } },
				waitAgain,
			],
			default: { tools: [tool("swarm", { action: "add", name: "w", brief: "report", model: "mock/worker-a" })] },
		},
		"worker-a": {
			rules: [
				{ when: "You are `w`", reply: { delay: 300, tools: [tool("post_message", { text: "@coordinator [done] DONE-w" })] } },
				{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
			],
		},
	}),
	runs: [{ prompt: "early done" }],
	check: (c, k) => {
		k.eq(metrics(c)?.outcome?.value, "complete", "outcome");
		const b = board(c);
		const pre = b.findIndex(x => x.text === "[done] premature");
		const w = b.findIndex(x => x.text.includes("DONE-w"));
		const fin = b.findIndex(x => x.text.startsWith("[done] verified"));
		k.ok(pre >= 0 && w > pre && fin > w, "premature [done] < worker result < final [done]");
	},
};

const D8: Scenario = {
	id: "D8",
	title: "a silent worker is nudged once; an unaddressed result reaches the parked coordinator",
	script: () => ({
		coord: {
			rules: [accepted, { when: "^tool:", whenAny: all("RESULT-B"), reply: finish("b's result read") }, waitAgain],
			default: {
				tools: [
					tool("swarm", { action: "add", name: "a", brief: "answer quietly", model: "mock/worker-a" }),
					tool("swarm", { action: "add", name: "b", brief: "post a result", model: "mock/worker-b" }),
				],
			},
		},
		"worker-a": { rules: [{ when: "You are `a`", reply: { text: "I am done." } }], default: { text: "still nothing to post" } },
		"worker-b": { rules: reporter("b", "RESULT-B with no mention") },
	}),
	runs: [{ prompt: "nudges" }],
	check: (c, k) => {
		const m = metrics(c);
		k.eq(m?.outcome?.value, "complete", "outcome");
		k.eq(m?.members.a?.nudges, 1, "one nudge for the silent worker");
		k.ok(requests(c, "worker-a").some(q => q.last.includes("You were asked something and have not posted")), "the nudge reached the worker");
	},
};

const D9: Scenario = {
	id: "D9",
	title: "a coordinator that never waits ends incomplete after the refusal budget",
	script: () => ({
		coord: {
			rules: [
				{ when: '"added"', reply: { text: "Started; not waiting." } },
				// Every gate refusal is answered by stopping again, never by waiting.
				{ when: "Call swarm_wait now", reply: { text: "Still not waiting." } },
			],
			default: { tools: [tool("swarm", { action: "add", name: "w", brief: "wait a while", model: "mock/worker-a" })] },
		},
		"worker-a": {
			rules: [
				{ when: "You are `w`", reply: { tools: [tool("swarm_wait", { timeout_seconds: 600 })] } },
				{ when: '"woke":"nudge"', reply: { tools: [tool("swarm_wait", { timeout_seconds: 600 })] } },
			],
		},
	}),
	runs: [{ prompt: "no waiting", env: { OMP_SWARM_GATE_MAX_REFUSALS: "2", OMP_SWARM_GATE_WAIT_SECONDS: "1" } }],
	check: (c, k) => {
		k.eq(metrics(c)?.outcome?.value, "incomplete", "outcome");
		k.ok(c.runs[0]?.stderr.includes("omp-agy-swarm: outcome=incomplete"), "one stderr outcome line");
	},
};

const D10: Scenario = {
	id: "D10",
	title: "SIGKILL between a post and its delivery; the resumed run revives and delivers it once",
	script: () => ({
		coord: {
			rules: [
				{ when: '"seq":\\d+,"channel":"main","mentions":\\["w"\\]', reply: { delay: 5000, text: "waiting for the crash" } },
				{ when: "^tool:", whenAny: all("READY-w"), times: 1, reply: { tools: [tool("post_message", { text: "@w here is NEXT-STEP" })] } },
				waitAgain,
			],
			default: { tools: [tool("swarm", { action: "add", name: "w", brief: "get ready", model: "mock/worker-a" })] },
		},
		"worker-a": {
			rules: [
				{ when: "You are `w`", reply: { tools: [tool("post_message", { text: "READY-w" })] } },
				{ when: "NEXT-STEP", reply: { delay: 3000, tools: [tool("post_message", { text: "@coordinator late" })] } },
				{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
			],
		},
	}),
	runs: [
		{
			prompt: "first run",
			killWhen: c => board(c).some(m => m.text.includes("NEXT-STEP")),
		},
		{
			prompt: "resume the swarm",
			args: ["--continue"],
			script: () => ({
				coord: {
					rules: [accepted, { when: "^tool:", whenAny: all("GOT-NEXT"), reply: finish("w got the step after the restart") }, waitAgain],
					default: { tools: [tool("swarm", { action: "revive" })] },
				},
				"worker-a": {
					rules: [
						{ when: "You were stopped by a restart", reply: { tools: [tool("post_message", { text: "@coordinator [done] GOT-NEXT" })] } },
						{ when: '^tool: \\{"seq":', reply: { tools: [tool("swarm_wait", {})] } },
					],
				},
			}),
		},
	],
	check: (c, k) => {
		k.eq(metrics(c)?.outcome?.value, "complete", "outcome of the resumed run");
		const r = roster(c);
		k.ok(r.w?.conversation_id, "same member");
		const wakes = requests(c, "worker-a").filter(q => q.last.includes("You were stopped by a restart"));
		k.eq(wakes.length, 1, "one revival wake");
		k.ok(wakes[0]?.last.includes("NEXT-STEP"), "the owed post was delivered by the revival");
		const files = readdirSync(join(c.swarm, "sessions")).filter(f => f.endsWith(".jsonl"));
		k.eq(files.length, 1, "the worker's conversation was reused, not recreated");
	},
	maxMs: 120_000,
};

const D11: Scenario = {
	id: "D11",
	title: "a deleted transcript makes the member lost; it is never recreated",
	script: () => ({
		coord: basicCoordinator({ name: "w", brief: "report", model: "mock/worker-a" }, ["DONE-w"]),
		"worker-a": { rules: reporter("w", "@coordinator [done] DONE-w") },
	}),
	runs: [
		{ prompt: "first" },
		{
			prompt: "again",
			args: ["--continue"],
			before: c => {
				for (const f of readdirSync(join(c.swarm, "sessions"))) rmSync(join(c.swarm, "sessions", f), { recursive: true, force: true });
			},
			script: () => ({
				coord: {
					rules: [
						{ when: '"woke":"notice"', reply: { tools: [tool("swarm", { action: "status" })] } },
						{ when: '"reviving"', reply: { tools: [tool("swarm_wait", {})] } },
						{ when: '"members"', reply: { text: "FINAL: w is lost" } },
					],
					default: { tools: [tool("swarm", { action: "revive", name: "w" })] },
				},
			}),
		},
	],
	check: (c, k) => {
		const r = roster(c);
		k.eq(r.w?.failure?.kind, "lost", "member lost");
		k.ok(coordinatorTranscript(c).includes("could not be revived (lost)"), "the coordinator was notified");
		k.eq(readdirSync(join(c.swarm, "sessions")).filter(f => f.endsWith(".jsonl")).length, 0, "never recreated");
	},
};

const D12: Scenario = {
	id: "D12",
	title: "approval modes: always-ask refuses add headless; write allows posts but not exec",
	script: () => ({
		coord: {
			rules: [{ when: "^tool:", times: 1, reply: { text: "FINAL: refused" } }],
			default: { tools: [tool("swarm", { action: "add", name: "w", brief: "x", model: "mock/worker-a" })] },
		},
	}),
	runs: [
		{ prompt: "always ask", args: ["--approval-mode", "always-ask"] },
		{
			prompt: "write mode",
			args: ["--approval-mode", "write"],
			script: () => ({
				coord: {
					rules: [
						{ when: '"title"', reply: { tools: [tool("post_message", { text: "POSTED-IN-WRITE-MODE" })] } },
						{ when: '"seq"', reply: { tools: [tool("swarm", { action: "add", name: "w2", brief: "x", model: "mock/worker-a" })] } },
						{ when: "^tool:", reply: { text: "FINAL: done" } },
					],
					default: { tools: [tool("swarm", { action: "title", title: "write mode" })] },
				},
			}),
		},
	],
	check: (c, k) => {
		const r = roster(c);
		k.ok(!r.w && !r.w2, "nothing was spawned");
		k.ok(board(c).some(m => m.text === "POSTED-IN-WRITE-MODE"), "a write-tier post works in write mode");
		k.ok(!requests(c, "worker-a").length, "no worker request was made");
	},
};

export const DETERMINISTIC: Scenario[] = [D0a, D0b, D0c, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12];
