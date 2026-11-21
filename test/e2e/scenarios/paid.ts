// Opt-in paid suite (§12.5): real providers through the user's agent dir. Requires OMP_SWARM_PAID=1.
//
// R1–R8 run one at a time against a fresh fixture repo and OMP_SWARM_DIR each. The suite ceiling
// (default 15 USD, 90 minutes) is enforced twice: every run gets OMP_SWARM_MAX_COST_USD set to the
// remaining budget (the plugin's live accounting stops admitting work, SW-13), and the harness
// polls metrics.json and kills a run whose spend would cross the suite ceiling. Each scenario's
// stdout (json mode events) and stderr are kept under its temp dir for the checks and for review.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MockLlm } from "../mock-llm/server.ts";
import { PROVIDER, REPO } from "../scenario.ts";

const W = { haiku: "anthropic/claude-haiku-5-5", luna: "openai-codex/gpt-6-luna", deepseek: "opencode-go/deepseek-v4.1-flash" };
const COORDINATOR = "google/gemini-4-neon";

export interface PaidCtx {
	swarm: string;
	repo: string;
	stdout: string;
	stderr: string;
}

export interface PaidScenario {
	id: string;
	prompt: string;
	/** Extra fixture files written and committed before the run. */
	fixture?: Record<string, string>;
	/** Starts the scripted mock provider (R6) and loads its extension next to the plugin. */
	mock?: boolean;
	check(c: PaidCtx): string[];
}

type Roster = { members: Record<string, { model: string; effort: string; failure?: unknown; killed?: boolean; session_file?: string | null }> };
type MemberMetrics = { failures: number; wakes: number; cost: number };
type Metrics = { outcome?: { value: string }; spend?: { cost: number }; members?: Record<string, MemberMetrics> };
type Entry = { type?: string; thinkingLevel?: string | null; message?: { role?: string; provider?: string; model?: string } };
type Post = { seq: number; agent: string; text: string };

function json<T>(p: string): T | undefined {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return undefined;
	}
}

const roster = (c: PaidCtx) => json<Roster>(join(c.swarm, "members.json"));
const metrics = (c: PaidCtx) => json<Metrics>(join(c.swarm, "metrics.json"));

function board(c: PaidCtx): Post[] {
	try {
		return readFileSync(join(c.swarm, "board.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map(l => JSON.parse(l) as Post);
	} catch {
		return [];
	}
}

/** A worker's own JSONL entries (its session file under the swarm's sessions dir). */
function entries(c: PaidCtx, name: string): Entry[] {
	const file = roster(c)?.members[name]?.session_file;
	if (!file) return [];
	const path = join(c.swarm, "sessions", basename(file));
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => {
			try {
				return JSON.parse(l) as Entry;
			} catch {
				return {};
			}
		});
}

/** `provider/model` of every assistant message a worker's transcript holds, in order. */
function assistantModels(c: PaidCtx, name: string): string[] {
	return entries(c, name)
		.filter(e => e.type === "message" && e.message?.role === "assistant")
		.map(e => `${e.message?.provider ?? "?"}/${e.message?.model ?? "?"}`);
}

function effortEntries(c: PaidCtx, name: string): (string | null | undefined)[] {
	return entries(c, name)
		.filter(e => e.type === "thinking_level_change")
		.map(e => e.thinkingLevel);
}

function fileIs(c: PaidCtx, rel: string, want: string, f: string[]): void {
	try {
		const got = readFileSync(join(c.repo, rel), "utf8").trim();
		if (got !== want) f.push(`${rel} holds ${JSON.stringify(got.slice(0, 40))}, expected ${JSON.stringify(want)}`);
	} catch {
		f.push(`${rel} missing`);
	}
}

function complete(c: PaidCtx, f: string[]): void {
	const v = metrics(c)?.outcome?.value;
	if (v !== "complete") f.push(`outcome ${v ?? "none"}, expected complete`);
}

/** Roster model/effort, every assistant turn on the model, and the effort recorded in the JSONL. */
function onModel(c: PaidCtx, name: string, model: string, effort: string, f: string[]): void {
	const r = roster(c)?.members[name];
	if (r?.model !== model) f.push(`${name} roster model ${r?.model}`);
	if (r?.effort !== effort) f.push(`${name} roster effort ${r?.effort}`);
	const models = assistantModels(c, name);
	if (!models.length) f.push(`${name}: no assistant turns in its JSONL`);
	const off = models.filter(m => m !== model);
	if (off.length) f.push(`${name}: assistant turns on ${[...new Set(off)].join(", ")}`);
	const efforts = effortEntries(c, name);
	if (efforts.at(-1) !== effort) f.push(`${name}: last JSONL effort entry ${String(efforts.at(-1))}, expected ${effort}`);
}

/** Collapses consecutive repeats: the order of models a worker actually ran on. */
function runs(models: string[]): string[] {
	return models.filter((m, i) => i === 0 || models[i - 1] !== m);
}

const CALC_TEST = `import { expect, test } from "bun:test";
import { add } from "./src/add.ts";
import { mul } from "./src/mul.ts";
import { sub } from "./src/sub.ts";

test("add", () => expect(add(2, 3)).toBe(5));
test("sub", () => expect(sub(7, 4)).toBe(3));
test("mul", () => expect(mul(6, 7)).toBe(42));
`;
const stub = (name: string) => `export function ${name}(_a: number, _b: number): number {\n\tthrow new Error("not implemented");\n}\n`;

export const PAID: PaidScenario[] = [
	{
		id: "R1",
		prompt: `Use the swarm (read skill://swarm first). Add three workers: alpha on ${W.haiku} with effort low, beta on ${W.luna} with effort medium, gamma on ${W.deepseek} with effort high. Each writes <name>.txt containing exactly its own name and reports [done]. Wait for all three, verify the files, then finish.`,
		check: c => {
			const f: string[] = [];
			onModel(c, "alpha", W.haiku, "low", f);
			onModel(c, "beta", W.luna, "medium", f);
			onModel(c, "gamma", W.deepseek, "high", f);
			for (const n of ["alpha", "beta", "gamma"]) fileIs(c, `${n}.txt`, n, f);
			complete(c, f);
			return f;
		},
	},
	{
		id: "R2",
		prompt: `Use the swarm. Add worker alpha on ${W.deepseek} with effort medium and worker beta on ${W.luna} with effort low; each posts READY and waits. When both are ready, change beta's effort to high (effort only, same model), ask beta to post DONE-HIGH, then finish.`,
		check: c => {
			const f: string[] = [];
			if (!c.stdout.includes("'medium' → 'low'")) f.push("the clamp note ('medium' → 'low') never reached the coordinator");
			onModel(c, "alpha", W.deepseek, "low", f);
			onModel(c, "beta", W.luna, "high", f);
			if (!effortEntries(c, "beta").includes("low")) f.push("beta's JSONL never recorded its starting effort low");
			if (!board(c).some(p => p.agent === "beta" && p.text.includes("DONE-HIGH"))) f.push("beta did not post DONE-HIGH after the switch");
			complete(c, f);
			return f;
		},
	},
	{
		id: "R3",
		prompt: `Use the swarm. Add worker sw on ${W.haiku} with effort low and this brief: "Whenever you are asked for step N, create the file step-N.txt containing just N using a tool, then post [done] step N and wait." Ask sw for step 1. After it reports, switch sw's model to ${W.luna} and ask for step 2; after that, switch it to ${W.deepseek} and ask for step 3; after that, switch it back to ${W.haiku} and ask for step 4. Never kill or replace sw. When step 4 is reported, finish.`,
		check: c => {
			const f: string[] = [];
			for (let k = 1; k <= 4; k++) fileIs(c, `step-${k}.txt`, String(k), f);
			const order = runs(assistantModels(c, "sw"));
			const want = [W.haiku, W.luna, W.deepseek, W.haiku];
			if (JSON.stringify(order) !== JSON.stringify(want)) f.push(`sw ran on ${order.join(" → ") || "nothing"}, expected ${want.join(" → ")}`);
			const r = roster(c)?.members.sw;
			if (r?.failure) f.push(`sw failure ${JSON.stringify(r.failure)}`);
			if ((metrics(c)?.members?.sw?.failures ?? 0) !== 0) f.push(`sw failed ${metrics(c)?.members?.sw?.failures} times`);
			complete(c, f);
			return f;
		},
	},
	{
		id: "R4",
		fixture: { "calc.test.ts": CALC_TEST, "src/add.ts": stub("add"), "src/sub.ts": stub("sub"), "src/mul.ts": stub("mul") },
		prompt: `Use the swarm. The repo has calc.test.ts and three stubs in src/. Add a group named author with workspace share and three tasks: "implement add in src/add.ts", "implement sub in src/sub.ts", "implement mul in src/mul.ts"; each author commits its change on its own branch, runs bun test for its function, and reports [done] with its branch. Then add a worker named verifier with workspace share that reviews the three branches (git log and git diff against the base) and reports. Then land the three branches into your working copy with git merge, run bun test there, and finish only when it passes.`,
		check: c => {
			const f: string[] = [];
			const t = spawnSync("bun", ["test"], { cwd: c.repo, encoding: "utf8", timeout: 120_000 });
			if (t.status !== 0) f.push(`bun test in the coordinator's working copy failed: ${(t.stderr || t.stdout).slice(-400)}`);
			for (const n of ["add", "sub", "mul"])
				if (readFileSync(join(c.repo, "src", `${n}.ts`), "utf8").includes("not implemented")) f.push(`src/${n}.ts was not landed`);
			const r = roster(c);
			const authors = Object.entries(r?.members ?? {}).filter(([n]) => n.startsWith("author-"));
			if (authors.length !== 3) f.push(`${authors.length} authors, expected 3`);
			if (!r?.members.verifier) f.push("no verifier was added");
			complete(c, f);
			return f;
		},
	},
	{
		id: "R5",
		prompt: `Use the swarm. Create channels api and ui. Add workers api-1 and api-2 subscribed to api (brief: "you own the API; answer questions asked on #api"), and ui-1 and ui-2 subscribed to ui (brief: "you own the UI"). Ask ui-1 to ask the api channel, with a post addressed to @#api, which endpoint lists users, and to report the answer to you. When ui-1 reports, finish.`,
		check: c => {
			const f: string[] = [];
			const posts = board(c);
			const ask = posts.find(p => p.agent.startsWith("ui-") && p.text.includes("@#api"));
			if (!ask) f.push("no ui worker asked @#api");
			else if (!posts.some(p => p.seq > ask.seq && p.agent.startsWith("api-"))) f.push("no api worker answered after the @#api ask");
			for (const [n, m] of Object.entries(metrics(c)?.members ?? {}))
				if (m.wakes > 8) f.push(`${n} was woken ${m.wakes} times (bound 8)`);
			complete(c, f);
			return f;
		},
	},
	{
		id: "R6",
		mock: true,
		prompt: `Use the swarm. Add worker q on mock/always-429 with effort low; its brief: "create q.txt containing ok, then report [done]". If q fails, switch its model to ${W.haiku} and let it continue — do not kill or replace it. When q reports, finish.`,
		check: c => {
			const f: string[] = [];
			const q = roster(c)?.members.q;
			if (!q) f.push("q was never added");
			else {
				if (q.killed) f.push("q was killed instead of switched");
				if (q.model !== W.haiku) f.push(`q ends on ${q.model}, expected ${W.haiku}`);
			}
			if ((metrics(c)?.members?.q?.failures ?? 0) < 1) f.push("q never failed on the always-429 model");
			fileIs(c, "q.txt", "ok", f);
			complete(c, f);
			return f;
		},
	},
	{
		id: "R7",
		prompt: `Kick off one swarm worker on ${W.haiku} that computes 17*23 and reports the number, then summarize.`,
		check: c => {
			const f: string[] = [];
			if (!board(c).some(p => p.agent !== "coordinator" && p.text.includes("391"))) f.push("the worker never posted 391");
			if (!c.stdout.includes("391")) f.push("the coordinator's final answer does not include 391");
			complete(c, f);
			return f;
		},
	},
	{
		id: "R8",
		prompt: `Use the swarm. Add a group named slice on ${W.haiku} with effort low and six tasks: task k writes slice-k.txt containing just the number k (k = 1..6) and reports [done] with k. Aggregate the six results: your final answer must state the sum of the six numbers. Then finish.`,
		check: c => {
			const f: string[] = [];
			for (let k = 1; k <= 6; k++) fileIs(c, `slice-${k}.txt`, String(k), f);
			const done = board(c).filter(p => p.agent.startsWith("slice-") && p.text.includes("[done]"));
			if (new Set(done.map(p => p.agent)).size !== 6) f.push(`${new Set(done.map(p => p.agent)).size} slices reported [done], expected 6`);
			if (!c.stdout.includes("21")) f.push("the final answer does not state the aggregate (21)");
			complete(c, f);
			return f;
		},
	},
];

function git(repo: string, ...a: string[]): void {
	execFileSync("git", ["-C", repo, "-c", "user.email=e@e", "-c", "user.name=e", ...a]);
}

export async function runPaid(ids: string[], list: PaidScenario[]): Promise<number> {
	if (process.env.OMP_SWARM_PAID !== "1") {
		console.log("The paid suite spends real provider quota. Set OMP_SWARM_PAID=1 to run it.");
		return 2;
	}
	const ceiling = Number(process.env.OMP_SWARM_PAID_CEILING_USD ?? "15");
	const deadline = performance.now() + Number(process.env.OMP_SWARM_PAID_MINUTES ?? "90") * 60_000;
	let spent = 0;
	let failed = 0;
	for (const s of ids.length ? list.filter(x => ids.includes(x.id)) : list) {
		const remaining = ceiling - spent;
		if (remaining <= 0 || performance.now() > deadline) {
			console.log(`STOP before ${s.id}: suite ceiling reached ($${spent.toFixed(2)} of $${ceiling}) or time is up`);
			failed++;
			break;
		}
		const T = mkdtempSync(join(tmpdir(), `omp-swarm-paid-${s.id}-`));
		const repo = join(T, "repo");
		mkdirSync(repo);
		execFileSync("git", ["-C", repo, "init", "-q"]);
		writeFileSync(join(repo, "README.md"), "# paid fixture\n");
		for (const [rel, text] of Object.entries(s.fixture ?? {})) {
			mkdirSync(join(repo, rel, ".."), { recursive: true });
			writeFileSync(join(repo, rel), text);
		}
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
		const swarm = join(T, "swarm");
		const mock = s.mock ? new MockLlm({ "always-429": { rules: [], default: { status: 429, text: "rate limit exceeded (429): RESOURCE_EXHAUSTED" } } }, join(T, "mock.jsonl")) : undefined;
		const mockPort = mock?.start();
		const proc = Bun.spawn(
			[
				"omp",
				"-p",
				s.prompt,
				"--model",
				COORDINATOR,
				"--mode",
				"json",
				"--max-time",
				"20m",
				"--max-cost",
				"2",
				"--no-extensions",
				"-e",
				REPO,
				...(mock ? ["-e", PROVIDER] : []),
			],
			{
				cwd: repo,
				env: {
					...process.env,
					OMP_SWARM_DIR: swarm,
					OMP_SWARM_MAX_WORKERS: "8",
					OMP_SWARM_MAX_COST_USD: remaining.toFixed(2),
					OMP_SWARM_DEADLINE_SECONDS: "1200",
					...(mockPort ? { MOCK_PORT: String(mockPort) } : {}),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const out = new Response(proc.stdout).text();
		const err = new Response(proc.stderr).text();
		let killed = "";
		const kill = (why: string): void => {
			if (killed) return;
			killed = why;
			proc.kill("SIGTERM");
		};
		const timer = setTimeout(() => kill("suite time is up"), Math.max(0, deadline - performance.now()));
		// The hard ceiling: the run's own live spend plus what the suite already spent.
		const watch = setInterval(() => {
			const cost = json<Metrics>(join(swarm, "metrics.json"))?.spend?.cost ?? 0;
			if (spent + cost > ceiling) kill(`suite ceiling $${ceiling} crossed`);
		}, 5_000);
		await proc.exited;
		clearTimeout(timer);
		clearInterval(watch);
		mock?.stop();
		const c: PaidCtx = { swarm, repo, stdout: await out, stderr: await err };
		writeFileSync(join(T, "stdout.jsonl"), c.stdout);
		writeFileSync(join(T, "stderr.txt"), c.stderr);
		spent += json<Metrics>(join(swarm, "metrics.json"))?.spend?.cost ?? 0;
		const f = s.check(c);
		if (killed) f.unshift(`killed: ${killed}`);
		console.log(`${f.length ? "FAIL" : "PASS"} ${s.id} (suite spend $${spent.toFixed(2)}) ${T}`);
		for (const x of f) console.log(`  - ${x}`);
		if (f.length) failed++;
	}
	return failed ? 1 : 0;
}
