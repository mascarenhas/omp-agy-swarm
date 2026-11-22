import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { board, readJson, roster } from "./check.ts";
import { evidence, type Job, type PaidCtx, type Trace } from "./paid-evidence.ts";
import type { PtyOmp } from "../helpers/pty.ts";

export const HUB_MARKER = "R9-PRIVATE-a37e5d1c";
export const HUB_DIRTY = "R9-WIP-d7820a19";
export const HUB_NOTICE = "lens was stopped in omp and permanently killed in the swarm.";

export function mark(c: PaidCtx, action: string, detail: { id?: string; text?: string } = {}): void {
	appendFileSync(c.trace, `${JSON.stringify({ at: Date.now(), kind: "harness", action, ...detail })}\n`);
}

export function syncArtifactRoot(c: PaidCtx, trace: Trace[]): void {
	const root = trace.find(row => row.kind === "root");
	if (root?.swarm && root.sessionFile?.startsWith(`${join(c.T, "sessions")}/`)) c.swarm = root.swarm;
}

export async function until(predicate: () => boolean, ms: number, label: string, alive = (): boolean => true): Promise<void> {
	const end = performance.now() + ms;
	while (!predicate()) {
		if (!alive()) throw new Error(`omp exited while waiting for ${label}`);
		if (performance.now() >= end) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(50);
	}
}

/** Interactive finish persists an accepted board marker, not a headless gate outcome. */
export function acceptedHubFinish(c: PaidCtx, trace: Trace[]): boolean {
	const attempts = new Set(trace.flatMap(row => row.kind === "event" && row.id === "Main" && row.swarmArgs?.action === "finish" ? [row.callId] : []));
	const marker = board(c).findLast(row => row.agent === "coordinator" && row.text === "[done] R9 Hub check finished");
	return !!marker && trace.some(row => row.kind === "event" && row.id === "Main" && row.tool === "swarm" &&
		row.event === "tool_execution_end" && !row.isError && attempts.has(row.callId) &&
		row.text?.includes('"completion":"accepted"') && /"seq":(\d+)/.exec(row.text)?.[1] === String(marker.seq));
}

/** Real native Hub actions. No TSP hello, protocol input injection, or lifecycle calls. */
export async function driveHub(p: PtyOmp, c: PaidCtx, prompt: string): Promise<void> {
	const alive = () => p.proc.exitCode === null && p.proc.signalCode === null;
	// The default status bar shows π in idle Main and the worker ID in a focused transcript.
	const mainStatus = /(?:^|[\r\n])[ \t]*π\s*>\s*[^>\r\n]*(?:DeepSeek|Mock coord)/i;
	const submit = async (text: string): Promise<void> => {
		if (text.startsWith("/")) await p.type(text);
		else {
			p.write(`\x1b[200~${text}\x1b[201~`);
			await p.waitFor(shown => shown.includes(text.slice(0, 35)), 10_000, "pasted prompt in Main editor");
		}
		p.write("\r");
	};
	await until(() => evidence(c).some(row => row.kind === "root"), 20_000, "session startup", alive);
	await p.waitFor(text => mainStatus.test(text), 15_000, "Main editor");
	await submit(prompt);
	await until(() => {
		const trace = evidence(c);
		syncArtifactRoot(c, trace);
		const w = roster(c).lens;
		return !!w?.agent_id && trace.some(row => row.kind === "progress" && row.id === w.agent_id && row.intent === "waiting on board") &&
			!!w.workspace.path && existsSync(join(w.workspace.path, "dirty-hub.txt")) &&
			trace.some(row => row.kind === "event" && row.id === "Main" && row.event === "agent_end");
	}, 120_000, "dirty parked worker", alive);
	await until(() => evidence(c).some(row => row.kind === "response" && row.id === "Main" && row.text === "R9-MAIN-READY"),
		30_000, "Main assistant's ready acknowledgement", alive);
	if (p.since().includes(HUB_MARKER)) throw new Error("the private worker transcript marker leaked into Main before focus");
	const id = roster(c).lens!.agent_id!;
	const openHub = async (): Promise<void> => {
		p.mark();
		await submit("/hub");
		await p.waitFor(text => text.includes("Activity") && text.includes("Agents"), 10_000, "native Hub tabs");
		p.mark();
		p.write("1");
		await p.waitFor(text => text.includes(id), 10_000, "worker on Agents tab");
	};
	await openHub();
	p.mark();
	p.write("\r");
	await p.waitFor(text => text.includes(HUB_MARKER) && text.includes(`${id} >`), 10_000, "focused transcript and status id");
	mark(c, "hub-focus", { id, text: p.since() });
	p.mark();
	p.write("\x1b");
	await p.waitFor(text => mainStatus.test(text), 10_000, "return to Main");
	await openHub();
	mark(c, "hub-x", { id });
	p.write("x");
	await until(() => roster(c).lens?.killed === true && roster(c).lens?.workspace.state === "removed", 15_000, "Hub kill and dirty-worktree disposition", alive);
	p.mark();
	p.write("\x1b");
	await p.waitFor(text => mainStatus.test(text) && text.includes(HUB_NOTICE), 45_000, "return to idle Main and display the Hub stop notice");
	await until(() => {
		const trace = evidence(c);
		const notice = trace.findIndex(row => row.kind === "event" && row.id === "Main" && row.customType === "swarm-wake" && row.text?.includes(HUB_NOTICE));
		return notice >= 0 && trace.slice(notice + 1).some(row => row.kind === "event" && row.id === "Main" && row.event === "agent_end");
	}, 45_000, "Main stopped after the Hub notification", alive);
	const afterNotice = evidence(c).length;
	p.mark();
	await submit('Attempt one post_message addressed to @lens with the exact text "@lens R9-RESUME-PROBE". Read the board once for any still-unread notices. Finish the swarm normally with summary "R9 Hub check finished", then reply R9-MAIN-COMPLETE. Do not revive or add any worker.');
	await until(() => acceptedHubFinish(c, evidence(c)), 90_000, "accepted interactive finish on the board", alive);
	await until(() => {
		const turn = evidence(c).slice(afterNotice);
		const reply = turn.findIndex(row => row.kind === "response" && row.id === "Main" && row.text === "R9-MAIN-COMPLETE");
		return reply >= 0 && turn.slice(reply + 1).some(row => row.kind === "event" && row.id === "Main" && row.event === "agent_end");
	}, 20_000, "Main assistant's completion acknowledgement and terminal turn", alive);
	await submit("/quit");
	await until(() => p.proc.exitCode !== null, 10_000, "graceful /quit", alive);
}

// Every command is bounded, even if a provider or the harness fails. Only the manifest
// from the test-owned Python process is used for PID evidence (never virtual shell $$).
export const BARRIER = `import json
import pathlib
import subprocess
import sys
import time

root = pathlib.Path('.paid')
root.mkdir(exist_ok=True)
action, name = sys.argv[1:]
child = None
if action == 'cancel':
    child = subprocess.Popen(['/usr/bin/sleep', '180'])
    import os
    def stat(pid):
        fields = pathlib.Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
        return dict(pid=pid, start=fields[19])
    report = root / (name + '.pids.tmp')
    report.write_text(json.dumps([stat(os.getpid()), stat(child.pid)]))
    report.replace(root / (name + '.pids'))
try:
    latch = root / (name + ('.ready' if action == 'wait' else '.release'))
    deadline = time.monotonic() + (170 if child else 150)
    while not latch.exists():
        if time.monotonic() >= deadline:
            sys.exit('fixture latch expired: ' + str(latch))
        time.sleep(0.05)
    if action == 'nonce':
        print(pathlib.Path(name + '.txt').read_text().strip())
    elif action == 'cancel':
        (root / (name + '.sentinel')).write_text('job ran after release')
        print(name + ' job completed; this result must not reach the worker')
finally:
    if child is not None:
        child.terminate()
        child.wait()
`;

export function file(c: PaidCtx, name: string, suffix: string): string {
	return join(c.repo, ".paid", `${name}.${suffix}`);
}

export function signal(c: PaidCtx, name: string, suffix: "ready" | "release"): void {
	const path = file(c, name, suffix);
	if (existsSync(path)) return;
	mkdirSync(join(c.repo, ".paid"), { recursive: true });
	mark(c, `${suffix}:${name}`);
	writeFileSync(path, "\n");
}

export function latestJobs(trace: Trace[], id: string | undefined): Job[] {
	const row = trace.findLast(r => r.kind === "jobs" && r.id === id);
	return row?.kind === "jobs" ? row.jobs : [];
}

export function runningBash(trace: Trace[], id: string | undefined): boolean {
	return latestJobs(trace, id).some(j => j.status === "running" && j.type === "bash" && j.ownerId === id);
}

export function parked(trace: Trace[], id: string | undefined): boolean {
	return trace.some(r => r.kind === "progress" && r.id === id && r.tool === "swarm_wait" && r.intent === "waiting on board");
}

export interface ProcIdentity { pid: number; start: string }
export const pids = (c: PaidCtx, name: string): ProcIdentity[] => readJson<ProcIdentity[]>(file(c, name, "pids")) ?? [];
export function live(p: ProcIdentity): boolean {
	try {
		const stat = readFileSync(`/proc/${p.pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19] === p.start && fields[0] !== "Z" && fields[0] !== "X";
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}
