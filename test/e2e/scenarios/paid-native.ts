import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { board, metrics, readJson, roster, treeHash } from "../check.ts";
import { EFFORT, type PaidScenario, SCOUT_PROVIDERS, W } from "../paid-contract.ts";
import { contentText, directBill, entries, type Entry, evidence, type Frame, jsonl, type Trace } from "../paid-evidence.ts";
import { acceptedHubFinish, BARRIER, file, HUB_DIRTY, HUB_MARKER, HUB_NOTICE, live, mark, parked, pids, runningBash, signal, until } from "../paid-fixtures.ts";

const events = (rows: Trace[], id: string | undefined) => rows.filter((r): r is Frame<"event"> => r.kind === "event" && r.id === id && r.source === "session");
const workerSpec = `model ${W.luna}, effort ${EFFORT}, workspace inherit`;
const gateText = "The swarm still has outstanding work";
const pendingText = /waiting on background work|working with pending background work|with background work/;
const jobWake = /"woke"\s*:\s*"job"/;
const asyncResult = (r: Trace): r is Frame<"event"> => r.kind === "event" && r.customType === "async-result";
const near = (a: number | undefined, b: number, tolerance = 0.0000005 + 1e-10) => a !== undefined && Math.abs(a - b) <= tolerance;

const R9: PaidScenario = {
	id: "R9", model: W.haiku, cap: 0.75, maxSeconds: 360, pty: true,
	fixture: { "hub-marker.txt": `${HUB_MARKER}\n` },
	prompt: `Read skill://swarm. This is a native UI exercise. Add exactly one worker named lens on ${W.haiku} with low effort and workspace branch. Its exact brief: "Write an untracked file dirty-hub.txt containing ${HUB_DIRTY}. Read hub-marker.txt yourself; emit only its exact content as PRIVATE assistant prose, never on the board or to Main. In the same response as that private prose, call swarm_wait{} as its sole tool call. If it returns woke:nudge, call untimed swarm_wait again; this private test intentionally has no board report. Stay parked. If a legitimate new assignment arrives, report it on the board." After add succeeds, reply R9-MAIN-READY and end this interactive turn. Do not wait, read its file or transcript, start another worker, or finish before the next user prompt. After the Hub stop notice reaches you in an automatic turn, reply R9-NOTICE-ACK and end immediately with no tools.`,
	check(c, k) {
		const trace = evidence(c);
		const members = roster(c);
		k.eq(Object.keys(members).filter(name => name !== "coordinator"), ["lens"], "exactly one Hub worker");
		const r = members.lens;
		const id = r?.agent_id;
		const root = trace.find(row => row.kind === "root");
		k.ok(root?.swarm && root.swarm === c.swarm && root.sessionFile?.startsWith(`${join(c.T, "sessions")}/`), "default persisted session artifact root was used");
		const ref = trace.find((row): row is Frame<"ref"> => row.kind === "ref" && row.id === id && row.attached);
		k.ok(ref && ref.parentId === undefined && ref.generation > 0 && ref.sessionFile && r?.session_file && join(c.swarm, "sessions", r.session_file.split("/").at(-1)!) === ref.sessionFile,
			"live root-level native worker ref matches the persisted worker id and transcript");
		k.ok(parked(trace, id), "worker progress displayed waiting on board before native focus");
		const focus = trace.findIndex(row => row.kind === "harness" && row.action === "hub-focus" && row.id === id && row.text?.includes(HUB_MARKER) && row.text.includes(`${id} >`));
		const stop = trace.findIndex(row => row.kind === "harness" && row.action === "hub-x" && row.id === id);
		const fence = trace.findIndex(row => row.kind === "ref" && row.id === id && row.generation === ref?.generation && row.status === "aborted" && !row.attached);
		k.ok(focus >= 0 && stop > focus && fence > stop, "native Enter focused the worker transcript; actual Hub x tombstoned the exact generation");
		k.ok(trace.slice(fence + 1).some(row => row.kind === "ref" && row.id === id && row.generation === ref?.generation && row.change === "removed"), "the exact tombstone was removed from the global registry");
		k.eq(r?.killed, true, "roster member fence");
		k.ok(!trace.slice(fence + 1).some(row => row.kind === "usage" && row.id === id || row.kind === "event" && row.id === id && row.event === "agent_start" || row.kind === "ref" && row.id === id && row.attached),
			"no resumed worker generation, turn, or request after the kill fence");
		const b = board(c);
		k.ok(b.some(p => p.agent === "coordinator" && p.text === "@lens R9-RESUME-PROBE"), "the coordinator exercised a post against the killed worker");
		k.ok(r?.killed_seq !== undefined && !b.some(p => p.agent === "lens" && p.seq > r.killed_seq!), "killed worker never posted after its fence");
		k.ok(acceptedHubFinish(c, trace), "terminal interactive [done] matches Main's accepted finish receipt");
		k.eq(events(trace, "Main").flatMap(row => row.text?.split(HUB_NOTICE).slice(1) ?? []).length, 1, "one stop notice delivered to Main");
		k.eq(r?.workspace.state, "removed", "dirty worktree disposition");
		k.ok(r?.workspace.path && !existsSync(r.workspace.path), "workspace path was removed");
		const sid = readJson<{ id: string }>(join(c.swarm, "members.json"))?.id;
		try {
			const got = execFileSync("git", ["-C", c.repo, "show", `refs/swarm/${sid}/lens/wip:dirty-hub.txt`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			k.eq(got.trim(), HUB_DIRTY, "fixture content preserved in the WIP ref");
		} catch { k.ok(false, "exact WIP ref with dirty-hub.txt is missing"); }
		k.ok(entries(c, "lens").some(row => row.message?.role === "assistant" && contentText(row.message.content).includes(HUB_MARKER)), "worker's private transcript still readable through the swarm");
		k.ok(c.profiles && treeHash(c.profiles) === c.profilesBefore, "isolated agents/profile tree unchanged");
	},
};

const NONCE = "R10-WORKER-ef328d8a";
const MAIN_NONCE = "R10-MAIN-e174c301";
const R10: PaidScenario = {
	id: "R10", cap: 0.9, maxSeconds: 410,
	fixture: { "barrier.py": BARRIER, "worker.txt": `${NONCE}\n`, "main.txt": `${MAIN_NONCE}\n` },
	env: { OMP_SWARM_GATE_WAIT_SECONDS: "2" },
	prompt: `Add one worker named asyncworker (${workerSpec}). Brief: "Call managed bash with async:true, timeout:155, command /usr/bin/python3 barrier.py nonce worker. Then call untimed swarm_wait alone, never poll. The host will return woke:job and deliver its actual async-result. Post exactly one @coordinator [done] report with the output nonce. Return without starting more work." After add, call foreground bash (async:false, timeout:155) with command /usr/bin/python3 barrier.py wait worker. It only returns once the worker is parked with its job running. Then call swarm{action:'finish',summary:'R10 early probe'} normally (no abandon). It must refuse. Immediately end your turn with brief text; do NOT call swarm_wait yet. This deliberately exercises the stop gate. On the actual stop-gate reminder, call swarm_wait until the worker report arrives. Then use managed bash async:true, timeout:155, with command /usr/bin/python3 barrier.py nonce main. End your turn with brief text (no swarm_wait and no finish yet) to exercise Main's print-wake lease. On actual async-result, finish normally with the exact reported Main nonce in your finish summary, then end. Never read the nonce files directly.`,
	tick(c, trace) {
		const id = roster(c).asyncworker?.agent_id;
		if (runningBash(trace, id) && parked(trace, id)) signal(c, "worker", "ready");
		const main = events(trace, "Main");
		if (runningBash(trace, id) && main.some(r => r.customType === "session-stop-continuation" && r.text?.includes(gateText) && pendingText.test(r.text)))
			signal(c, "worker", "release");
		if (runningBash(trace, "Main") && main.some(r => r.event === "agent_pause" && r.awaiting)) signal(c, "main", "release");
	},
	check(c, k) {
		const trace = evidence(c);
		const members = roster(c);
		k.eq(Object.keys(members).filter(name => name !== "coordinator"), ["asyncworker"], "exactly one worker besides Main's native job");
		const id = members.asyncworker?.agent_id;
		const ready = trace.findIndex(r => r.kind === "harness" && r.action === "ready:worker");
		const release = trace.findIndex(r => r.kind === "harness" && r.action === "release:worker");
		const held = trace.slice(0, ready);
		const main = events(trace, "Main");
		const early = main.find(r => r.swarmArgs?.action === "finish");
		const refusal = trace.findIndex(r => r.kind === "event" && r.id === "Main" && r.callId === early?.callId &&
			r.event === "tool_execution_end" && r.isError && pendingText.test(r.text ?? ""));
		const block = trace.findIndex(r => r.kind === "event" && r.id === "Main" && r.customType === "session-stop-continuation" && r.text?.includes(gateText) && pendingText.test(r.text));
		k.ok(ready >= 0 && runningBash(held, id) && parked(held, id), "job owned and still running when worker entered untimed swarm_wait");
		k.ok(refusal > ready && block > refusal && release > block && runningBash(trace.slice(0, release), id) && trace.slice(refusal + 1, block).some(r => r.kind === "stop"),
			"normal finish refused and actual stop gate blocked for background work while the latch was held");
		k.ok((metrics(c)?.coordinator?.gate_refusals ?? 0) >= 1, "real stop-gate refusal persisted");
		k.eq(metrics(c)?.coordinator?.stall_wakes, 0, "no false stall wake");
		const resumed = events(trace.slice(release + 1), id);
		k.eq(resumed.filter(r => r.tool === "swarm_wait" && r.event === "tool_execution_end" && jobWake.test(r.text ?? "")).length, 1, "one worker woke:job receipt");
		k.eq(resumed.filter(r => asyncResult(r) && r.text?.includes(NONCE)).length, 1, "actual worker async-result with nonce delivered once");
		k.ok(!events(trace, id).some(r => r.event === "tool_execution_start" && !["bash", "swarm_wait", "post_message"].includes(r.tool ?? "")), "worker used no polling tools");
		k.eq(events(trace, id).filter(r => r.event === "tool_execution_start" && r.tool === "bash").length, 1, "only the initial worker bash call");
		const b = board(c);
		const report = b.filter(p => p.agent === "asyncworker" && p.text.includes(NONCE));
		const done = b.find(p => p.agent === "coordinator" && p.text.startsWith("[done]") && p.text.includes(MAIN_NONCE));
		k.eq(report.length, 1, "one worker nonce report");
		k.ok(done && report[0] && done.seq > report[0].seq, "worker report before Main final marker with Main nonce");
		const mainRelease = trace.findIndex(r => r.kind === "harness" && r.action === "release:main");
		const mainResult = trace.findIndex(r => asyncResult(r) && r.id === "Main" && r.text?.includes(MAIN_NONCE));
		k.ok(mainRelease > release && runningBash(trace.slice(0, mainRelease), "Main") && main.some(r => r.event === "agent_pause" && r.awaiting && r.at <= trace[mainRelease]!.at), "Main yielded while its own job was pending");
		k.eq(main.filter(r => asyncResult(r) && r.text?.includes(MAIN_NONCE)).length, 1, "one Main async-result without --wait-async");
		k.ok(mainResult > mainRelease && trace.slice(mainResult + 1).some(r => r.kind === "stop" && !r.pending.length), "Main reached a real terminal stop only after the job result");
		k.ok(!c.stderr.includes("native_async_mix") && !readJson<Record<string, unknown>>(join(c.swarm, "metrics.json"))?.native_async_mix, "obsolete native_async_mix absent");
	},
};

const FACT_A = "FACT-A-38f420a1";
const FACT_B = "FACT-B-b16a0ef2";
const R11: PaidScenario = {
	id: "R11", cap: 1.3, maxSeconds: 360,
	fixture: { "facts/alpha.txt": `header\nalpha: ${FACT_A}\n`, "facts/beta.txt": `header\nspacer\nbeta: ${FACT_B}\n` },
	prompt: override => `Use swarm. ${override ? `Before adding the worker, set swarm scout model to ${override} using swarm{action:'scout',model:'${override}'}. Do not substitute another override.` : "Do not override the native bundled/operator scout configuration."} Add one worker named finder (${workerSpec}). Brief: "Use exactly one native task call with context and two items in tasks, each with agent:'scout', name, task and solutionSpace. Their names are Alpha and Beta; the solution space is one exact fact per file. Ask Alpha to read facts/alpha.txt and give its alpha fact as path:line and exact nonce. Ask Beta to read facts/beta.txt and give its beta fact as path:line and exact nonce. Native nonblocking scout batches already run in the background. Call swarm_wait alone to park. Use only actual host deliveries, not read/bash/eval/polling for the facts. If one result arrives first, park again until both, then post one @coordinator [done] with both path:line and nonce pairs." Coordinate via swarm_wait as needed, read the report, then finish normally. No native task by Main; no swarm helpers other than finder.`,
	check(c, k) {
		const trace = evidence(c);
		const owner = roster(c).finder?.agent_id;
		// Native task reserves a running registry row before attaching the live
		// session. Some host lanes only attach it when adopting the completed scout.
		const refs = trace.filter((r): r is Frame<"ref"> => r.kind === "ref" && r.parentId === owner && !!owner && r.change === "registered" && r.status === "running");
		const children = [...new Set(refs.map(r => r.id))];
		k.eq(children.length, 2, "two distinct live native scout refs linked by exact parentId");
		k.eq(Object.keys(roster(c)).filter(n => n !== "coordinator"), ["finder"], "only the owning worker is on the swarm board/roster");
		const launch = children.map(id => trace.findIndex(r => r.kind === "life" && r.agent === "scout" && r.id === id && r.status === "started"));
		const end = children.map(id => trace.findIndex(r => r.kind === "life" && r.agent === "scout" && r.id === id && r.status === "completed"));
		k.ok(children.length === 2 && launch.every(i => i >= 0) && Math.max(...launch) < Math.min(...end), "native scout lifecycle intervals overlapped");
		const jobs = trace.flatMap(r => r.kind === "jobs" && r.id === owner ? r.jobs : []);
		const wantedModel = process.env.OMP_SWARM_PAID_SCOUT_MODEL?.split(":")[0];
		let childCost = 0;
		for (const id of children) {
			k.ok(jobs.some(j => j.ownerId === owner && j.agentId === id && j.type === "task" && j.status === "running"), `managed running scout job owned by worker: ${id}`);
			k.ok(jobs.some(j => j.ownerId === owner && j.agentId === id && j.type === "task" && j.status === "completed"), `managed scout job completed: ${id}`);
			const ref = refs.find(r => r.id === id)!;
			const observed = trace.filter((r): r is Frame<"usage"> => r.kind === "usage" && r.source === "task" && r.id === id && r.tokens > 0);
			k.ok(observed.length && observed.every(u => SCOUT_PROVIDERS.includes(u.model.split("/")[0]!) && u.cost && u.cost > 0), `actual priced usage on an approved route: ${id}`);
			const resolved = trace.findLast((r): r is Frame<"progress"> => r.kind === "progress" && r.id === id && !!r.model && !!r.effort);
			const model = resolved?.model?.split(":")[0];
			k.ok(resolved?.effort && observed.some(u => u.model === model), `native resolved model and effort recorded: ${id}`);
			if (wantedModel) k.eq(model, wantedModel, `explicit authorized scout override: ${id}`);
			console.log(`  R11 scout ${id}: ${model ?? "?"}:${resolved?.effort ?? "?"}`);
			const bill = ref.sessionFile ? directBill(jsonl<Entry>(ref.sessionFile)) : { cost: 0, unpriced: 0 };
			k.ok(bill.cost > 0 && !bill.unpriced, `positive direct bill, no unpriced calls, in scout transcript: ${id}`);
			childCost += bill.cost;
		}
		const w = events(trace, owner);
		const taskCalls = w.filter(r => r.event === "tool_execution_start" && r.tool === "task");
		k.eq(taskCalls.length, 1, "one worker-native parallel task call");
		k.ok(parked(trace, owner) && w.some(r => asyncResult(r) && r.text?.includes(FACT_A)) && w.some(r => asyncResult(r) && r.text?.includes(FACT_B)), "parked worker received both actual native async results");
		const b = board(c);
		k.ok(b.some(p => p.agent === "finder" && p.text.includes("facts/alpha.txt:2") && p.text.includes(FACT_A) && p.text.includes("facts/beta.txt:3") && p.text.includes(FACT_B)), "worker posted both independently sourced path:line + nonce facts");
		k.ok(b.every(p => ["coordinator", "finder"].includes(p.agent)), "neither native child became a board participant");
		const m = metrics(c);
		const direct = directBill(entries(c, "finder"));
		const reported = m?.members.finder?.cost;
		k.ok(direct.cost > 0 && !direct.unpriced && reported !== undefined && reported > direct.cost, "positive descendant billing above worker's own direct spend");
		k.ok(near(reported, direct.cost + childCost), `worker direct + each scout direct exactly once: ${direct.cost} + ${childCost}; metrics ${reported}`);
		// The first successful swarm operation creates accounting; its own preceding
		// assistant request runs before the runtime exists and is not a swarm charge.
		const admission = trace.findIndex(r => r.kind === "event" && r.id === "Main" && r.tool === "swarm" &&
			r.event === "tool_execution_end" && !r.isError);
		const mainCost = trace.slice(admission + 1).reduce((sum, r) => sum +
			(r.kind === "usage" && r.id === "Main" && r.source === "session" ? r.cost ?? 0 : 0), 0);
		k.ok(admission >= 0 && mainCost > 0 && near(m?.coordinator?.cost, mainCost),
			`Main received none of the scout charge: observed direct ${mainCost}; metrics ${m?.coordinator?.cost}`);
		k.ok(near(m?.spend.cost, direct.cost + childCost + mainCost), "swarm total includes each direct bill exactly once");
		k.eq(m?.spend.unknown, undefined, "no unknown price on this priced route");
	},
};

const R12_NAMES = ["cancelled", "abandoned"];
const R12: PaidScenario = {
	id: "R12", cap: 1.05, maxSeconds: 390,
	fixture: { "barrier.py": BARRIER },
	prompt: `Add exactly two workers in separate calls: cancelled and abandoned, each ${workerSpec}. Brief for each, substituting its own name: "Start one managed bash async:true, timeout:175, command /usr/bin/python3 barrier.py cancel NAME. Immediately call untimed swarm_wait as the only tool call; do not post meanwhile. If (and only if) the job result actually reaches you, post @coordinator FORBIDDEN-R12-NAME." After both adds, run foreground bash (async:false, timeout:155) command /usr/bin/python3 barrier.py wait both. This harness barrier means both job owners, parks and live child pids were observed. Call swarm{action:'kill',name:'cancelled'} and wait for its result. Then run foreground bash async:false command /usr/bin/python3 barrier.py wait survivor (timeout:155). This confirms the other job remained live after the first kill. Immediately call swarm{action:'finish',abandon:true,summary:'R12 cancellation fence'}. Give a final answer after it returns. Never write or release any fixture latch yourself.`,
	tick(c, trace) {
		const r = roster(c);
		const active = (name: string) => {
			const ids = pids(c, name);
			return runningBash(trace, r[name]?.agent_id) && parked(trace, r[name]?.agent_id) && ids.length === 2 && ids.every(live);
		};
		if (R12_NAMES.every(active)) signal(c, "both", "ready");
		const killed = events(trace, "Main").some(row => row.event === "tool_execution_end" && row.tool === "swarm" && row.text?.includes('"killed":["cancelled"]'));
		if (killed && active("abandoned")) signal(c, "survivor", "ready");
		if (board(c).some(p => p.agent === "coordinator" && p.finish?.abandon && p.text.includes("[abandoned]")))
			for (const name of R12_NAMES) signal(c, name, "release");
	},
	async after(c) {
		// Do the delayed-sentinel challenge even if omp accepted finish and exited between ticks.
		const done = board(c).some(p => p.agent === "coordinator" && p.finish?.abandon);
		if (done) for (const name of R12_NAMES) signal(c, name, "release");
		if (done) await until(() => R12_NAMES.every(name => pids(c, name).length === 2 && !pids(c, name).some(live)), 4000, "both owned job process pairs gone after release");
		if (done) mark(c, "post-release-process-check");
	},
	check(c, k) {
		const trace = evidence(c);
		const r = roster(c);
		k.eq(Object.keys(r).filter(name => name !== "coordinator").sort(), ["abandoned", "cancelled"], "exactly two distinct worker owners");
		const b = board(c);
		const done = b.find(p => p.agent === "coordinator" && p.finish?.abandon && p.text.startsWith("[done]"));
		k.ok(done?.text.includes("[abandoned]") && done.finish?.abandoned.some(a => a.name === "abandoned" && a.was.includes("background work")), "terminal [done] has structured abandonment for the live job owner");
		const both = trace.findIndex(x => x.kind === "harness" && x.action === "ready:both");
		const survivor = trace.findIndex(x => x.kind === "harness" && x.action === "ready:survivor");
		const fence = r.cancelled?.killed_seq;
		k.ok(both >= 0 && survivor > both && r.cancelled?.killed && r.abandoned?.killed === false && fence !== undefined && (!done || fence < done.seq), "one owner killed and the other still live and not permanently killed at abandon");
		for (const name of R12_NAMES) {
			const id = r[name]?.agent_id;
			const release = trace.findIndex(x => x.kind === "harness" && x.action === `release:${name}`);
			const detach = trace.findIndex((x, i) => i > both && x.kind === "ref" && x.id === id && (x.change === "removed" || x.change === "status_changed" && !x.attached));
			k.ok(runningBash(trace.slice(0, both), id) && parked(trace.slice(0, both), id), `${name}: real owned job and armed board wait before cancellation`);
			k.ok(release > survivor && detach > both && detach < release && (!done?.ts || trace[detach]!.at <= done.ts), `${name}: owner fenced/detached by the terminal marker, before harness release`);
			k.ok(trace.some(x => x.kind === "jobs" && x.id === id && x.jobs.some(job => job.status === "cancelled" && job.endTime !== undefined && (!done?.ts || job.endTime <= done.ts))) &&
				!runningBash(trace, id), `${name}: managed owner job settled cancelled by [done] and never ran again`);
			k.ok(pids(c, name).length === 2 && !pids(c, name).some(live), `${name}: both actual process identities are gone`);
			k.ok(!existsSync(file(c, name, "sentinel")), `${name}: no sentinel despite releasing its original latch after both fences`);
			k.ok(!events(trace.slice(detach + 1), id).some(asyncResult), `${name}: no async-result injection after detach`);
		}
		k.ok(done && !b.some(p => (p.agent === "abandoned" && p.seq > done.seq) || (p.agent === "cancelled" && p.seq > (fence ?? -1)) || (R12_NAMES.includes(p.agent) && p.text.includes("FORBIDDEN-R12"))), "no worker posts after its fence/[done], no forbidden completion marker");
		k.ok(trace.some(x => x.kind === "harness" && x.action === "post-release-process-check"), "post-release descendant/sentinel challenge executed");
	},
};

export const NATIVE_PAID = [R9, R10, R11, R12];
