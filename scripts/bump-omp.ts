#!/usr/bin/env bun
// Bump pinned @oh-my-pi/* dependencies, SUPPORTED_HOST, and README target version to the
// installed (or specified) omp version, reinstall, and run the deterministic verification suite.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, resolveOmpBin } from "./omp-bin.ts";
export { REPO };
const SEMVER_PART = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
export const SEMVER_RE = new RegExp(`^${SEMVER_PART}$`);
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export interface CliOptions {
	version?: string;
	dryRun: boolean;
	noTest: boolean;
	help: boolean;
}

export function parseOmpVersion(raw: string): string {
	const line = raw
		.split(/\r?\n/)
		.map(s => s.trim())
		.find(Boolean);
	if (!line) throw new Error("empty version string");
	const stripped = line.startsWith("omp/") ? line.slice(4) : line;
	if (!SEMVER_RE.test(stripped)) throw new Error(`invalid omp version: ${JSON.stringify(line)}`);
	return stripped;
}

export function parseArgs(argv: readonly string[]): CliOptions {
	let version: string | undefined;
	let dryRun = false;
	let noTest = false;
	let help = false;
	for (const arg of argv) {
		if (arg === "-h" || arg === "--help") help = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--no-test") noTest = true;
		else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		else if (version !== undefined) throw new Error(`unexpected extra argument: ${arg}`);
		else version = parseOmpVersion(arg);
	}
	return { version, dryRun, noTest, help };
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ompDepMap(pkg: Record<string, unknown>): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	for (const section of DEP_SECTIONS) {
		const block = pkg[section];
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		const entries: Record<string, string> = {};
		for (const [name, val] of Object.entries(block as Record<string, unknown>)) {
			if (name.startsWith("@oh-my-pi/") && typeof val === "string") entries[name] = val;
		}
		if (Object.keys(entries).length) out[section] = entries;
	}
	return out;
}

export function updatePackageJson(raw: string, version: string): { next: string; previous: string; changed: boolean; packages: string[] } {
	if (!SEMVER_RE.test(version)) throw new Error(`invalid target version: ${version}`);
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const before = ompDepMap(parsed);
	const previous = before.peerDependencies?.["@oh-my-pi/pi-coding-agent"];
	if (!previous) throw new Error('package.json missing peerDependencies["@oh-my-pi/pi-coding-agent"]');

	const names = [...new Set(Object.values(before).flatMap(m => Object.keys(m)))].sort();
	let next = raw;
	for (const name of names) {
		const re = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*")([^"]+)(")`, "g");
		next = next.replace(re, `$1${version}$3`);
	}

	const afterParsed = JSON.parse(next) as Record<string, unknown>;
	const after = ompDepMap(afterParsed);
	for (const section of DEP_SECTIONS) {
		const b = before[section];
		const a = after[section];
		if (!b) continue;
		if (!a) throw new Error(`lost ${section} while updating package.json`);
		for (const name of Object.keys(b)) {
			if (a[name] !== version) throw new Error(`failed to update ${section}[${JSON.stringify(name)}] to ${version}`);
		}
	}
	return { next, previous, changed: next !== raw, packages: names };
}

export function updateSupportedHost(raw: string, version: string): { next: string; changed: boolean } {
	if (!SEMVER_RE.test(version)) throw new Error(`invalid target version: ${version}`);
	const re = /^(export const SUPPORTED_HOST: readonly string\[\] = )\[[^\]]*\];$/m;
	if (!re.test(raw)) throw new Error("src/env.ts missing SUPPORTED_HOST declaration");
	const next = raw.replace(re, `$1["${version}"];`);
	return { next, changed: next !== raw };
}

export function updateReadme(raw: string, version: string): { next: string; changed: boolean; matched: number } {
	if (!SEMVER_RE.test(version)) throw new Error(`invalid target version: ${version}`);
	const patterns: Array<[RegExp, string]> = [
		[new RegExp(`(\\[omp\\]\\(https://omp\\.sh\\) \\*\\*)${SEMVER_PART}(\\*\\*)`), `$1${version}$2`],
		[
			new RegExp(`(Requires \\*\\*omp \`)${SEMVER_PART}(\`\\*\\* \\(\`@oh-my-pi/pi-coding-agent: )${SEMVER_PART}(\`\\))`),
			`$1${version}$2${version}$3`,
		],
		[
			new RegExp(`(- \\*\\*omp \`)${SEMVER_PART}(\` target:\\*\\* pinned and tested against \`@oh-my-pi/pi-coding-agent\` \`)${SEMVER_PART}(\`)`),
			`$1${version}$2${version}$3`,
		],
	];
	let next = raw;
	let matched = 0;
	for (const [re, replacement] of patterns) {
		if (re.test(next)) {
			matched++;
			next = next.replace(re, replacement);
		}
	}
	return { next, changed: next !== raw, matched };
}

function detectInstalledOmp(): { bin: string; version: string } | undefined {
	let bin: string;
	try {
		bin = resolveOmpBin();
	} catch {
		return undefined;
	}
	const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
	if (r.error || r.status !== 0) return undefined;
	return { bin, version: parseOmpVersion(r.stdout) };
}

function runStep(label: string, cmd: string[], cwd: string): number {
	console.log(`\n=== ${label} ===`);
	const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "inherit" });
	if (r.error) {
		console.error(`Failed to spawn ${cmd.join(" ")}: ${r.error.message}`);
		return 1;
	}
	return r.status ?? 1;
}

function usage(): string {
	return [
		"Usage: bun run bump-omp [version] [--no-test] [--dry-run]",
		"",
		"Bumps @oh-my-pi/* pins in package.json, SUPPORTED_HOST in src/env.ts, and target",
		"version references in README.md to the installed omp version (or explicit [version]),",
		"runs `bun install`, then runs typecheck, test, test:pty, and test:e2e.",
		"",
		"Options:",
		"  --dry-run   Print planned file updates without modifying files or running tests",
		"  --no-test   Update pins and run `bun install`, skip the test suite",
		"  -h, --help  Show this message",
	].join("\n");
}

function main(): number {
	let opts: CliOptions;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`bump-omp: ${(err as Error).message}\n\n${usage()}`);
		return 2;
	}
	if (opts.help) {
		console.log(usage());
		return 0;
	}

	const installed = detectInstalledOmp();
	const target = opts.version ?? installed?.version;
	if (!target) {
		console.error("bump-omp: could not detect installed `omp` (`omp --version` failed); pass an explicit version or set OMP_BIN.");
		return 1;
	}
	if (opts.version && installed && installed.version !== target && !opts.noTest && !opts.dryRun) {
		console.error(
			`bump-omp: warning: installed omp is ${installed.version} (${installed.bin}), bumping pins to ${target}; test:pty and test:e2e will run against omp/${installed.version}.`,
		);
	}
	const pkgPath = join(REPO, "package.json");
	const envPath = join(REPO, "src", "env.ts");
	const readmePath = join(REPO, "README.md");
	const lockPath = join(REPO, "bun.lock");

	const origPkg = readFileSync(pkgPath, "utf8");
	const origEnv = readFileSync(envPath, "utf8");
	const origReadme = readFileSync(readmePath, "utf8");
	const origLock = existsSync(lockPath) ? readFileSync(lockPath) : undefined;

	const pkgRes = updatePackageJson(origPkg, target);
	const envRes = updateSupportedHost(origEnv, target);
	const readmeRes = updateReadme(origReadme, target);

	console.log(
		`Target omp version: ${target} (pinned: ${pkgRes.previous}${installed ? `, installed: ${installed.version} at ${installed.bin}` : ""})`,
	);
	const updates: Array<[string, string, string, boolean]> = [
		["package.json", pkgPath, pkgRes.next, pkgRes.changed],
		["src/env.ts", envPath, envRes.next, envRes.changed],
		["README.md", readmePath, readmeRes.next, readmeRes.changed],
	];
	for (const [label, , , changed] of updates) {
		console.log(`  ${changed ? "update" : "ok    "} ${label}`);
	}
	if (readmeRes.matched !== 3) {
		console.error(`bump-omp: warning: expected 3 omp version sites in README.md, matched ${readmeRes.matched}`);
	}

	if (opts.dryRun) return 0;

	const written: Array<[string, string]> = [];
	const originals: Record<string, string> = { [pkgPath]: origPkg, [envPath]: origEnv, [readmePath]: origReadme };
	for (const [, path, next, changed] of updates) {
		if (!changed) continue;
		writeFileSync(path, next, "utf8");
		written.push([path, originals[path]!]);
	}

	const installCode = runStep("bun install", ["bun", "install"], REPO);
	if (installCode !== 0) {
		for (const [path, orig] of written) writeFileSync(path, orig, "utf8");
		if (origLock !== undefined) writeFileSync(lockPath, origLock);
		console.error("\nbump-omp: `bun install` failed; restored previous version pins.");
		return installCode;
	}

	if (opts.noTest) {
		console.log(`\nbump-omp: updated pins to omp ${target} (--no-test; skipped verification suites).`);
		return 0;
	}

	const steps: Array<[string, string[]]> = [
		["typecheck", ["bun", "run", "typecheck"]],
		["unit + integration tests", ["bun", "run", "test"]],
		["PTY TUI tests", ["bun", "run", "test:pty"]],
		["deterministic E2E tests", ["bun", "run", "test:e2e"]],
	];
	for (const [label, cmd] of steps) {
		const code = runStep(label, cmd, REPO);
		if (code !== 0) {
			console.error(`\nbump-omp: failed at "${label}" (exit ${code}). Bumped pins (${target}) were kept so you can fix and re-run \`bun run test:all\`.`);
			return code;
		}
	}

	console.log(`\nbump-omp: bumped to omp ${target} and verified typecheck, test, test:pty, and test:e2e.`);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
