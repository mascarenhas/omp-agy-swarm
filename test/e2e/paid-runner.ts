import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { APP_NAME, getActiveProfile, getAgentDbPath, getAgentDir, getProfileRootDir } from "@oh-my-pi/pi-utils/dirs";
import { resolveOmpBin, stripNodeModulesBins } from "../../scripts/omp-bin.ts";
import { SUPPORTED_HOST } from "../../src/env.ts";
import { PtyOmp } from "../helpers/pty.ts";
import { Checks, metrics, treeHash } from "./check.ts";
import { MockLlm, type Script } from "./mock-llm/server.ts";
import { COORDINATOR, EFFORT, OBSERVER, type PaidScenario, SCOUT_PROVIDERS } from "./paid-contract.ts";
import { directBill, type Entry, evidence, type Frame, jsonl, type PaidCtx, type Trace } from "./paid-evidence.ts";
import { driveHub, syncArtifactRoot } from "./paid-fixtures.ts";
import { PROVIDER, REPO } from "./scenario.ts";

const HARD_CEILING = 15;
const LEGACY_CAP = 2;
const LEGACY_TIMEOUT = 1200;
const CLEANUP_MARGIN_MS = 15_000;
const PAID_PROVIDERS = [...SCOUT_PROVIDERS, "opencode-go"];
const PROFILE_TREES = ["agents", "managed-skills"] as const;
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
		for (const s of selection(ids, list)) {
			const extra = s.pty ? "native PTY (active omp profile; scratch resume state)" : s.mock ? "JSON (includes loopback mock 429)" : "JSON";
			console.log(`${s.id}: ${s.coordinator ?? COORDINATOR}:${EFFORT}, cap $${(s.cap ?? LEGACY_CAP).toFixed(2)}, ${s.maxSeconds ?? LEGACY_TIMEOUT}s, ${extra}`);
		}
		console.log(`Allowed paid providers: ${PAID_PROVIDERS.join(", ")}; google-antigravity is disabled.`);
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
/** Only a fully observed R9 startup, before the harness sends any input. */
export function untouchedHubStartup({ T, swarm }: PaidCtx, rows: Trace[]): boolean {
	const startup = rows.find(row => row.kind === "root");
	const sessionFile = startup?.sessionFile;
	return !!sessionFile && dirname(sessionFile) === join(T, "sessions") && startup.swarm === swarm &&
		!existsSync(sessionFile) && !existsSync(swarm) && rows.some(row => row.kind === "ref" && row.id === "Main" && row.attached) &&
		rows.every(row => row.kind === "root" || (row.kind === "ref" || row.kind === "jobs") && row.id === "Main");
}

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
		if (!main?.sessionFile) return { unknown: "missing observer Main session file path" };
		if (!metricsSpend || !Number.isFinite(metricsSpend.spend.cost)) return { unknown: "missing or invalid final swarm spend metrics" };
		const entries = jsonl<Entry>(main.sessionFile);
		if (!entries.some(entry => entry.message?.role === "assistant")) return { unknown: "missing final Main assistant usage transcript" };
		const bill = directBill(entries, rows.filter((row): row is Frame<"usage"> => row.kind === "usage" && row.id === "Main" && row.source === "session"));
		if (bill.unpriced) return { unknown: "unpriced usage in Main transcript" };
		root = Math.max(root, bill.cost);
	}
	// The observer catches Main's first request (before add/title creates the swarm),
	// while the plugin can observe usage not represented in ordinary assistant frames.
	const coordinator = metricsSpend?.coordinator?.cost ?? 0;
	return { cost: Math.max(root, coordinator) + Math.max(others, (metricsSpend?.spend.cost ?? 0) - coordinator) };
}

export interface CaseResult { c: PaidCtx; k: Checks; cost?: number; unsound?: string }
interface ProfileSnapshot { kind: typeof PROFILE_TREES[number]; before: string; after?: string }
interface CaseOptions { omp: string; cap: number; deadline: number; scoutOverride?: string; loopback?: Script; loopbackSymbolPreset?: "nerd" }

/** The loopback-only test seam takes a scripted provider and starts with no real auth/config. */
export async function runPaidCase(s: PaidScenario, options: CaseOptions): Promise<CaseResult> {
	const { omp, cap, deadline, scoutOverride, loopback, loopbackSymbolPreset } = options;
	const T = mkdtempSync(join(tmpdir(), `omp-swarm-${loopback ? "loopback" : "paid"}-${s.id}-`));
	const c: PaidCtx = { T, swarm: join(T, "swarm"), repo: join(T, "repo"), trace: join(T, "evidence.jsonl"), stdout: "", stderr: "", code: null, scoutOverride };
	const k = new Checks();
	const seconds = Math.min(s.maxSeconds ?? LEGACY_TIMEOUT, Math.floor((deadline - performance.now() - CLEANUP_MARGIN_MS) / 1000));
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
		OMP_SWARM_PAID_HUB: s.pty ? "1" : undefined,
		...s.env,
	};
	delete env.PI_SESSION_FILE;
	delete env.PI_SESSION_ID;
	delete env.PI_TOOL_CALL_ID;
	let agentDir = getAgentDir();
	if (loopback) {
		const home = join(T, "home");
		agentDir = s.pty ? join(home, ".omp", "agent") : join(T, "agent");
		Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
			XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), PI_CONFIG_DIR: ".omp" });
		if (!s.pty) env.PI_CODING_AGENT_DIR = agentDir;
		delete env.OMP_PROFILE;
		delete env.PI_PROFILE;
		mkdirSync(home);
		mkdirSync(agentDir, { recursive: true });
	}
	const profile = loopback ? undefined : getActiveProfile();
	const stateHome = join(T, "state");
	const stateRoot = profile ? join(stateHome, APP_NAME, "profiles", profile) : join(stateHome, APP_NAME);
	if (s.pty) {
		delete env.OMP_SWARM_DIR;
		delete env.PI_SESSION_ORIGIN;
		env.XDG_STATE_HOME = stateHome;
	}
	const config = join(T, "config.yml");
	const approved = loopback ? ["mock"] : [...PAID_PROVIDERS, ...(s.mock ? ["mock"] : [])];
	const disabled = [...new Set([...getBundledProviders(), "google-antigravity"])].filter(p => !approved.includes(p));
	const model = loopback ? "mock/coord" : s.coordinator ?? COORDINATOR;
	const mockScript = loopback ?? (s.mock ? MOCK_429 : undefined);
	const mock = mockScript ? new MockLlm(mockScript, join(T, "mock.jsonl")) : undefined;
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let tty: PtyOmp | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let grace: ReturnType<typeof setTimeout> | undefined;
	let watch: ReturnType<typeof setInterval> | undefined;
	let killed: string | undefined;
	let profileTrees: ProfileSnapshot[] = [];
	let profileProblem: string | undefined;
	try {
		if (seconds <= 0) throw new Error("suite has insufficient time to leave its shutdown margin");
		if (s.pty) {
			// omp 19.1.x applies XDG relocation only to its default agent path for
			// each profile. Refuse to write a live terminal breadcrumb if not.
			if ((!loopback && agentDir !== join(getProfileRootDir(profile), "agent")) ||
				!["linux", "darwin"].includes(process.platform))
				throw new Error("R9 requires a standard omp profile on Linux/macOS for scratch-only terminal resume state");
			mkdirSync(stateRoot, { recursive: true });
		}
		profileTrees = PROFILE_TREES.map(kind => ({ kind, before: treeHash(join(agentDir, kind)) }));
		fixture(c, s);
		writeFileSync(config, [
			"startup:\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false",
			"composer:\n  predictions: false",
			"autolearn:\n  enabled: false\n  autoContinue: false",
			"compaction:\n  autoContinue: false",
			"retry:\n  maxRetries: 1\n  waitForUsageReset: false\n  usageAwareFallback: false",
			`enabledProviders: ${JSON.stringify(approved)}`,
			`disabledProviders: ${JSON.stringify(disabled)}`,
			...(s.pty ? ["statusLine:\n  preset: default\n  separator: ascii\n  segmentOptions:\n    pi:\n      showProfile: false"] : []),
			...(loopback && loopbackSymbolPreset ? [`symbolPreset: ${loopbackSymbolPreset}`] : []),
			// Explicit async:true still works; the coordinator's fixture barriers stay foreground.
			...(s.id === "R10" || s.id === "R12" ? ["bash:\n  autoBackground:\n    enabled: false"] : []),
			...(s.id === "R10" ? ["async:\n  enabled: true\n  printWake: false"] : []),
			...(s.id === "R11" ? ["task:\n  batch: true\n  maxConcurrency: 2"] : []),
			...(loopback && s.id === "R11" ? ["eval:\n  autoProvision: false", "modelRoles:\n  smol: mock/plain"] : []),
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
		timer = setTimeout(() => stop("scenario or suite deadline reached"), Math.min(seconds * 1000 + CLEANUP_MARGIN_MS, Math.max(1, deadline - performance.now())));
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
		try {
			for (const tree of profileTrees) tree.after = treeHash(join(agentDir, tree.kind));
			if (profileTrees.some(tree => tree.before !== tree.after)) profileProblem = "active profile agents/ or managed-skills/ changed; stop and check for concurrent maintenance";
			if (s.pty) syncArtifactRoot(c, evidence(c));
			const root = evidence(c).find(row => row.kind === "root");
			if (s.pty && root?.terminalSessionsDir !== join(stateRoot, "terminal-sessions"))
				profileProblem = "R9 did not resolve its terminal resume directory under scratch";
			if (s.pty && !loopback && root && root.agentDb !== getAgentDbPath())
				profileProblem = "R9 did not resolve the same auth database as the active omp profile";
			if (root && root.agentDir !== agentDir) profileProblem = `active host profile ${root.agentDir} was not the snapshot target ${agentDir}`;
		} catch (err) { profileProblem = `could not verify profile snapshots: ${err}`; }
		writeFileSync(join(T, s.pty ? "terminal.ansi" : "stdout.jsonl"), c.stdout);
		writeFileSync(join(T, "stderr.txt"), c.stderr);
	}
	if (killed) k.failures.push(killed);
	if (profileProblem) k.failures.push(profileProblem);
	k.eq(c.code, 0, "omp process exit code");
	const outcome = metrics(c)?.outcome?.value;
	if (s.pty) k.ok(!outcome || outcome === "complete", `unexpected interactive swarm outcome: ${outcome}`);
	else k.eq(outcome, s.id === "R12" ? "complete_with_abandonment" : "complete", "terminal headless swarm outcome");
	let measured: MeasuredSpend = { unknown: "could not read final evidence" };
	try {
		const rows = evidence(c);
		const actualRoutes = [...new Set(rows.flatMap(row => row.kind === "usage" && row.id === "Main" && row.source === "session" && row.tokens > 0 ? [row.model] : []))];
		// If the PTY driver failed at startup, Main is still lazy: no input was
		// sent, no transcript was created and startup has no paid predictions.
		const preInputFailure = !!tty && k.failures.length > 0 && untouchedHubStartup(c, rows);
		if (!preInputFailure) k.eq(actualRoutes, [model], "coordinator served every observed request on the configured model");
		measured = preInputFailure ? { cost: 0 } : spend(c, rows, true);
		if (measured.unknown) k.failures.push(measured.unknown);
		if ((measured.cost ?? 0) > cap) k.failures.push(`settled usage $${measured.cost} exceeded cap $${cap} (in-flight bills can land after stop)`);
		if (!preInputFailure) s.check(c, k);
	} catch (err) { k.failures.push(`checks: ${err}`); }
	writeFileSync(join(T, "result.json"), `${JSON.stringify({ scenario: s.id, cap, model, effort: EFFORT, ...measured, swarm: c.swarm,
		exitCode: c.code, profiles: { agentDir, trees: profileTrees }, failures: k.failures }, null, 2)}\n`);
	return { c, k, cost: measured.cost, unsound: profileProblem ?? measured.unknown };
}

export async function runPaid(ids: string[], list: PaidScenario[]): Promise<number> {
	if (process.env.OMP_SWARM_PAID !== "1") {
		console.log("The paid suite spends real quota. Set OMP_SWARM_PAID=1 only after approval; --paid-plan is no-spend.");
		return 2;
	}
	let scenarios: PaidScenario[];
	try { scenarios = selection(ids, list); } catch (err) { console.error(String(err)); return 2; }
	console.log("Do not edit the active profile's agents/ or managed-skills/ while paid scenarios run.");
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
	const hostVersion = version.replace(/^omp\//, "").split(/\s/)[0] ?? "";
	if (!SUPPORTED_HOST.includes(hostVersion)) {
		console.error(`Paid checkpoint requires host omp ${SUPPORTED_HOST.join(" or ")}, got ${version}.`);
		return 2;
	}
	console.log(`Host omp: ${version} (${omp}); hard scheduling ceiling $${ceiling}.`);
	const deadline = performance.now() + minutes * 60_000;
	let spent = 0;
	let failed = 0;
	for (const s of scenarios) {
		const cap = Math.floor(Math.min(s.cap ?? LEGACY_CAP, ceiling - spent) * 1e6) / 1e6;
		if (cap <= 0 || deadline - performance.now() < CLEANUP_MARGIN_MS + 1000) { console.error(`STOP before ${s.id}: suite budget exhausted`); return 1; }
		const { c, k, cost, unsound } = await runPaidCase(s, { omp, cap, deadline, scoutOverride });
		if (cost !== undefined) spent += cost;
		console.log(`${k.failures.length ? "FAIL" : "PASS"} ${s.id} (scenario ${cost === undefined ? "unknown" : `$${cost.toFixed(6)}`}; suite known $${spent.toFixed(6)}) ${c.T}`);
		for (const x of k.failures) console.log(`  - ${x}`);
		if (k.failures.length) failed++;
		if (unsound || spent >= ceiling) { console.error(`STOP: ${unsound ?? "suite ceiling reached"}`); return 1; }
	}
	return failed ? 1 : 0;
}
