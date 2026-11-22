import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { resolveOmpBin, stripNodeModulesBins } from "../../scripts/omp-bin.ts";
import { PtyOmp } from "../helpers/pty.ts";
import { Checks, metrics, treeHash } from "./check.ts";
import { MockLlm, type Script } from "./mock-llm/server.ts";
import { EFFORT, OBSERVER, type PaidScenario, SCOUT_PROVIDERS, W } from "./paid-contract.ts";
import { directBill, type Entry, evidence, jsonl, type PaidCtx, type Trace } from "./paid-evidence.ts";
import { driveHub, syncArtifactRoot } from "./paid-fixtures.ts";
import { PROVIDER, REPO } from "./scenario.ts";

const HARD_CEILING = 15;
const LEGACY_CAP = 2;
const LEGACY_TIMEOUT = 1200;
const VARIANCE_ESTIMATE = "$5–$7 for one combined pass (estimate, not approval or billing)";
const MOCK_429: Script = { "always-429": { rules: [], default: { status: 429, text: "rate limit exceeded (429): RESOURCE_EXHAUSTED" } } };

function selection(ids: string[], list: PaidScenario[]): PaidScenario[] {
	const unknown = ids.filter(id => !list.some(s => s.id === id));
	if (unknown.length) throw new Error(`unknown paid scenario(s): ${unknown.join(", ")}`);
	return ids.length ? list.filter(s => ids.includes(s.id)) : list;
}

/** Plan only: no host launch, network, auth reads, or artifact writes. */
export function planPaid(ids: string[], list: PaidScenario[]): number {
	try {
		for (const s of selection(ids, list)) console.log(`${s.id}: ${s.model ?? W.luna}:${EFFORT}, cap $${(s.cap ?? LEGACY_CAP).toFixed(2)}, ${s.maxSeconds ?? LEGACY_TIMEOUT}s, ${s.pty ? "native PTY" : "JSON"}`);
		console.log(`Suite hard scheduling ceiling $${HARD_CEILING}; ${VARIANCE_ESTIMATE}.`);
		return 0;
	} catch (err) { console.error(String(err)); return 2; }
}

function fixture(c: PaidCtx, s: PaidScenario): void {
	mkdirSync(c.repo);
	const git = (...args: string[]) => execFileSync("git", ["-C", c.repo, "-c", "user.email=e2e@example.com", "-c", "user.name=Paid Fixture", ...args], { stdio: "ignore" });
	git("init", "-q", "-b", "main");
	for (const [rel, text] of Object.entries({ "README.md": "# paid fixture\n", ...s.fixture })) {
		const path = join(c.repo, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}
	git("add", ".");
	git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
}

interface MeasuredSpend { cost?: number; unknown?: string }

function spend(c: PaidCtx, rows: Trace[], final = false): MeasuredSpend {
	const metricsSpend = metrics(c);
	const main = rows.find(r => r.kind === "root");
	let root = 0;
	let others = 0;
	if (metricsSpend?.spend.unknown) return { unknown: metricsSpend.spend.unknown };
	const children = new Set(rows.flatMap(r => r.kind === "ref" && r.parentId !== undefined ? [r.id] : []));
	for (const row of rows) {
		if (row.kind !== "usage" || (children.has(row.id) ? row.source !== "task" : row.source !== "session")) continue;
		if (row.tokens > 0 && !(typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost > 0))
			return { unknown: `${row.id} reported unpriced tokens on ${row.model}` };
		if (row.id === "Main") root += row.cost ?? 0;
		else others += row.cost ?? 0;
	}
	if (final) {
		if (!main?.sessionFile || !metricsSpend || !Number.isFinite(metricsSpend.spend.cost)) return { unknown: "missing final observer session or swarm spend metrics" };
		const entries = jsonl<Entry>(main.sessionFile);
		if (!entries.some(entry => entry.message?.role === "assistant")) return { unknown: "missing final Main assistant usage transcript" };
		const bill = directBill(entries);
		if (bill.unpriced) return { unknown: "unpriced usage in Main transcript" };
		root = Math.max(root, bill.cost);
	}
	// The observer catches Main's first request (before add/title creates the swarm),
	// while the plugin can observe usage not represented in ordinary assistant frames.
	const coordinator = metricsSpend?.coordinator?.cost ?? 0;
	return { cost: Math.max(root, coordinator) + Math.max(others, (metricsSpend?.spend.cost ?? 0) - coordinator) };
}

export interface CaseResult { c: PaidCtx; k: Checks; cost?: number; unsound?: string }
interface CaseOptions { omp: string; cap: number; deadline: number; scoutOverride?: string; loopback?: Script }

/** The loopback-only test seam takes a scripted provider and starts with no real auth/config. */
export async function runPaidCase(s: PaidScenario, options: CaseOptions): Promise<CaseResult> {
	const { omp, cap, deadline, scoutOverride, loopback } = options;
	const T = mkdtempSync(join(tmpdir(), `omp-swarm-${loopback ? "loopback" : "paid"}-${s.id}-`));
	const c: PaidCtx = { T, swarm: join(T, "swarm"), repo: join(T, "repo"), trace: join(T, "evidence.jsonl"), stdout: "", stderr: "", code: null };
	const k = new Checks();
	const seconds = Math.max(1, Math.min(s.maxSeconds ?? LEGACY_TIMEOUT, Math.ceil((deadline - performance.now()) / 1000)));
	const prompt = typeof s.prompt === "string" ? s.prompt : s.prompt(scoutOverride);
	const env: NodeJS.ProcessEnv = {
		...(!loopback ? process.env : {}),
		PATH: stripNodeModulesBins(process.env.PATH),
		OMP_SWARM_DIR: c.swarm,
		OMP_SWARM_MAX_WORKERS: "8",
		OMP_SWARM_MAX_COST_USD: cap.toFixed(6),
		OMP_SWARM_DEADLINE_SECONDS: String(seconds),
		OMP_SWARM_UI: "0",
		OMP_SWARM_PAID_TRACE: c.trace,
		...s.env,
	};
	if (loopback || s.pty) {
		const home = join(T, "home");
		const agent = join(T, "agent");
		Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
			XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: ".omp" });
		delete env.OMP_PROFILE;
		delete env.PI_PROFILE;
		mkdirSync(home);
		mkdirSync(agent);
		c.profiles = join(agent, "agents");
		c.profilesBefore = treeHash(c.profiles);
	}
	if (s.pty) delete env.OMP_SWARM_DIR;
	const config = join(T, "config.yml");
	const approved = loopback ? ["mock"] : SCOUT_PROVIDERS;
	const disabled = [...new Set([...getBundledProviders(), "google-antigravity"])].filter(p => !approved.includes(p));
	const restricted = s.cap !== undefined || loopback;
	const model = loopback ? "mock/coord" : s.model ?? W.luna;
	const mockScript = loopback ?? (s.mock ? MOCK_429 : undefined);
	const mock = mockScript ? new MockLlm(mockScript, join(T, "mock.jsonl")) : undefined;
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let tty: PtyOmp | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let grace: ReturnType<typeof setTimeout> | undefined;
	let watch: ReturnType<typeof setInterval> | undefined;
	let killed: string | undefined;
	try {
		fixture(c, s);
		writeFileSync(config, [
			"startup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false",
			"composer:\n  predictions: false",
			"retry:\n  maxRetries: 1\n  waitForUsageReset: false",
			// Foreground coordinator fixture barriers must stay foreground; explicit async:true still works.
			...(restricted ? ["bash:\n  autoBackground:\n    enabled: false",
				`enabledProviders: ${JSON.stringify(approved)}`, `disabledProviders: ${JSON.stringify(disabled)}`] : []),
			...(s.id === "R10" ? ["async:\n  enabled: true\n  printWake: false"] : []),
			...(s.id === "R11" ? ["task:\n  batch: true\n  maxConcurrency: 2"] : []),
		].join("\n") + "\n");
		if (mock) env.MOCK_PORT = String(mock.start());
		const argv = [omp, ...(s.pty ? [] : ["-p", prompt, "--mode", "json"]), "--model", model, "--thinking", EFFORT,
			"--max-time", `${seconds}s`, "--max-cost", cap.toFixed(6), "--session-dir", join(T, "sessions"), "--config", config,
			"--no-title", "--no-extensions", "-e", OBSERVER, "-e", REPO, ...(mock ? ["-e", PROVIDER] : [])];
		if (s.pty) {
			tty = new PtyOmp({ root: T, cwd: c.repo, argv, env }, 128, 36);
			child = tty.proc;
		} else child = Bun.spawn(argv, { cwd: c.repo, env, stdout: "pipe", stderr: "pipe" });
		const proc = child;
		const stop = (why: string) => {
			if (killed || proc.exitCode !== null || proc.signalCode !== null) return;
			killed = why;
			proc.kill("SIGTERM");
			grace = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); }, 3000);
		};
		timer = setTimeout(() => stop("scenario or suite deadline reached"), Math.min(seconds * 1000, Math.max(1, deadline - performance.now())));
		watch = setInterval(() => {
			if (killed) return;
			try {
				const rows = evidence(c);
				if (s.pty) syncArtifactRoot(c, rows);
				const measured = spend(c, rows);
				if (measured.unknown) stop(`price unavailable: ${measured.unknown}`);
				else if ((measured.cost ?? 0) >= cap) stop(`scenario spend ceiling $${cap} reached`);
				else s.tick?.(c, rows);
			} catch (err) { stop(`evidence reader: ${err}`); }
		}, 200);
		if (tty) {
			try { await driveHub(tty, c, prompt); }
			catch (err) { k.failures.push(`native Hub driver: ${err}`); stop("native Hub driver failed"); }
			c.code = await proc.exited;
			c.stdout = tty.raw;
		} else {
			const bytes = (stream: typeof proc.stdout | typeof proc.stderr) => stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve("");
			[c.code, c.stdout, c.stderr] = await Promise.all([proc.exited, bytes(proc.stdout), bytes(proc.stderr)]);
		}
		clearInterval(watch);
		if (!killed && s.after) {
			try { await s.after(c); }
			catch (err) { k.failures.push(`post-exit fixture check: ${err}`); }
		}
	} catch (err) { k.failures.push(`runner: ${err}`); }
	finally {
		clearTimeout(timer);
		clearTimeout(grace);
		clearInterval(watch);
		if (tty) await tty.close();
		else if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await child.exited; }
		mock?.stop();
		writeFileSync(join(T, s.pty ? "terminal.ansi" : "stdout.jsonl"), c.stdout);
		writeFileSync(join(T, "stderr.txt"), c.stderr);
	}
	if (killed) k.failures.push(killed);
	k.eq(c.code, 0, "omp process exit code");
	const outcome = metrics(c)?.outcome?.value;
	if (s.pty) k.ok(!outcome || outcome === "complete", `unexpected interactive swarm outcome: ${outcome}`);
	else k.eq(outcome, s.id === "R12" ? "complete_with_abandonment" : "complete", "terminal headless swarm outcome");
	let measured: MeasuredSpend = { unknown: "could not read final evidence" };
	try {
		measured = spend(c, evidence(c), true);
		if (measured.unknown) k.failures.push(measured.unknown);
		if ((measured.cost ?? 0) > cap) k.failures.push(`settled usage $${measured.cost} exceeded cap $${cap} (in-flight bills can land after stop)`);
		s.check(c, k);
	} catch (err) { k.failures.push(`checks: ${err}`); }
	writeFileSync(join(T, "result.json"), `${JSON.stringify({ scenario: s.id, cap, model, effort: EFFORT, ...measured, swarm: c.swarm, exitCode: c.code, failures: k.failures }, null, 2)}\n`);
	return { c, k, cost: measured.cost, unsound: measured.unknown };
}

export async function runPaid(ids: string[], list: PaidScenario[]): Promise<number> {
	if (process.env.OMP_SWARM_PAID !== "1") {
		console.log("The paid suite spends real quota. Set OMP_SWARM_PAID=1 only after approval; --paid-plan is no-spend.");
		return 2;
	}
	let scenarios: PaidScenario[];
	try { scenarios = selection(ids, list); } catch (err) { console.error(String(err)); return 2; }
	const ceiling = Number(process.env.OMP_SWARM_PAID_CEILING_USD ?? HARD_CEILING);
	const minutes = Number(process.env.OMP_SWARM_PAID_MINUTES ?? 90);
	const scoutOverride = process.env.OMP_SWARM_PAID_SCOUT_MODEL;
	if (!(ceiling > 0 && ceiling <= HARD_CEILING) || !(minutes > 0 && minutes <= 90)) {
		console.error(`Paid budgets must be positive and at most $${HARD_CEILING} and 90 minutes.`);
		return 2;
	}
	if (scoutOverride && !/^(openai-codex|anthropic|antigravity-cli)\/[\w.-]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/.test(scoutOverride)) {
		console.error("OMP_SWARM_PAID_SCOUT_MODEL must be an exact authorized provider/model[:effort] on openai-codex, anthropic, or antigravity-cli.");
		return 2;
	}
	if (scenarios.some(s => s.pty) && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN) {
		console.error("R9's isolated PTY requires authorized ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN already in the environment; it never copies profile credentials.");
		return 2;
	}
	if (scenarios.some(s => ["R10", "R12"].includes(s.id)) && !existsSync("/usr/bin/python3")) {
		console.error("R10 and R12 require /usr/bin/python3 for finite fixture latches.");
		return 2;
	}
	if (scenarios.some(s => s.id === "R12") && (process.platform !== "linux" || !existsSync("/usr/bin/sleep"))) {
		console.error("R12 requires Linux /proc and /usr/bin/sleep to verify exact descendant process identities.");
		return 2;
	}
	const omp = resolveOmpBin();
	const version = execFileSync(omp, ["--version"], { encoding: "utf8" }).trim();
	if (!/^(?:omp\/)?19\.1\.0(?:\s|$)/.test(version)) {
		console.error(`Paid checkpoint requires host omp 19.1.0, got ${version}.`);
		return 2;
	}
	console.log(`Host omp: ${version} (${omp}); hard scheduling ceiling $${ceiling}.`);
	const deadline = performance.now() + minutes * 60_000;
	let spent = 0;
	let failed = 0;
	for (const s of scenarios) {
		const cap = Math.floor(Math.min(s.cap ?? LEGACY_CAP, ceiling - spent) * 1e6) / 1e6;
		if (cap <= 0 || performance.now() >= deadline) { console.error(`STOP before ${s.id}: suite budget exhausted`); return 1; }
		const { c, k, cost, unsound } = await runPaidCase(s, { omp, cap, deadline, scoutOverride });
		if (cost !== undefined) spent += cost;
		console.log(`${k.failures.length ? "FAIL" : "PASS"} ${s.id} (scenario ${cost === undefined ? "unknown" : `$${cost.toFixed(6)}`}; suite known $${spent.toFixed(6)}) ${c.T}`);
		for (const x of k.failures) console.log(`  - ${x}`);
		if (k.failures.length) failed++;
		if (unsound || spent >= ceiling) { console.error(`STOP: ${unsound ?? "suite ceiling reached"}`); return 1; }
	}
	return failed ? 1 : 0;
}
