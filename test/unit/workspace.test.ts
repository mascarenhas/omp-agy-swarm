// Workspaces against real git (§9, SW-06): preparation, share snapshots and preservation-first
// disposition.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRecord } from "../../src/board/types.ts";
import { addWorktree, defaultGit, disposeWorkspace, type GitRunner, prepareGroup } from "../../src/runtime/workspace.ts";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const SID = "sid-test";

function git(cwd: string, ...args: string[]): string {
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
}

function repo(commit = true): { root: string; top: string; swarm: string } {
	const root = mkdtempSync(join(tmpdir(), "swarm-ws-"));
	roots.push(root);
	const top = join(root, "repo");
	mkdirSync(top);
	git(top, "init", "-q", "-b", "main");
	git(top, "config", "user.email", "t@t");
	git(top, "config", "user.name", "t");
	if (commit) {
		writeFileSync(join(top, "a.txt"), "one\n");
		mkdirSync(join(top, "src"));
		writeFileSync(join(top, "src", "lib.txt"), "lib\n");
		writeFileSync(join(top, ".gitignore"), "ignored.log\nbuild/\n");
		git(top, "add", ".");
		git(top, "commit", "-q", "-m", "init");
	}
	const swarm = join(root, "swarm");
	mkdirSync(swarm);
	return { root, top, swarm };
}

async function share(top: string, swarm: string, name = "w", mode: "share" | "branch" = "share", cwd = top, maxMb = 200) {
	const g = await prepareGroup(defaultGit, mode, cwd, swarm, SID, maxMb);
	const { ws, notes } = await addWorktree(defaultGit, g, swarm, SID, name);
	return { ws, notes: [...g.notes, ...notes], base: g.base };
}

const opts = (name: string, o: Partial<{ discardIgnored: boolean; keepWorkspace: boolean; dependents: string[]; stoppedCleanly: boolean }> = {}) => ({
	sid: SID,
	name,
	discardIgnored: false,
	keepWorkspace: false,
	dependents: [],
	stoppedCleanly: true,
	...o,
});

describe("preparation", () => {
	test("unborn HEAD is rejected with inherit guidance", async () => {
		const { top, swarm } = repo(false);
		await expect(prepareGroup(defaultGit, "share", top, swarm, SID, 200)).rejects.toThrow(/no commits yet/);
	});

	test("detached HEAD, cwd through a symlink, subdirectory present/missing in the base", async () => {
		const { root, top, swarm } = repo();
		git(top, "checkout", "-q", "--detach");
		const link = join(root, "link");
		symlinkSync(join(top, "src"), link);
		const { ws } = await share(top, swarm, "w1", "branch", link);
		expect(ws.path.endsWith(join("workspaces", "w1", "src"))).toBe(true);
		mkdirSync(join(top, "newdir"));
		const r = await share(top, swarm, "w2", "branch", join(top, "newdir"));
		expect(r.ws.path.endsWith(join("workspaces", "w2"))).toBe(true);
		expect(r.notes.join(" ")).toContain("does not exist in the base");
	});

	test("share snapshot: dirty work included, ignored excluded, swarm dir and nested repos excluded, source untouched", async () => {
		const { top } = repo();
		const swarm = join(top, ".swarm-inside");
		mkdirSync(swarm);
		writeFileSync(join(swarm, "board.jsonl"), "x\n");
		writeFileSync(join(top, "a.txt"), "two\n");
		git(top, "add", "a.txt");
		writeFileSync(join(top, "a.txt"), "three\n");
		writeFileSync(join(top, "new.txt"), "new\n");
		writeFileSync(join(top, "ignored.log"), "noise\n");
		writeFileSync(join(top, "tracked-ignored.log"), "t\n");
		writeFileSync(join(top, ".gitignore"), "ignored.log\nbuild/\ntracked-ignored.log\n");
		git(top, "add", "-f", "tracked-ignored.log");
		mkdirSync(join(top, "nested"));
		git(join(top, "nested"), "init", "-q");
		writeFileSync(join(top, "nested", "n.txt"), "n\n");
		git(top, "stash", "list");
		const statusBefore = git(top, "status", "--porcelain=v2");
		const indexBefore = readFileSync(join(top, ".git", "index"));
		const { ws, notes } = await share(top, swarm, "s");
		expect(readFileSync(join(ws.path, "a.txt"), "utf8")).toBe("three\n");
		expect(existsSync(join(ws.path, "new.txt"))).toBe(true);
		expect(existsSync(join(ws.path, "ignored.log"))).toBe(false);
		expect(existsSync(join(ws.path, "tracked-ignored.log"))).toBe(true);
		expect(existsSync(join(ws.path, ".swarm-inside"))).toBe(false);
		expect(existsSync(join(ws.path, "nested", "n.txt"))).toBe(false);
		expect(notes.join(" ")).toContain("nested repository nested");
		expect(git(top, "status", "--porcelain=v2")).toBe(statusBefore);
		expect(readFileSync(join(top, ".git", "index")).equals(indexBefore)).toBe(true);
		expect(git(top, "stash", "list")).toBe("");
	});

	test("sparse checkout, oversize input and branch collisions are refused", async () => {
		const { top, swarm } = repo();
		git(top, "config", "core.sparseCheckout", "true");
		await expect(prepareGroup(defaultGit, "share", top, swarm, SID, 200)).rejects.toThrow(/sparse checkout/);
		git(top, "config", "core.sparseCheckout", "false");
		writeFileSync(join(top, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 1));
		await expect(prepareGroup(defaultGit, "share", top, swarm, SID, 1)).rejects.toThrow(/share would copy/);
		rmSync(join(top, "big.bin"));
		git(top, "branch", `swarm/${SID}/taken`);
		const g = await prepareGroup(defaultGit, "branch", top, swarm, SID, 200);
		await expect(addWorktree(defaultGit, g, swarm, SID, "taken")).rejects.toThrow(/already exists/);
	});

	test("a dirty submodule refuses share; hooks never run for runtime git commands", async () => {
		const { root, top, swarm } = repo();
		const sub = join(root, "sub");
		mkdirSync(sub);
		git(sub, "init", "-q");
		writeFileSync(join(sub, "s.txt"), "s\n");
		git(sub, "add", ".");
		git(sub, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "s");
		git(top, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
		git(top, "commit", "-q", "-m", "add sub");
		const hooks = join(top, ".git", "hooks");
		for (const hook of ["pre-commit", "post-checkout", "commit-msg"]) {
			writeFileSync(join(hooks, hook), "#!/bin/sh\necho hook ran >> " + join(root, "hook.log") + "\nexit 1\n");
			chmodSync(join(hooks, hook), 0o755);
		}
		writeFileSync(join(top, "a.txt"), "changed\n");
		const ok = await share(top, swarm, "hooked");
		expect(readFileSync(join(ok.ws.path, "a.txt"), "utf8")).toBe("changed\n");
		expect(existsSync(join(root, "hook.log"))).toBe(false);
		writeFileSync(join(top, "sub", "s.txt"), "dirty\n");
		await expect(prepareGroup(defaultGit, "share", top, swarm, SID, 200)).rejects.toThrow(/submodule sub has uncommitted changes/);
	});
});

describe("disposition (preservation first)", () => {
	test("clean → removed; dirty → WIP ref then removed; the branch is never deleted", async () => {
		const { top, swarm } = repo();
		const clean = await share(top, swarm, "clean", "branch");
		const r1 = await disposeWorkspace(defaultGit, clean.ws, opts("clean"));
		expect(r1?.state).toBe("removed");
		expect(existsSync(clean.ws.root as string)).toBe(false);
		expect(git(top, "branch", "--list", `swarm/${SID}/clean`).trim()).not.toBe("");
		const dirty = await share(top, swarm, "dirty", "branch");
		writeFileSync(join(dirty.ws.path, "a.txt"), "wip\n");
		writeFileSync(join(dirty.ws.path, "untracked.txt"), "u\n");
		const r2 = await disposeWorkspace(defaultGit, dirty.ws, opts("dirty"));
		expect(r2?.state).toBe("removed");
		expect(r2?.wip_ref).toBe(`refs/swarm/${SID}/dirty/wip`);
		expect(git(top, "show", `${r2?.wip}:a.txt`)).toBe("wip\n");
		expect(git(top, "show", `${r2?.wip}:untracked.txt`)).toBe("u\n");
	});

	test("WIP failure retains without recommending --force", async () => {
		const { top, swarm } = repo();
		const d = await share(top, swarm, "fixer", "branch");
		writeFileSync(join(d.ws.path, "a.txt"), "wip\n");
		const failing: GitRunner = (args, o) =>
			args.includes("commit-tree") ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: No space left on device" }) : defaultGit(args, o);
		const r = await disposeWorkspace(failing, d.ws, opts("fixer"));
		expect(r?.state).toBe("retained");
		expect(r?.reason).toContain("could not preserve uncommitted work: fatal: No space left on device");
		expect(r?.cleanup).not.toContain("--force");
		expect(existsSync(d.ws.root as string)).toBe(true);
	});

	test("staged-only content differing from HEAD and the working file is retained", async () => {
		const { top, swarm } = repo();
		const d = await share(top, swarm, "staged", "branch");
		writeFileSync(join(d.ws.path, "a.txt"), "staged\n");
		git(d.ws.path, "add", "a.txt");
		writeFileSync(join(d.ws.path, "a.txt"), "working\n");
		const r = await disposeWorkspace(defaultGit, d.ws, opts("staged"));
		expect(r?.state).toBe("retained");
		expect(r?.reason).toContain("staged changes in a.txt differ");
	});

	test("a newly staged gitignored file is preserved in the WIP commit before removal (M1)", async () => {
		const { top, swarm } = repo();
		const d = await share(top, swarm, "forced", "branch");
		writeFileSync(join(d.ws.path, "ignored.log"), "keep me\n");
		git(d.ws.path, "add", "-f", "ignored.log");
		const r = await disposeWorkspace(defaultGit, d.ws, opts("forced"));
		expect(r?.state).toBe("removed");
		expect(r?.wip_ref).toBe(`refs/swarm/${SID}/forced/wip`);
		expect(git(top, "show", `${r?.wip}:ignored.log`)).toBe("keep me\n");
	});

	test("ignored files retain unless discard_ignored; nested repos, dependents and unregistered paths retain", async () => {
		const { top, swarm } = repo();
		const d = await share(top, swarm, "ign", "branch");
		writeFileSync(join(d.ws.path, "ignored.log"), "x\n");
		const r1 = await disposeWorkspace(defaultGit, d.ws, opts("ign"));
		expect(r1?.state).toBe("retained");
		expect(r1?.reason).toContain("ignored entries");
		const r2 = await disposeWorkspace(defaultGit, d.ws, opts("ign", { discardIgnored: true }));
		expect(r2?.state).toBe("removed");
		const n = await share(top, swarm, "nest", "branch");
		mkdirSync(join(n.ws.path, "build"));
		git(join(n.ws.path, "build"), "init", "-q");
		const r3 = await disposeWorkspace(defaultGit, n.ws, opts("nest", { discardIgnored: true }));
		expect(r3?.state).toBe("retained");
		expect(r3?.reason).toContain("nested repository");
		const dep = await share(top, swarm, "dep", "branch");
		const r4 = await disposeWorkspace(defaultGit, dep.ws, opts("dep", { dependents: ["helper"] }));
		expect(r4?.reason).toBe("in use by helper");
		const fake: WorkspaceRecord = { ...dep.ws, root: join(swarm, "nowhere"), path: join(swarm, "nowhere") };
		mkdirSync(fake.root as string);
		const r5 = await disposeWorkspace(defaultGit, fake, opts("dep"));
		expect(r5?.reason).toContain("not a registered worktree");
	});

	test("a worker that detached keeps its commits reachable through a head ref", async () => {
		const { top, swarm } = repo();
		const d = await share(top, swarm, "det", "branch");
		git(d.ws.path, "checkout", "-q", "--detach");
		writeFileSync(join(d.ws.path, "x.txt"), "x\n");
		git(d.ws.path, "add", "x.txt");
		git(d.ws.path, "commit", "-q", "-m", "detached work");
		const head = git(d.ws.path, "rev-parse", "HEAD").trim();
		const r = await disposeWorkspace(defaultGit, d.ws, opts("det"));
		expect(r?.state).toBe("removed");
		expect(r?.head_ref).toBe(`refs/swarm/${SID}/det/head`);
		expect(git(top, "rev-parse", `refs/swarm/${SID}/det/head`).trim()).toBe(head);
	});
});
