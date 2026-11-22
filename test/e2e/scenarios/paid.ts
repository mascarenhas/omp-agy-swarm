// Legacy real-provider breadth checks; R9–R12 are in paid-native.ts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { board, metrics, roster } from "../check.ts";
import { type PaidScenario, W } from "../paid-contract.ts";
import { contentText, entries, evidence, type Frame, type PaidCtx } from "../paid-evidence.ts";
import { NATIVE_PAID } from "./paid-native.ts";
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

function finalText(c: PaidCtx): string {
	for (const line of c.stdout.trimEnd().split("\n").reverse()) {
		if (!line.startsWith("{")) continue;
		const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
		if (e.type === "message_end" && e.message?.role === "assistant") return contentText(e.message.content);
	}
	return "";
}

/** Roster model/effort, every assistant turn on the model, and the effort recorded in the JSONL. */
function onModel(c: PaidCtx, name: string, model: string, effort: string, f: string[]): void {
	const r = roster(c)[name];
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
		check: (c, { failures: f }) => {
			onModel(c, "alpha", W.haiku, "low", f);
			onModel(c, "beta", W.luna, "medium", f);
			onModel(c, "gamma", W.deepseek, "high", f);
			for (const n of ["alpha", "beta", "gamma"]) fileIs(c, `${n}.txt`, n, f);
		},
	},
	{
		id: "R2",
		prompt: `Use the swarm. Add worker alpha on ${W.deepseek} with effort medium and worker beta on ${W.luna} with effort low; each posts READY and waits. For the beta add, explicitly include the optional defaults n:0, tasks:[], fork:"", and channels:[] alongside the ordinary arguments. When both are ready, change beta's effort to high (effort only, same model), ask beta to post DONE-HIGH, then finish.`,
		check: (c, { failures: f }) => {
			if (Object.keys(roster(c)).filter(name => name !== "coordinator").sort().join(",") !== "alpha,beta") f.push("padded add did not create exactly the two named workers");
			if (!evidence(c).some(row => row.kind === "event" && row.id === "Main" && row.swarmArgs?.action === "add" &&
				row.swarmArgs.name === "beta" && row.swarmArgs.n === 0 && row.swarmArgs.tasks === 0 && row.swarmArgs.fork === ""))
				f.push("beta add lacks an observed padded-parameter call");
			if (!c.stdout.includes("'medium' → 'low'")) f.push("the clamp note ('medium' → 'low') never reached the coordinator");
			onModel(c, "alpha", W.deepseek, "low", f);
			onModel(c, "beta", W.luna, "high", f);
			if (!effortEntries(c, "beta").includes("low")) f.push("beta's JSONL never recorded its starting effort low");
			if (!board(c).some(p => p.agent === "beta" && p.text.includes("DONE-HIGH"))) f.push("beta did not post DONE-HIGH after the switch");
		},
	},
	{
		id: "R3",
		prompt: `Use the swarm. Add worker sw on ${W.haiku} with effort low and this brief: "Whenever you are asked for step N, create the file step-N.txt containing just N using a tool, then post [done] step N and wait." Ask sw for step 1. After it reports, switch sw's model to ${W.luna} and ask for step 2; after that, switch it to ${W.deepseek} and ask for step 3; after that, switch it back to ${W.haiku} and ask for step 4. Never kill or replace sw. When step 4 is reported, finish.`,
		check: (c, { failures: f }) => {
			for (let k = 1; k <= 4; k++) fileIs(c, `step-${k}.txt`, String(k), f);
			const order = runs(assistantModels(c, "sw"));
			const want = [W.haiku, W.luna, W.deepseek, W.haiku];
			if (JSON.stringify(order) !== JSON.stringify(want)) f.push(`sw ran on ${order.join(" → ") || "nothing"}, expected ${want.join(" → ")}`);
			const r = roster(c).sw;
			const attached = evidence(c).filter((row): row is Frame<"ref"> => row.kind === "ref" && row.id === r?.agent_id && row.attached);
			const native = [...new Set(attached.map(row => row.generation))];
			if (!r?.agent_id || native.length !== 1 || attached.some(row => row.parentId !== undefined)) f.push("model switches did not preserve one root-level native worker ref");
			if (r?.failure) f.push(`sw failure ${JSON.stringify(r.failure)}`);
			if ((metrics(c)?.members?.sw?.failures ?? 0) !== 0) f.push(`sw failed ${metrics(c)?.members?.sw?.failures} times`);
		},
	},
	{
		id: "R4",
		fixture: { "calc.test.ts": CALC_TEST, "src/add.ts": stub("add"), "src/sub.ts": stub("sub"), "src/mul.ts": stub("mul") },
		prompt: `Use the swarm. The repo has calc.test.ts and three stubs in src/. Add a group named author with workspace share and three tasks: "implement add in src/add.ts", "implement sub in src/sub.ts", "implement mul in src/mul.ts"; each author commits its change on its own branch, runs bun test for its function, and reports [done] with its branch. Then add a worker named verifier with workspace share that reviews the three branches (git log and git diff against the base) and reports. Then land the three branches into your working copy with git merge, run bun test there, and finish only when it passes.`,
		check: (c, { failures: f }) => {
			const t = spawnSync("bun", ["test"], { cwd: c.repo, encoding: "utf8", timeout: 120_000 });
			if (t.status !== 0) f.push(`bun test in the coordinator's working copy failed: ${(t.stderr || t.stdout).slice(-400)}`);
			for (const n of ["add", "sub", "mul"])
				if (readFileSync(join(c.repo, "src", `${n}.ts`), "utf8").includes("not implemented")) f.push(`src/${n}.ts was not landed`);
			const r = roster(c);
			const authors = Object.entries(r).filter(([n]) => n.startsWith("author-"));
			if (authors.length !== 3) f.push(`${authors.length} authors, expected 3`);
			if (!r.verifier) f.push("no verifier was added");
			const workspaces = [...authors.map(([, member]) => member), ...(r.verifier ? [r.verifier] : [])];
			if (workspaces.some(member => member.workspace.mode !== "share" || member.workspace.path === c.repo) ||
				new Set(workspaces.map(member => member.workspace.path)).size !== 4) f.push("authors and verifier did not each use an isolated share worktree");
		},
	},
	{
		id: "R5",
		prompt: `Use the swarm. Create channels api and ui. Add workers api-1 and api-2 subscribed to api (brief: "you own the API; answer questions asked on #api"), and ui-1 and ui-2 subscribed to ui (brief: "you own the UI"). Ask ui-1 to ask the api channel, with a post addressed to @#api, which endpoint lists users, and to report the answer to you. When ui-1 reports, finish.`,
		check: (c, { failures: f }) => {
			const posts = board(c);
			const ask = posts.find(p => p.agent.startsWith("ui-") && p.text.includes("@#api"));
			if (!ask) f.push("no ui worker asked @#api");
			else if (!posts.some(p => p.seq > ask.seq && p.agent.startsWith("api-"))) f.push("no api worker answered after the @#api ask");
			for (const [n, m] of Object.entries(metrics(c)?.members ?? {}))
				if (m.wakes > 8) f.push(`${n} was woken ${m.wakes} times (bound 8)`);
		},
	},
	{
		id: "R6",
		mock: true,
		prompt: `Use the swarm. Add worker q on mock/always-429 with effort low; its brief: "create q.txt containing ok, then report [done]". If q fails, switch its model to ${W.haiku} and let it continue — do not kill or replace it. When q reports, finish.`,
		check: (c, { failures: f }) => {
			const q = roster(c).q;
			if (!q) f.push("q was never added");
			else {
				if (q.killed) f.push("q was killed instead of switched");
				if (q.model !== W.haiku) f.push(`q ends on ${q.model}, expected ${W.haiku}`);
			}
			if ((metrics(c)?.members?.q?.failures ?? 0) < 1) f.push("q never failed on the always-429 model");
			fileIs(c, "q.txt", "ok", f);
			if (!evidence(c).some(row => row.kind === "usage" && row.id === q?.agent_id && row.model === W.haiku && row.tokens > 0))
				f.push("no actual Haiku provider usage after mock 429");
		},
	},
	{
		id: "R7",
		prompt: `Kick off one swarm worker on ${W.haiku} that computes 17*23 and reports the number, then summarize.`,
		check: (c, { failures: f }) => {
			if (!board(c).some(p => p.agent !== "coordinator" && p.text.includes("391"))) f.push("the worker never posted 391");
			if (!/\b391\b/.test(finalText(c))) f.push("the coordinator's final answer does not include 391");
		},
	},
	{
		id: "R8",
		prompt: `Use the swarm. Add a group named slice on ${W.haiku} with effort low and six tasks: task k writes slice-k.txt containing just the number k (k = 1..6) and reports [done] with k. Aggregate the six results: your final answer must state the sum of the six numbers. Then finish.`,
		check: (c, { failures: f }) => {
			for (let k = 1; k <= 6; k++) fileIs(c, `slice-${k}.txt`, String(k), f);
			const done = board(c).filter(p => p.agent.startsWith("slice-") && p.text.includes("[done]"));
			if (new Set(done.map(p => p.agent)).size !== 6) f.push(`${new Set(done.map(p => p.agent)).size} slices reported [done], expected 6`);
			if (!/\b21\b/.test(finalText(c))) f.push("the final answer does not state the aggregate (21)");
		},
	},
	...NATIVE_PAID,
];

