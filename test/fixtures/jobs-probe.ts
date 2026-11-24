import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRegistry, AgentSession, type ExtensionAPI, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { cfgAsyncPrintWake } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { z } from "@oh-my-pi/omptype/zod";

function alive(pid: number): boolean {
	try { return !/[)\]] [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}

export default function jobsProbe(pi: ExtensionAPI): void {
	const registry = AgentRegistry.global();
	let settings: Settings | undefined;
	let complete: ((value: string) => void) | undefined;
	let mainJob: string | undefined;
	const pids = new Map<string, number[]>();
	const childRefs: string[] = [];
	const offRegistry = registry.onChange(({ type, ref }) => {
		if (type === "registered" && ref.parentId === "swarm~worker") childRefs.push(ref.id);
	});
	const observe = (stage: string, details: Record<string, unknown> = {}): void => {
		const override = (settings?.overlayLayers().overrides.async as { printWake?: boolean } | undefined)?.printWake;
		appendFileSync(process.env.SWARM_JOBS_LOG!, `${JSON.stringify({ stage, effective: settings && cfgAsyncPrintWake.get(settings), override, ...details })}\n`);
	};
	pi.on("session_start", () => {
		settings = findScopedSettings();
		const value = process.env.SWARM_JOBS_PRIOR_OVERRIDE;
		if (settings && value !== undefined) cfgAsyncPrintWake.override(settings, value === "true");
		observe("start");
	});
	pi.on("agent_end", event => {
		if (!event.awaitingAsyncWork || !mainJob || !complete) return;
		const id = mainJob;
		const resolve = complete;
		mainJob = undefined;
		complete = undefined;
		const raw = registry.get(MAIN_AGENT_ID)?.session;
		observe("main-paused");
		// Deliberately cross the native print-mode post-prompt boundary. Without
		// the lease the compiled host exits instead of delivering this result.
		setTimeout(() => {
			if (process.env.SWARM_JOBS_CANCEL_MAIN === "1" && raw instanceof AgentSession) raw.cancelAsyncJob(id);
			resolve("MAIN-JOB-RESULT-271");
		}, 350).unref();
	});
	pi.on("message_end", event => {
		const m = event.message;
		if (m.role === "custom" && m.customType === "async-result") observe("main-result");
		if (m.role === "custom" && m.customType === "swarm-gate-reminder") observe("gate-reminder");
	});
	pi.on("session_stop", () => { observe("session-stop"); });
	pi.on("session_shutdown", async () => { offRegistry(); await Promise.resolve(); observe("shutdown"); });
	pi.registerTool({
		name: "jobs_probe", label: "Jobs probe", description: "Record host job and settings evidence in compiled integration tests.",
		parameters: z.object({ action: z.enum(["hold", "release_worker", "await_busy", "release_busy", "running", "native_stop", "one_gone", "both_gone"]) }),
		async execute(_id, { action }, _signal, _onUpdate, ctx) {
			const main = registry.get(MAIN_AGENT_ID)?.session;
			if (!(main instanceof AgentSession) || !main.asyncJobManager) throw new Error("Main has no native manager");
			if (action === "hold") {
				const held = Promise.withResolvers<string>();
				complete = held.resolve;
				mainJob = main.asyncJobManager.register("bash", "probe main job", async () => held.promise, { ownerId: MAIN_AGENT_ID });
				observe("job-held");
			} else if (action === "release_worker") {
				const parkedBash = () => {
					const ref = registry.get("swarm~worker");
					const raw = ref?.session;
					if (ref?.activity !== "waiting on board" || !(raw instanceof AgentSession)) return;
					const manager = raw.asyncJobManager;
					const bash = manager?.getRunningJobs({ ownerId: ref.id }).find(job => job.type === "bash");
					if (bash && raw.wakeSources?.jobs.includes(bash.id)) return { worker: ref, raw, manager, bash };
				};
				const deadline = Date.now() + 8_000;
				let parked = parkedBash();
				while (!parked && Date.now() < deadline) {
					await Bun.sleep(10);
					parked = parkedBash();
				}
				if (!parked) throw new Error("worker did not park with a pending bash job");
				const { worker, raw, manager, bash } = parked;
				observe("worker-parked");
				const evalJob = manager?.getRecentJobs(undefined, { ownerId: worker.id }).find(job => job.type === "eval");
				observe("eval-policy", {
					status: evalJob?.status, output: evalJob?.resultText, childRefs,
					taskJobs: manager?.getAllJobs({ ownerId: worker.id }).filter(job => job.type === "task").map(job => job.id),
				});
				raw.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "async-result") {
						// Native bash only records a nonzero exit code in latestDetails.
						const exitCode = bash.latestDetails?.exitCode ?? (bash.status === "completed" ? 0 : undefined);
						observe("worker-result", { status: bash.status, exitCode, output: bash.resultText });
					}
					if (event.type === "tool_execution_end" && event.toolName === "swarm_wait" && JSON.stringify(event.result).includes('"woke":"job"'))
						observe("worker-woke-job");
				});
				writeFileSync(join(ctx.cwd, "release-job"), "LATCH-RELEASED-WORKER-NONCE-f43d2b");
			} else if (action === "await_busy") {
				const marker = join(ctx.cwd, "mid-turn-busy");
				const deadline = Date.now() + 8_000;
				while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
				const raw = registry.get("swarm~worker")?.session;
				if (!existsSync(marker) || !(raw instanceof AgentSession) || !raw.isStreaming)
					throw new Error("worker never entered its foreground tool");
				observe("busy-tool-running");
				raw.subscribe(event => {
					if (event.type === "agent_start") observe("busy-worker-restarted");
					if (event.type === "agent_end") observe("busy-worker-ended");
					if (event.type === "tool_execution_end" && event.toolName === "bash")
						observe("busy-tool-ended", { isError: event.isError });
					if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "swarm-wake")
						observe("busy-aside-received", { text: event.message.content });
					if (event.type === "tool_execution_end" && event.toolName === "post_message")
						observe("busy-reply-posted", { isError: event.isError });
				});
			} else if (action === "release_busy") {
				observe("busy-tool-released");
				writeFileSync(join(ctx.cwd, "mid-turn-release"), "release");
			} else if (action === "running") {
				const [a, b] = ["alpha", "beta"].map(name => registry.get(`swarm~${name}`)?.session);
				if (!(a instanceof AgentSession) || !(b instanceof AgentSession) || !a.asyncJobManager) throw new Error("workers have no manager");
				const deadline = Date.now() + 8_000;
				for (const name of ["alpha", "beta"]) {
					let pair: number[] = [];
					while (Date.now() < deadline) {
						try { pair = readFileSync(join(ctx.cwd, `${name}.pids`), "utf8").trim().split(" ").map(Number); } catch {}
						if (pair.length === 2 && pair.every(pid => Number.isSafeInteger(pid) && pid > 0 && alive(pid))) break;
						await Bun.sleep(10);
					}
					pids.set(name, pair);
				}
				const owner = a.asyncJobManager;
				const ownJob = owner.getRunningJobs({ ownerId: "swarm~alpha" })[0];
				const foreignJob = owner.getRunningJobs({ ownerId: "swarm~beta" })[0];
				const read = a.getToolByName("read");
				const write = a.getToolByName("write");
				if (!ownJob || !foreignJob || !read || !write) throw new Error("missing native jobs or proc tools");
				const held = Promise.withResolvers<string>();
				const mainOnly = main.asyncJobManager.register("bash", "Main only", () => held.promise, { id: "main-only-job", ownerId: MAIN_AGENT_ID });
				try {
					const readOwn = await read.execute("own", { path: `proc://${ownJob.id}` });
					const checks = await Promise.all([foreignJob.id, mainOnly].map(async id => {
						const denied = async (call: Promise<{ isError?: boolean; content: unknown }>): Promise<boolean> => {
							try {
								const result = await call;
								return /not found/i.test(JSON.stringify(result.content));
							} catch (err) { return /not found/i.test(String(err)); }
						};
						return {
							readDenied: await denied(read.execute(`read-${id}`, { path: `proc://${id}` })),
							killDenied: await denied(write.execute(`kill-${id}`, { path: `proc://${id}/kill`, content: "" })),
						};
					}));
					observe("proc-scope", {
						ownReadable: !readOwn.isError && JSON.stringify(readOwn.content).includes(ownJob.id),
						checks,
						betaUnaffected: owner.getJob(foreignJob.id)?.status === "running",
						mainUnaffected: main.asyncJobManager.getJob(mainOnly)?.status === "running",
					});
				} finally {
					main.cancelAsyncJob(mainOnly);
					held.resolve("cancelled probe");
				}
				observe("running", { scopes: a.asyncJobManager === b.asyncJobManager && a.asyncJobManager !== main.asyncJobManager,
					owners: ["alpha", "beta"].map(name => a.asyncJobManager?.getRunningJobs({ ownerId: `swarm~${name}` }).length),
					alpha: pids.get("alpha")?.map(alive), beta: pids.get("beta")?.map(alive) });
			} else if (action === "native_stop") {
				const ref = registry.get("swarm~alpha");
				if (!ref?.session) throw new Error("alpha is absent");
				await ref.session.abort({ reason: "Interrupted by user" });
				await AgentLifecycleManager.global().release(ref.id, ref, { tombstone: true });
				observe("native-stop", { alphaRef: registry.get(ref.id) !== undefined,
					alpha: pids.get("alpha")?.map(alive), beta: pids.get("beta")?.map(alive) });
			} else {
				observe(action, { alpha: pids.get("alpha")?.map(alive), beta: pids.get("beta")?.map(alive),
					alphaRef: registry.get("swarm~alpha") !== undefined, betaRef: registry.get("swarm~beta") !== undefined });
			}
			return { content: [{ type: "text", text: `JOBS-PROBE-${action}` }], details: {} };
		},
	});
}
