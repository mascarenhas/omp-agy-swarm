// Hermetic end-to-end runner (§12.3): the real omp binary against a scripted mock provider, one
// fresh temp tree per scenario. `bun test/e2e/run.ts [ids…]`; `--paid` runs the opt-in paid suite.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOmpBin } from "../../scripts/omp-bin.ts";
import { Checks, type Ctx, treeHash } from "./check.ts";
import { MockLlm } from "./mock-llm/server.ts";
import { runOmp, type Scenario } from "./scenario.ts";
import { DETERMINISTIC } from "./scenarios/deterministic.ts";
import { PAID, runPaid } from "./scenarios/paid.ts";

function fixtureRepo(repo: string): void {
	mkdirSync(repo, { recursive: true });
	const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "e2e@example.com");
	git("config", "user.name", "e2e");
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	writeFileSync(join(repo, "app.txt"), "v1\n");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "lib.txt"), "lib\n");
	writeFileSync(join(repo, ".gitignore"), "*.log\nnode_modules/\n");
	git("add", ".");
	git("commit", "-q", "-m", "fixture");
}

async function runScenario(s: Scenario, keep: boolean): Promise<{ ok: boolean; ms: number; failures: string[] }> {
	const T = mkdtempSync(join(tmpdir(), `omp-swarm-e2e-${s.id}-`));
	const c: Ctx = {
		id: s.id,
		T,
		repo: join(T, "repo"),
		swarm: join(T, "swarm"),
		agent: join(T, "agent"),
		sessions: join(T, "sessions"),
		mock: new MockLlm({}, join(T, "mock.jsonl")),
		runs: [],
	};
	mkdirSync(c.agent, { recursive: true });
	// Fast, bounded retries and no usage-reset waits in the isolated agent dir.
	writeFileSync(join(c.agent, "config.yml"), "retry:\n  maxRetries: 1\n  baseDelayMs: 20\n  maxDelayMs: 50\n  waitForUsageReset: false\n");
	fixtureRepo(c.repo);
	const k = new Checks();
	const t0 = performance.now();
	try {
		c.mock.setScript(s.script(c));
		c.mock.start();
		await s.setup?.(c);
		const agentsBefore = treeHash(join(c.agent, "agents"));
		for (const run of s.runs) {
			if (run.script) c.mock.setScript(run.script(c));
			run.before?.(c);
			const r = await runOmp(c, run, !!s.noSwarmDirEnv);
			c.runs.push(r);
			k.ok(r.code !== null, `run ${c.runs.length}: the process did not exit`);
			k.eq(r.listeners, 0, `run ${c.runs.length}: listening sockets in omp`);
		}
		await s.check(c, k);
		k.eq(treeHash(join(c.agent, "agents")), agentsBefore, "agent profiles (agents/) unchanged");
		k.ok(performance.now() - t0 < (s.maxMs ?? 90_000), `wall time ${Math.round(performance.now() - t0)} ms within ${s.maxMs ?? 90_000} ms`);
	} catch (err) {
		k.failures.push(`harness error: ${(err as Error).stack ?? err}`);
	} finally {
		c.mock.stop();
	}
	const ms = performance.now() - t0;
	if (k.failures.length) {
		for (const [i, r] of c.runs.entries()) {
			console.log(`  run ${i + 1}: exit ${r.code} in ${Math.round(r.ms)} ms`);
			console.log(`  stdout: ${r.stdout.slice(-600).replace(/\n/g, "\n          ")}`);
			console.log(`  stderr: ${r.stderr.slice(-1500).replace(/\n/g, "\n          ")}`);
		}
		console.log(`  mock log: ${join(T, "mock.jsonl")}`);
	}
	if (!keep && !k.failures.length) rmSync(T, { recursive: true, force: true });
	return { ok: k.failures.length === 0, ms, failures: k.failures };
}

const args = process.argv.slice(2);
const keep = args.includes("--keep");
if (args.includes("--paid")) {
	process.exit(await runPaid(args.filter(a => !a.startsWith("--")), PAID));
}
const only = args.filter(a => !a.startsWith("--"));
const ompBin = resolveOmpBin();
const ompVersion = execFileSync(ompBin, ["--version"], { encoding: "utf8" }).trim();
console.log(`Host omp: ${ompVersion} (${ompBin})`);
const list = only.length ? DETERMINISTIC.filter(s => only.includes(s.id)) : DETERMINISTIC;
let failed = 0;
const started = performance.now();
for (const s of list) {
	const r = await runScenario(s, keep);
	console.log(`${r.ok ? "PASS" : "FAIL"} ${s.id} ${s.title} (${(r.ms / 1000).toFixed(1)} s)`);
	for (const f of r.failures) console.log(`  - ${f}`);
	if (!r.ok) failed++;
}
console.log(`\n${list.length - failed} passed, ${failed} failed, ${list.length} scenarios in ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
