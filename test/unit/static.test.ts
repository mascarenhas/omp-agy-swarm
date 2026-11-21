// §2 dependency rules, vendored file hashes vs NOTICE.md, and the worker prompt contract texts.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Board } from "../../src/board/board.ts";
import { firstMessage, roleBlock, skillBody, wakeText, workerContract } from "../../src/runtime/prompts.ts";
import { REPO } from "../helpers/harness.ts";

const SRC = join(REPO, "src");

function files(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...files(p));
		else if (p.endsWith(".ts")) out.push(p);
	}
	return out;
}

interface Imp {
	spec: string;
	typeOnly: boolean;
}

function imports(file: string): Imp[] {
	const text = readFileSync(file, "utf8");
	const out: Imp[] = [];
	for (const m of text.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
		const clause = m[2] ?? "";
		const named = clause.match(/\{([\s\S]*)\}/)?.[1];
		const allTypeNamed = named !== undefined && !clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim() && named.split(",").map(s => s.trim()).filter(Boolean).every(s => s.startsWith("type "));
		out.push({ spec: m[3] ?? "", typeOnly: !!m[1] || allTypeNamed });
	}
	for (const m of text.matchAll(/^import\s+"([^"]+)";/gm)) out.push({ spec: m[1] ?? "", typeOnly: false });
	return out;
}

const rel = (f: string) => relative(SRC, f);
const isBuiltin = (s: string) => s.startsWith("node:") || s.startsWith("bun:");

describe("dependency rules (§2)", () => {
	const all = files(SRC);

	test("pure modules import builtins and each other only (value imports)", () => {
		const pure = all.filter(f => {
			const r = rel(f);
			return r.startsWith("board/") || r === "tools/permissions.ts" || r === "ui/model.ts" || r === "runtime/prompts.ts" || r === "env.ts";
		});
		expect(pure.length).toBeGreaterThan(5);
		for (const f of pure) {
			for (const i of imports(f)) {
				if (i.typeOnly || isBuiltin(i.spec)) continue;
				expect([rel(f), i.spec.startsWith(".")]).toEqual([rel(f), true]);
				const target = rel(join(f, "..", i.spec));
				expect([rel(f), target.startsWith("board/") || target === "env.ts"]).toEqual([rel(f), true]);
			}
		}
	});

	test("only the adapter has value imports from pi-coding-agent and pi-catalog; pi-tui only in the TUI and sanitize", () => {
		for (const f of all) {
			for (const i of imports(f)) {
				if (i.typeOnly) continue;
				if (i.spec.startsWith("@oh-my-pi/pi-coding-agent") || i.spec.startsWith("@oh-my-pi/pi-catalog"))
					expect(rel(f)).toBe("runtime/omp-adapter.ts");
				if (i.spec.startsWith("@oh-my-pi/pi-tui")) expect(rel(f).startsWith("ui/tui/") || rel(f) === "ui/sanitize.ts").toBe(true);
			}
		}
	});

	test("ui/web is imported only by ui/commands.ts; TUI/web/model never import the runtime by value", () => {
		for (const f of all) {
			for (const i of imports(f)) {
				if (!i.spec.startsWith(".")) continue;
				const target = rel(join(f, "..", i.spec));
				if (target.startsWith("ui/web/") && !rel(f).startsWith("ui/web/")) expect(rel(f)).toBe("ui/commands.ts");
				const uiPure = rel(f).startsWith("ui/tui/") || rel(f).startsWith("ui/web/") || rel(f) === "ui/model.ts";
				if (uiPure && !i.typeOnly) expect([rel(f), target.startsWith("runtime/")]).toEqual([rel(f), false]);
			}
		}
	});

	test("no dynamic host imports and no `as any` anywhere in src", () => {
		for (const f of all) {
			const text = readFileSync(f, "utf8");
			expect([rel(f), /import\(\s*["'`]@oh-my-pi/.test(text)]).toEqual([rel(f), false]);
			expect([rel(f), /await import\(/.test(text)]).toEqual([rel(f), false]);
			expect([rel(f), /\bas any\b/.test(text)]).toEqual([rel(f), false]);
		}
	});
});

describe("vendored files", () => {
	test("hashes match NOTICE.md; the package stays private while web/vendor exists", () => {
		const notice = readFileSync(join(REPO, "NOTICE.md"), "utf8");
		const vendor = join(REPO, "web", "vendor");
		const names = readdirSync(vendor).sort();
		expect(names).toEqual(["app.js", "hive.css", "hive.js", "narrator_bootstrap.js", "styles.css"]);
		for (const n of names) {
			const sha = createHash("sha256").update(readFileSync(join(vendor, n))).digest("hex");
			expect(notice).toContain(`\`web/vendor/${n}\` | \`${sha}\``);
		}
		const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
		if (existsSync(vendor)) expect(pkg.private).toBe(true);
		expect(pkg.omp.extensions).toEqual(["./src/index.ts"]);
		expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
	});

	test("index.html loads preload first, bridge last, and no remote URL", () => {
		const html = readFileSync(join(REPO, "web", "index.html"), "utf8");
		const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
		expect(scripts).toEqual(["/preload.js", "/hive.js", "/app.js", "/omp-bridge.js"]);
		expect(/https?:\/\//.test(html)).toBe(false);
		expect(html).toContain(`content="frame-src 'none'; child-src 'none'"`);
	});
});

describe("prompts", () => {
	const ws = { mode: "share" as const, path: "/s/workspaces/p", branch: "swarm/sid/p" };
	test("worker contract names the member, adder, workspace and swarm dir; sole-call wait rule", () => {
		const t = workerContract({ name: "parser", addedBy: "lead", workspace: ws, cwd: ws.path, baseDesc: "commit abc", swarmDir: "/s" });
		expect(t).toStartWith("<swarm_worker>\nYou are `parser`");
		expect(t).toContain("`lead` added you");
		expect(t).toContain("default @lead");
		expect(t).toContain("own git worktree at `/s/workspaces/p` on branch `swarm/sid/p`, started from commit abc");
		expect(t).toContain("it must be the only tool");
		expect(t).toContain("Swarm directory (shared files; save screenshots under its shots/ folder): /s");
	});

	test("role block carries SWARM_DIR, DEFAULTS_DIR (narrator) and the skill body without frontmatter", () => {
		const body = skillBody("---\nname: x\nhide: true\n---\n\n# Body\ntext");
		expect(body.trim()).toBe("# Body\ntext");
		const b = roleBlock("narrator", "/s", "/d", body);
		expect(b).toContain("SWARM_DIR=/s\nDEFAULTS_DIR=/d");
		expect(roleBlock("monitor", "/s", "/d", body)).not.toContain("DEFAULTS_DIR");
	});

	test("first message and wake text", () => {
		const board = new Board({ boardMembers: () => [{ name: "p", role: "worker", addedSeq: 0, killedSeq: undefined }] });
		const m = board.append({ seq: 1, agent: "coordinator", text: "@p take the tests", time: "2026-11-20 21:04:10" });
		expect(firstMessage({ name: "p", addedBy: "coordinator", briefSeq: 3, brief: "do it", task: "slice", early: [m] })).toBe(
			"[swarm] You are `p`. Brief from coordinator (board #3):\n\ndo it\n\nYour slice: slice\n\nAlso posted on the board while you were starting:\n#1 coordinator → @you · 21:04:10\n  @p take the tests",
		);
		const w = wakeText({ name: "p", head: 44, reminders: ["Your context was compacted."], notices: ["lexer failed"], posts: [m], more: true, triggerSeq: 57 });
		expect(w).toBe(
			"[swarm] New on the board for you (p) — head #44\n(Your context was compacted.)\n! lexer failed\n#1 coordinator → @you · 21:04:10\n  @p take the tests\nMore posts follow: read_board until \"more\" is false. The post that woke you is #57.\nAct on the posts marked \"→ @you\", post the outcome, then call swarm_wait.",
		);
	});
});
