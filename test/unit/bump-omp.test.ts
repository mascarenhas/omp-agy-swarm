import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parseArgs, parseOmpVersion, REPO, updatePackageJson, updateReadme, updateSupportedHost } from "../../scripts/bump-omp.ts";
import { resolveOmpBin, stripNodeModulesBins } from "../../scripts/omp-bin.ts";

describe("bump-omp helpers", () => {
	test("parseOmpVersion accepts omp/<ver> and bare semver, rejects malformed input", () => {
		expect(parseOmpVersion("omp/19.1.0\n")).toBe("19.1.0");
		expect(parseOmpVersion("19.2.3-rc.1")).toBe("19.2.3-rc.1");
		expect(() => parseOmpVersion("")).toThrow();
		expect(() => parseOmpVersion("v19.1.0")).toThrow();
		expect(() => parseOmpVersion("omp/latest")).toThrow();
	});

	test("parseArgs handles flags and optional explicit version", () => {
		expect(parseArgs([])).toEqual({ version: undefined, dryRun: false, noTest: false, help: false });
		expect(parseArgs(["omp/19.2.0", "--dry-run", "--no-test"])).toEqual({
			version: "19.2.0",
			dryRun: true,
			noTest: true,
			help: false,
		});
		expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
		expect(() => parseArgs(["19.1.0", "19.2.0"])).toThrow(/extra argument/);
	});

	test("updatePackageJson bumps only @oh-my-pi/* pins and preserves unrelated deps and formatting", () => {
		const raw = readFileSync(join(REPO, "package.json"), "utf8");
		const res = updatePackageJson(raw, "19.9.9");
		expect(res.changed).toBe(true);
		expect(res.packages).toEqual([
			"@oh-my-pi/pi-catalog",
			"@oh-my-pi/pi-coding-agent",
			"@oh-my-pi/pi-tui",
			"@oh-my-pi/pi-utils",
			"@oh-my-pi/pi-wire",
		]);
		const parsed = JSON.parse(res.next);
		expect(parsed.peerDependencies["@oh-my-pi/pi-coding-agent"]).toBe("19.9.9");
		expect(parsed.devDependencies["@oh-my-pi/pi-coding-agent"]).toBe("19.9.9");
		expect(parsed.devDependencies["@oh-my-pi/pi-catalog"]).toBe("19.9.9");
		expect(parsed.devDependencies["@oh-my-pi/pi-tui"]).toBe("19.9.9");
		expect(parsed.devDependencies["@oh-my-pi/pi-utils"]).toBe("19.9.9");
		expect(parsed.devDependencies["@oh-my-pi/pi-wire"]).toBe("19.9.9");
		expect(parsed.devDependencies.typescript).toBe(JSON.parse(raw).devDependencies.typescript);
		expect(res.next).toContain('"omp": { "extensions": ["./src/index.ts"] },');
		expect(updatePackageJson(res.next, "19.9.9").changed).toBe(false);
	});

	test("updateSupportedHost updates SUPPORTED_HOST and fails loud if missing", () => {
		const raw = 'export const SUPPORTED_HOST: readonly string[] = ["19.0.1"];\n';
		const res = updateSupportedHost(raw, "19.1.0");
		expect(res).toEqual({ next: 'export const SUPPORTED_HOST: readonly string[] = ["19.1.0"];\n', changed: true });
		expect(updateSupportedHost(res.next, "19.1.0").changed).toBe(false);
		expect(() => updateSupportedHost("export const OTHER = 1;\n", "19.1.0")).toThrow(/SUPPORTED_HOST/);
	});

	test("updateReadme updates all three documented omp version references cleanly", () => {
		const raw = readFileSync(join(REPO, "README.md"), "utf8");
		const res = updateReadme(raw, "19.9.9");
		expect(res.matched).toBe(3);
		expect(res.changed).toBe(true);
		expect(res.next).toContain("[omp](https://omp.sh) **19.9.9**");
		expect(res.next).toContain("Requires **omp `19.9.9`** (`@oh-my-pi/pi-coding-agent: 19.9.9`)");
		expect(res.next).toContain("- **omp `19.9.9` target:** pinned and tested against `@oh-my-pi/pi-coding-agent` `19.9.9`");
		expect(updateReadme(res.next, "19.9.9").changed).toBe(false);
	});

	test("resolveOmpBin skips node_modules/.bin shims injected by bun run and respects OMP_BIN", () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-bin-test-"));
		try {
			const fakeHost = join(dir, "omp");
			writeFileSync(fakeHost, "#!/bin/sh\necho omp/99.0.0\n");
			chmodSync(fakeHost, 0o755);
			const nmBin = join(REPO, "node_modules", ".bin");
			const joined = [nmBin, "/tmp/other/node_modules/.bin", dir].join(delimiter);
			expect(stripNodeModulesBins(joined)).toBe(dir);
			expect(resolveOmpBin({ PATH: joined })).toBe(fakeHost);
			expect(resolveOmpBin({ OMP_BIN: "/custom/omp", PATH: joined })).toBe("/custom/omp");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
