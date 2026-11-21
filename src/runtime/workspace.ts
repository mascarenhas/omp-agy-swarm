// Workspaces: inherit | share | branch (§9) with preservation-first cleanup (SW-06).
//
// Every git call is execFile("git", argv) with no shell and a 60 s timeout. Porcelain commands
// run with `-c core.hooksPath=/dev/null`; runtime commits are plumbing (`commit-tree
// --no-gpg-sign`). The runtime never deletes a branch or a ref and never runs push, merge,
// prune or gc. A worktree is removed only after every check passes and its uncommitted work is
// preserved; on any failure or ambiguity it is retained and reported.

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceMode, WorkspaceRecord } from "../board/types.ts";
import { TIMING } from "../env.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface GitOptions {
	cwd?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export type GitRunner = (args: string[], opts?: GitOptions) => Promise<GitResult>;

export const defaultGit: GitRunner = (args, opts = {}) => {
	const { promise, resolve: done } = Promise.withResolvers<GitResult>();
	execFile(
		"git",
		args,
		{
			cwd: opts.cwd,
			// GIT_OPTIONAL_LOCKS=0: `git status` must not refresh (rewrite) the user's index.
			env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
			timeout: TIMING.gitTimeoutMs,
			maxBuffer: 256 * 1024 * 1024,
			signal: opts.signal,
			encoding: "utf8",
		},
		(err, stdout, stderr) => {
			let code = 0;
			if (err) code = "code" in err && typeof err.code === "number" ? err.code : 1;
			done({ code, stdout: String(stdout ?? ""), stderr: String(stderr || (err ? err.message : "")) });
		},
	);
	return promise;
};

export class WorkspaceError extends Error {}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

async function must(git: GitRunner, args: string[], opts?: GitOptions): Promise<string> {
	const r = await git(args, opts);
	if (r.code !== 0) throw new WorkspaceError((r.stderr || r.stdout || `git ${args[0]} failed`).trim().split("\n")[0] ?? "");
	return r.stdout;
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Identity for runtime-authored commits: the repo's, else a fixed swarm identity. */
async function commitEnv(git: GitRunner, top: string): Promise<Record<string, string>> {
	const email = await git(["-C", top, "config", "--get", "user.email"]);
	const name = await git(["-C", top, "config", "--get", "user.name"]);
	if (email.code === 0 && name.code === 0) return {};
	return {
		GIT_AUTHOR_NAME: "omp-agy-swarm",
		GIT_AUTHOR_EMAIL: "swarm@localhost",
		GIT_COMMITTER_NAME: "omp-agy-swarm",
		GIT_COMMITTER_EMAIL: "swarm@localhost",
	};
}

export interface RepoInfo {
	top: string;
	common: string;
	base0: string;
	rel: string;
}

export async function repoInfo(git: GitRunner, adderCwd: string, mode: WorkspaceMode, signal?: AbortSignal): Promise<RepoInfo> {
	const cwdReal = realpathSync(adderCwd);
	const topR = await git(["-C", cwdReal, "rev-parse", "--show-toplevel"], { signal });
	if (topR.code !== 0) throw new WorkspaceError(`workspace:"${mode}" needs a git repository; use "inherit"`);
	const top = realpathSync(topR.stdout.trim());
	const commonRaw = (await must(git, ["-C", top, "rev-parse", "--git-common-dir"], { signal })).trim();
	const common = realpathSync(resolve(top, commonRaw));
	const baseR = await git(["-C", top, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { signal });
	if (baseR.code !== 0 || !baseR.stdout.trim())
		throw new WorkspaceError('the repository has no commits yet; use workspace:"inherit" or make an initial commit');
	const rel = relative(top, cwdReal);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new WorkspaceError("the working directory is outside the repository");
	return { top, common, base0: baseR.stdout.trim(), rel };
}

/** Paths of every registered worktree (realpaths where they exist). */
async function worktreePaths(git: GitRunner, top: string, signal?: AbortSignal): Promise<string[]> {
	const out = await must(git, ["-C", top, "worktree", "list", "--porcelain"], { signal });
	return out
		.split("\n")
		.filter(l => l.startsWith("worktree "))
		.map(l => {
			const p = l.slice("worktree ".length);
			try {
				return realpathSync(p);
			} catch {
				return p;
			}
		});
}

function hasNestedGit(dir: string, budget: { left: number }): string | null {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}
	for (const e of entries) {
		if (--budget.left < 0) return "<too many files to check>";
		const p = join(dir, e);
		if (e === ".git") return p;
		let isDir = false;
		try {
			isDir = lstatSync(p).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			const nested = hasNestedGit(p, budget);
			if (nested) return nested;
		}
	}
	return null;
}

/**
 * share snapshot (§9.2): the adder's working tree as it stands, through a scratch index outside
 * the repository (the user's index, worktree and stash are untouched).
 */
export async function snapshot(
	git: GitRunner,
	info: RepoInfo,
	swarmDir: string,
	sid: string,
	maxMb: number,
	signal?: AbortSignal,
): Promise<{ base: string; notes: string[] }> {
	const { top, base0 } = info;
	const notes: string[] = [];
	const sparse = await git(["-C", top, "config", "--bool", "core.sparseCheckout"], { signal });
	if (sparse.stdout.trim() === "true") throw new WorkspaceError("share is not supported in a sparse checkout; use branch or inherit");
	const st2 = await must(git, ["-C", top, "status", "--porcelain=v2", "-z", "--ignore-submodules=none"], { signal });
	for (const rec of st2.split("\0")) {
		// "1 <XY> <sub> ..." where sub is "S<c><m><u>" for submodules
		const parts = rec.split(" ");
		if ((parts[0] === "1" || parts[0] === "2") && parts[2]?.startsWith("S") && parts[2] !== "S...") {
			const path = parts.slice(parts[0] === "1" ? 8 : 9).join(" ");
			throw new WorkspaceError(`submodule ${path} has uncommitted changes`);
		}
	}
	const exclude: string[] = [];
	let swarmReal = swarmDir;
	try {
		swarmReal = realpathSync(swarmDir);
	} catch {}
	if (isInside(swarmReal, top) && swarmReal !== top) exclude.push(relative(top, swarmReal));
	for (const wt of await worktreePaths(git, top, signal)) {
		if (wt !== top && isInside(wt, top)) exclude.push(relative(top, wt));
	}
	const others = (await must(git, ["-C", top, "ls-files", "--others", "--exclude-standard", "-z"], { signal }))
		.split("\0")
		.filter(Boolean)
		.filter(p => !exclude.some(x => p === x || p.startsWith(`${x}/`)));
	let bytes = 0;
	const nested = new Set<string>();
	for (const p of others) {
		const abs = join(top, p);
		try {
			const st = lstatSync(abs);
			if (st.isFile()) bytes += st.size;
		} catch {}
	}
	// Directories git lists as units (nested repositories show as "dir/").
	const dirs = (await must(git, ["-C", top, "ls-files", "--others", "--exclude-standard", "--directory", "-z"], { signal }))
		.split("\0")
		.filter(p => p.endsWith("/"));
	for (const d of dirs) {
		const rel = d.slice(0, -1);
		if (existsSync(join(top, rel, ".git"))) nested.add(rel);
	}
	for (const n of nested) {
		exclude.push(n);
		notes.push(`nested repository ${n} was not copied`);
	}
	if (others.length > 20_000 || bytes > maxMb * 1024 * 1024)
		throw new WorkspaceError(
			`share would copy ${Math.ceil(bytes / (1024 * 1024))} MB of untracked files; commit, ignore or use branch`,
		);
	const scratch = mkdtempSync(join(tmpdir(), "omp-swarm-idx-"));
	const env = { GIT_INDEX_FILE: join(scratch, "index") };
	try {
		await must(git, ["-C", top, "read-tree", base0], { env, signal });
		const pathspec = [".", ...exclude.map(x => `:(exclude)${x}`)];
		await must(git, ["-C", top, ...NO_HOOKS, "add", "-A", "--", ...pathspec], { env, signal });
		// Files the user tracks (in their index) stay included even when an ignore pattern matches
		// them; `add -A` alone skips those that are not in the base commit yet.
		const trackedIgnored = (await trackedIgnoredPaths(git, top, signal)).filter(p => !exclude.some(x => p === x || p.startsWith(`${x}/`)));
		await forceAdd(git, top, trackedIgnored, env, signal);
		const tree = (await must(git, ["-C", top, "write-tree"], { env, signal })).trim();
		const baseTree = (await must(git, ["-C", top, "rev-parse", `${base0}^{tree}`], { signal })).trim();
		if (tree === baseTree) return { base: base0, notes };
		const cenv = await commitEnv(git, top);
		const sha = (
			await must(git, ["-C", top, "commit-tree", tree, "-p", base0, "--no-gpg-sign", "-m", `swarm snapshot ${sid}`], {
				env: cenv,
				signal,
			})
		).trim();
		return { base: sha, notes };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export interface PreparedGroup {
	info: RepoInfo;
	mode: "share" | "branch";
	base: string;
	notes: string[];
}

export async function prepareGroup(
	git: GitRunner,
	mode: "share" | "branch",
	adderCwd: string,
	swarmDir: string,
	sid: string,
	maxMb: number,
	signal?: AbortSignal,
): Promise<PreparedGroup> {
	const info = await repoInfo(git, adderCwd, mode, signal);
	if (mode === "branch") return { info, mode, base: info.base0, notes: [] };
	const snap = await snapshot(git, info, swarmDir, sid, maxMb, signal);
	return { info, mode, base: snap.base, notes: snap.notes };
}

export function branchName(sid: string, name: string): string {
	return `swarm/${sid}/${name}`;
}

export async function addWorktree(
	git: GitRunner,
	group: PreparedGroup,
	swarmDir: string,
	sid: string,
	name: string,
	signal?: AbortSignal,
): Promise<{ ws: WorkspaceRecord; notes: string[] }> {
	const { info } = group;
	const branch = branchName(sid, name);
	const exists = await git(["-C", info.top, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { signal });
	if (exists.code === 0) throw new WorkspaceError(`branch ${branch} already exists; use another name`);
	const wt = join(swarmDir, "workspaces", name);
	if (existsSync(wt)) throw new WorkspaceError(`${wt} already exists`);
	await must(git, ["-C", info.top, ...NO_HOOKS, "worktree", "add", "-b", branch, wt, group.base], { signal });
	const notes: string[] = [];
	let cwd = wt;
	if (info.rel !== "") {
		const sub = join(wt, info.rel);
		if (existsSync(sub) && statSync(sub).isDirectory()) cwd = sub;
		else notes.push(`${info.rel} does not exist in the base; ${name} starts at the worktree root`);
	}
	return {
		ws: {
			mode: group.mode,
			path: realpathSync(cwd),
			root: realpathSync(wt),
			repo: info.top,
			common: info.common,
			branch,
			base: group.base,
			state: "active",
		},
		notes,
	};
}

/** Removes a worktree this operation created and nobody used (failed construction). */
export async function discardFreshWorktree(git: GitRunner, ws: WorkspaceRecord): Promise<void> {
	if (!ws.root || !ws.repo) return;
	await git(["-C", ws.repo, ...NO_HOOKS, "worktree", "remove", "--force", ws.root]);
}

/** Whether a recorded worktree is still present and registered (revival check). */
export async function verifyWorktree(git: GitRunner, ws: WorkspaceRecord): Promise<boolean> {
	if (ws.mode === "inherit") return existsSync(ws.path);
	if (!ws.root || !ws.repo || !existsSync(ws.path)) return false;
	try {
		const listed = await worktreePaths(git, ws.repo);
		const root = realpathSync(ws.root);
		if (!listed.includes(root)) return false;
		const common = realpathSync(resolve(root, (await must(git, ["-C", root, "rev-parse", "--git-common-dir"])).trim()));
		return !ws.common || common === ws.common;
	} catch {
		return false;
	}
}

export interface DisposeOptions {
	sid: string;
	name: string;
	discardIgnored: boolean;
	keepWorkspace: boolean;
	dependents: string[];
	stoppedCleanly: boolean;
}

export interface DisposeResult {
	name: string;
	state: "removed" | "retained";
	path?: string;
	branch?: string;
	commits?: number;
	wip?: string;
	wip_ref?: string;
	head_ref?: string;
	reason?: string;
	cleanup?: string;
}

function retained(name: string, ws: WorkspaceRecord, reason: string, cleanup?: string): DisposeResult {
	const root = ws.root ?? ws.path;
	return {
		name,
		state: "retained",
		path: root,
		branch: ws.branch,
		reason,
		cleanup: cleanup ?? (ws.repo ? `git -C ${ws.repo} worktree remove ${root}` : `inspect ${root}`),
	};
}

interface StatusEntry {
	xy: string;
	path: string;
}

function parseStatusZ(out: string): StatusEntry[] {
	const items = out.split("\0");
	const res: StatusEntry[] = [];
	for (let i = 0; i < items.length; i++) {
		const rec = items[i];
		if (!rec || rec.length < 4) continue;
		const xy = rec.slice(0, 2);
		res.push({ xy, path: rec.slice(3) });
		if (xy[0] === "R" || xy[0] === "C") i++; // rename/copy: the next item is the source path
	}
	return res;
}

/** Paths the index tracks although an ignore pattern matches them, present on disk (lstat). */
async function trackedIgnoredPaths(git: GitRunner, top: string, signal?: AbortSignal): Promise<string[]> {
	const out = await must(git, ["-C", top, "ls-files", "-z", "--cached", "--ignored", "--exclude-standard"], { signal });
	return out.split("\0").filter(p => p && present(join(top, p)));
}

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** `add -f` in batches into the scratch index `env` names (`add -A` skips ignored paths). */
async function forceAdd(git: GitRunner, top: string, paths: readonly string[], env: Record<string, string>, signal?: AbortSignal): Promise<void> {
	for (let i = 0; i < paths.length; i += 500) {
		await must(git, ["-C", top, ...NO_HOOKS, "add", "-f", "--", ...paths.slice(i, i + 500)], { env, signal });
	}
}

/**
 * Snapshot of a worktree's content into a tree via a scratch index (never the worktree's own
 * index). Tracked or staged files that an ignore pattern matches are added too, and every path the
 * worktree's index holds that exists on disk must be in the tree; otherwise this throws (the
 * caller retains the worktree).
 */
async function worktreeTree(git: GitRunner, root: string, head: string): Promise<string> {
	const scratch = mkdtempSync(join(tmpdir(), "omp-swarm-wip-"));
	const env = { GIT_INDEX_FILE: join(scratch, "index") };
	try {
		await must(git, ["-C", root, "read-tree", head], { env });
		await must(git, ["-C", root, ...NO_HOOKS, "add", "-A", "--", "."], { env });
		await forceAdd(git, root, await trackedIgnoredPaths(git, root), env);
		const tree = (await must(git, ["-C", root, "write-tree"], { env })).trim();
		const inTree = new Set((await must(git, ["-C", root, "ls-tree", "-r", "-z", "--name-only", tree])).split("\0").filter(Boolean));
		const indexed = (await must(git, ["-C", root, "ls-files", "-z", "--cached"])).split("\0").filter(Boolean);
		const missing = indexed.find(p => !inTree.has(p) && present(join(root, p)));
		if (missing !== undefined) throw new WorkspaceError(`${missing} is in the worktree's index but not in its preserved tree`);
		return tree;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Disposition on kill (§9.4 with SW-06): preservation first, retain on any doubt. */
export async function disposeWorkspace(git: GitRunner, ws: WorkspaceRecord, o: DisposeOptions): Promise<DisposeResult | null> {
	if (ws.mode === "inherit") return null;
	const name = o.name;
	const root = ws.root;
	const repo = ws.repo;
	if (!root || !repo) return retained(name, ws, "the workspace record is incomplete");
	if (ws.state === "removed") return { name, state: "removed", path: root, branch: ws.branch };
	if (o.keepWorkspace) return retained(name, ws, "requested");
	if (!o.stoppedCleanly)
		return retained(name, ws, "the worker did not finish stopping; its session may still be writing", `kill ${name} again later`);
	if (o.dependents.length) return retained(name, ws, `in use by ${o.dependents.join(", ")}`);
	if (!existsSync(root)) return retained(name, ws, "the worktree directory is missing");
	const verifyIdentity = async (): Promise<string | null> => {
		try {
			const listed = await worktreePaths(git, repo);
			const real = realpathSync(root);
			if (!listed.includes(real)) return `not a registered worktree of ${repo}`;
			const common = realpathSync(resolve(real, (await must(git, ["-C", real, "rev-parse", "--git-common-dir"])).trim()));
			if (ws.common && common !== ws.common) return `not a registered worktree of ${repo}`;
			return null;
		} catch (err) {
			return `cannot verify the worktree: ${(err as Error).message}`;
		}
	};
	const bad = await verifyIdentity();
	if (bad) return retained(name, ws, bad);
	try {
		const head = (await must(git, ["-C", root, "rev-parse", "HEAD"])).trim();
		const unmerged = (await must(git, ["-C", root, "ls-files", "-u", "-z"])).split("\0").filter(Boolean);
		if (unmerged.length) return retained(name, ws, `${unmerged.length} unmerged index entries`);
		const st2 = await must(git, ["-C", root, "status", "--porcelain=v2", "-z", "--ignore-submodules=none"]);
		for (const rec of st2.split("\0")) {
			const parts = rec.split(" ");
			if ((parts[0] === "1" || parts[0] === "2") && parts[2]?.startsWith("S") && parts[2] !== "S...")
				return retained(name, ws, "a submodule has uncommitted changes");
		}
		const status1 = await must(git, ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		const entries = parseStatusZ(status1);
		for (const e of entries) {
			const x = e.xy[0] ?? " ";
			const y = e.xy[1] ?? " ";
			if (x !== " " && x !== "?" && x !== "!" && y !== " ")
				return retained(name, ws, `staged changes in ${e.path} differ from the working tree`);
		}
		const budget = { left: 200_000 };
		for (const top of readdirSync(root)) {
			if (top === ".git") continue;
			const p = join(root, top);
			let isDir = false;
			try {
				isDir = lstatSync(p).isDirectory();
			} catch {}
			if (!isDir) continue;
			const nested = hasNestedGit(p, budget);
			if (nested) return retained(name, ws, `nested repository or unverifiable content at ${nested}`);
		}
		const dirty = entries.length > 0;
		const result: DisposeResult = { name, state: "removed", path: root, branch: ws.branch };
		if (dirty) {
			let wip: string;
			try {
				const tree = await worktreeTree(git, root, head);
				const cenv = await commitEnv(git, repo);
				wip = (
					await must(git, ["-C", root, "commit-tree", tree, "-p", head, "--no-gpg-sign", "-m", `swarm: uncommitted work of ${name}`], {
						env: cenv,
					})
				).trim();
				const ref = `refs/swarm/${o.sid}/${name}/wip`;
				await must(git, ["-C", repo, "update-ref", ref, wip]);
				const again = await worktreeTree(git, root, head);
				const status2 = await must(git, ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
				if (again !== tree || status2 !== status1)
					return retained(name, ws, "the worktree changed while its work was being preserved", `inspect ${root}`);
				result.wip = wip;
				result.wip_ref = ref;
			} catch (err) {
				return retained(
					name,
					ws,
					`could not preserve uncommitted work: ${(err as Error).message}`,
					`inspect ${root} and copy or commit what you need first; then git -C ${repo} worktree remove ${root}`,
				);
			}
		}
		if (ws.branch) {
			const anc = await git(["-C", repo, "merge-base", "--is-ancestor", head, `refs/heads/${ws.branch}`]);
			if (anc.code !== 0) {
				const ref = `refs/swarm/${o.sid}/${name}/head`;
				await must(git, ["-C", repo, "update-ref", ref, head]);
				result.head_ref = ref;
			}
		}
		const ignoredOut = await must(git, ["-C", root, "status", "--porcelain=v1", "-z", "--ignored"]);
		const ignored = parseStatusZ(ignoredOut).filter(e => e.xy === "!!");
		if (ignored.length && !o.discardIgnored) {
			let size = 0;
			for (const e of ignored) {
				try {
					size += lstatSync(join(root, e.path)).size;
				} catch {}
			}
			return {
				...retained(
					name,
					ws,
					`${ignored.length} ignored entries (${Math.ceil(size / 1024)} KB at the top level) are not preserved; kill again with discard_ignored:true to remove them`,
					`swarm{action:"kill", name:"${name}", discard_ignored:true}`,
				),
				wip: result.wip,
				wip_ref: result.wip_ref,
				head_ref: result.head_ref,
			};
		}
		// Re-check identity and HEAD right before removal.
		const bad2 = await verifyIdentity();
		if (bad2) return retained(name, ws, bad2);
		const head2 = (await must(git, ["-C", root, "rev-parse", "HEAD"])).trim();
		if (head2 !== head) return retained(name, ws, "the worktree's HEAD moved during cleanup", `inspect ${root}`);
		const removeArgs = dirty
			? ["-C", repo, ...NO_HOOKS, "worktree", "remove", "--force", root]
			: ["-C", repo, ...NO_HOOKS, "worktree", "remove", root];
		let rm = await git(removeArgs);
		if (rm.code !== 0 && !dirty && o.discardIgnored) {
			// Plain removal refused; everything but ignored files was verified clean above.
			rm = await git(["-C", repo, ...NO_HOOKS, "worktree", "remove", "--force", root]);
		}
		if (rm.code !== 0) return retained(name, ws, `worktree remove failed: ${(rm.stderr || rm.stdout).trim().split("\n")[0]}`);
		if (ws.base && ws.branch) {
			const n = await git(["-C", repo, "rev-list", "--count", `${ws.base}..refs/heads/${ws.branch}`]);
			if (n.code === 0) result.commits = Number(n.stdout.trim()) || 0;
		}
		return result;
	} catch (err) {
		return retained(name, ws, `cleanup check failed: ${(err as Error).message}`);
	}
}

export function describeBase(ws: WorkspaceRecord): string {
	if (ws.mode === "share") return `a snapshot of the adder's working copy (commit ${ws.base?.slice(0, 9) ?? "?"})`;
	return `commit ${ws.base?.slice(0, 9) ?? "?"}`;
}

/** Whether `child` (a member's cwd) lies inside a workspace root. */
export function cwdInside(child: string, root: string): boolean {
	return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}
