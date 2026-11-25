import { appendFileSync, existsSync } from "node:fs";
import { AgentRegistry, AgentSession, type AgentRef, type ExtensionAPI, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import { progressMetrics } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/agent-hub-projection";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { SessionObserverRegistry, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL, type SubagentLifecyclePayload } from "@oh-my-pi/pi-coding-agent/task/session-observer-registry";
import { cfgTaskAgentModelOverrides, cfgTaskEnableEffort, cfgTaskMaxConcurrency, cfgTaskWorkerThreads } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TASK_SUBAGENT_EVENT_CHANNEL, type SubagentEventPayload } from "@oh-my-pi/pi-coding-agent/task/types";
import { z } from "@oh-my-pi/omptype/zod";
import { isRemoteScoutSession } from "../../src/runtime/omp-adapter.ts";

const spendDetails = z.object({ spend: z.object({ cost: z.number(), tokens: z.number(), unknown: z.string().optional() }) });

export default function scoutProbe(pi: ExtensionAPI): void {
	const registry = AgentRegistry.global();
	const observer = new SessionObserverRegistry();
	observer.subscribeToEventBus(pi.events, pi.events);
	// Wide batches must wait for actual registry/stream readiness, including a
	// worker thread boot. Leave time for that even on a busy single CPU.
	const fanoutWaitMs = 35_000;
	const log = (stage: string, fields: Record<string, unknown> = {}): void => {
		appendFileSync(process.env.SWARM_SCOUT_LOG!, `${JSON.stringify({ stage, ...fields })}\n`);
	};
	const childIds = new Set<string>();
	const mainScouts = new Set<string>();
	let chainResult = "";
	const threadJobs = new Map<string, Set<string>>();
	const consumedThreads = new Set<string>();
	const consumed = Promise.withResolvers<void>();
	let stopWatchingResults: (() => void) | undefined;
	let lastWorker: AgentSession | undefined;
	const offStart = pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, value => {
		const frame = value as SubagentLifecyclePayload;
		if (frame.status !== "started" || frame.agent !== "scout") return;
		const ref = registry.get(frame.id);
		if (ref?.parentId === MAIN_AGENT_ID) mainScouts.add(ref.id);
		if (ref?.id === "swarm~worker.Chain" && ref.session instanceof AgentSession) {
			ref.session.subscribe(event => {
				if (event.type === "tool_execution_end" && event.toolName === "eval")
					chainResult = JSON.stringify(event.result);
			});
		}
		// The executor has the same journal-before-start ordering for auto-prewalk.
		if (process.env.SWARM_SCOUT_EARLY_BILL === "1" && ref?.parentId === "swarm~worker" && ref.session instanceof AgentSession) {
			const manager = ref.session.sessionManager;
			const usage = { input: 5, output: 2, totalTokens: 7, cacheRead: 0, cacheWrite: 0,
				cost: { input: 0.000005, output: 0.000004, cacheRead: 0, cacheWrite: 0, total: 0.000009 } };
			if (manager.appendModelUsage({ purpose: "prewalk-auto", api: "openai-completions", provider: "mock",
				model: "worker-b", usage, stopReason: "stop" }, { sessionId: manager.getSessionId(), parentId: manager.getLeafId() }))
				log("early-bill", { id: ref.id, price: usage.cost.total, tokens: usage.totalTokens });
		}
	});
	const offRegistry = registry.onChange(({ type, ref }) => {
		if (!ref.parentId || !registry.get(ref.parentId)?.id.startsWith("swarm~")) return;
		if (type === "registered") childIds.add(ref.id);
		if (type === "registered" || type === "status_changed") log(type, { id: ref.id, parentId: ref.parentId, status: ref.status });
	});
	// Republish the native request in its original identity, plus a new frame.
	// Swarm spend must not include either duplicate or the cumulative UI frames.
	const duplicates = new WeakSet<object>();
	const offRaw = pi.events.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
		const { id, event } = data as SubagentEventPayload;
		if ((!childIds.has(id) && !mainScouts.has(id)) || event.type !== "message_end" || event.message.role !== "assistant" || duplicates.has(event.message)) return;
		duplicates.add(event.message);
		log(mainScouts.has(id) ? "main-scout-bill" : "scout-bill", { id, price: event.message.usage.cost.total, tokens: event.message.usage.totalTokens });
		pi.events.emit(TASK_SUBAGENT_EVENT_CHANNEL, { id, event });
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopWatchingResults?.();
		offStart(); offRegistry(); offRaw(); observer.dispose();
		if (ctx.agent.kind !== "main") return;
		if (lastWorker) log("shutdown", { refs: [...childIds].filter(id => registry.get(id)), disposed: lastWorker.isDisposed });
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (ctx.agent.kind === "main" && message.role === "custom" && message.customType === "session-stop-continuation"
			&& typeof message.content === "string" && message.content.includes("The swarm still has outstanding work: worker is waiting on background work."))
			log("remote-stop-blocked");
	});
	pi.on("session_stop", (_event, ctx) => {
		if (ctx.agent.kind === "main" && threadJobs.has(MAIN_AGENT_ID))
			log("remote-main-receipts", { received: consumedThreads.size });
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.agent.kind !== "main" || event.toolName !== "swarm") return;
		const result = event.result;
		if (!result || typeof result !== "object" || !("details" in result)) return;
		const parsed = spendDetails.safeParse(result.details);
		if (parsed.success && parsed.data.spend.unknown?.includes("mock-remote/worker-b")) log("remote-status", parsed.data.spend);
	});

	async function injectRemoteUsage(parentId: string): Promise<void> {
		const count = parentId === MAIN_AGENT_ID ? 10 : 9;
		const deadline = Date.now() + fanoutWaitMs;
		for (;;) {
			const refs = registry.list().filter(ref => ref.parentId === parentId && ref.session);
			const remote = refs.find(ref => isRemoteScoutSession(ref.session) && ref.session.isStreaming
				&& observer.getSession(ref.id)?.status === "active");
			const session = remote?.session;
			if (refs.length === count && remote && isRemoteScoutSession(session)) {
				const parent = registry.get(parentId)?.session;
				const main = registry.get(MAIN_AGENT_ID)?.session;
				if (!(parent instanceof AgentSession) || !(main instanceof AgentSession)) throw new Error(`remote fanout parent ${parentId} missing`);
				const status = main.getToolByName("swarm");
				if (!status) throw new Error("swarm status is unavailable");
				const before = await status.execute("remote-bill-baseline", { action: "status" });
				const beforeDirect = parent.sessionManager.getUsageStatistics();
				const manager = session.sessionManager;
				const owner = { sessionId: manager.getSessionId(), parentId: null };
				const usage = { input: 5, output: 2, totalTokens: 7, cacheRead: 0, cacheWrite: 0 };
				for (const [purpose, price] of [["probe-priced-remote", 0.1], ["probe-unpriced-remote", 0]] as const) {
					manager.appendModelUsage({ purpose, api: "openai-completions", provider: "mock-remote",
						model: "worker-b", usage: { ...usage, cost: { input: price, output: 0, cacheRead: 0, cacheWrite: 0, total: price } },
						stopReason: "stop" }, owner);
					await manager.flush();
				}
				const ids = new Set(refs.map(ref => ref.id));
				threadJobs.set(parentId, ids);
				stopWatchingResults = parent.subscribe(event => {
					if (event.type !== "message_end" || event.message.role !== "custom" || event.message.customType !== "async-result") return;
					const content = JSON.stringify(event.message.content);
					for (const id of ids) if (content.includes(`<task-result id=\\"${id}\\"`)) consumedThreads.add(id);
					if (consumedThreads.size === ids.size) consumed.resolve();
				});
				const entries = manager.getEntries();
				const matched = entries.filter(entry => entry.type === "model_usage" && entry.purpose.startsWith("probe-"));
				// Mirror rewrites may carry already seen entries again.
				session.applyEntries({ kind: "replace", entries });
				// Compare live deltas while the scouts are still held; Main's
				// setup and teardown requests are outside the billing window.
				const after = await status.execute("remote-bill-check", { action: "status" });
				const first = spendDetails.parse(before.details).spend;
				const last = spendDetails.parse(after.details).spend;
				const afterDirect = parent.sessionManager.getUsageStatistics();
				const chargedCost = last.cost - first.cost - (afterDirect.cost - beforeDirect.cost);
				const chargedTokens = last.tokens - first.tokens - (afterDirect.totalTokens - beforeDirect.totalTokens);
				log("remote-billed", { parentId, id: remote.id, home: session.home, populated: matched.length,
					local: refs.filter(ref => ref.session instanceof AgentSession).length, live: session.isStreaming, chargedCost, chargedTokens });
				return;
			}
			if (Date.now() >= deadline) throw new Error(`remote scout absent from ${refs.length} child refs for ${parentId}`);
			await Bun.sleep(10);
		}
	}

	pi.registerTool({
		name: "scouts_probe", label: "Scouts probe", description: "Observe real native scout state and accounting in the compiled host.",
		parameters: z.object({ action: z.enum(["held", "one", "settled", "settings", "inject", "retired", "park", "burn", "denied", "user-stop",
			"revive-child", "cold-child", "remote-worker", "remote-main", "remote-drain", "chain-placement", "chain-result", "main-bill-start"]) }),
		async execute(_id, { action }, signal) {
			const worker = registry.get("swarm~worker");
			const raw = worker?.session;
			if (action === "retired") {
				log("retired", { remainingRefs: [...childIds].filter(id => registry.get(id)) });
			} else if (action === "user-stop") {
				process.kill(process.pid, "SIGTERM");
			} else if (action === "main-bill-start") {
				const main = registry.get(MAIN_AGENT_ID)?.session;
				if (!(main instanceof AgentSession)) throw new Error("Main not attached");
				await main.settleInFlightMessagePersistence();
				const status = main.getToolByName("swarm");
				if (!status) throw new Error("swarm status unavailable");
				const result = await status.execute("scoped-billing-baseline", { action: "status" });
				const spend = spendDetails.parse(result.details).spend;
				const stats = main.sessionManager.getUsageStatistics();
				log("main-untracked", { cost: stats.cost - spend.cost, tokens: stats.totalTokens - spend.tokens });
			} else if (action === "remote-worker" || action === "remote-main") {
				await injectRemoteUsage(action === "remote-main" ? MAIN_AGENT_ID : "swarm~worker");
			} else if (action === "remote-drain") {
				const parentId = threadJobs.has(MAIN_AGENT_ID) ? MAIN_AGENT_ID : "swarm~worker";
				const parent = registry.get(parentId)?.session;
				const ids = threadJobs.get(parentId);
				if (!(parent instanceof AgentSession) || !ids) throw new Error(`remote fanout parent ${parentId} missing`);
				const jobs = parent.asyncJobManager?.getAllJobs({ ownerId: parentId }).filter(job => job.type === "task" && job.agentId && ids.has(job.agentId)) ?? [];
				if (jobs.length !== ids.size) throw new Error(`expected ${ids.size} scout jobs for ${parentId}, found ${jobs.length}`);
				// Release after job completion, and after delivery for the worker.
				// Main cannot consume queued results while this tool is running.
				const lifecycle = AgentLifecycleManager.global();
				const ready = Promise.withResolvers<void>();
				const timer = setTimeout(() => ready.reject(new Error(`${parentId} scout jobs did not drain`)), fanoutWaitMs);
				try {
					await Promise.race([ready.promise, (async () => {
						await Promise.all(jobs.map(job => job.promise));
						if (parentId !== MAIN_AGENT_ID) {
							await consumed.promise;
							await parent.waitForIdle();
						}
						await Promise.all([...ids].map(async id => {
							const ref = registry.get(id);
							if (ref) await lifecycle.release(id, ref);
						}));
					})()]);
				} finally {
					clearTimeout(timer);
				}
				log("remote-drained", {
					parentId, received: consumedThreads.size,
					completed: jobs.filter(job => job.status === "completed").length,
					remaining: [...ids].filter(id => registry.get(id)),
				});
			} else if (action === "chain-placement") {
				const main = registry.get(MAIN_AGENT_ID)?.session;
				if (!(main instanceof AgentSession) || !(raw instanceof AgentSession)) throw new Error("test parents not attached");
				const deadline = Date.now() + fanoutWaitMs;
				for (;;) {
					const live = registry.list().filter(ref => ref.parentId === worker?.id && ref.session?.isStreaming
						&& observer.getSession(ref.id)?.status === "active");
					if (live.length === 9) {
						log("chain-placed", { local: live.filter(ref => ref.session instanceof AgentSession).length,
							mainThreads: cfgTaskWorkerThreads.get(main.settings), workerThreads: cfgTaskWorkerThreads.get(raw.settings),
							maxConcurrency: cfgTaskMaxConcurrency.get(raw.settings) });
						break;
					}
					if (Date.now() >= deadline) throw new Error(`only ${live.length} scouts active`);
					await Bun.sleep(10);
				}
			} else if (action === "chain-result") {
				const deadline = Date.now() + fanoutWaitMs;
				while (!chainResult) {
					if (Date.now() >= deadline) throw new Error("scout eval did not finish its chain");
					await Bun.sleep(10);
				}
				log("chain-result", { result: chainResult });
			} else if (action === "cold-child") {
				const scout = registry.get("swarm~worker.Cold");
				const parkedScout = registry.get("swarm~worker.Parked");
				if (!worker || !(raw instanceof AgentSession) || !(scout?.session instanceof AgentSession) || !parkedScout)
					throw new Error("test scouts not attached");
				await Promise.all(raw.asyncJobManager?.getAllJobs({ ownerId: worker.id }).filter(job => job.type === "task").map(job => job.promise) ?? []);
				const lifecycle = AgentLifecycleManager.global();
				const transcript = scout.sessionFile;
				await lifecycle.release(scout.id, scout, { tombstone: true });
				await lifecycle.park(parkedScout.id);
				// Simulate a warm reviver lost with its home while keeping the
				// same parked ref, so native ensureLive attempts a cold rebuild.
				lifecycle.adopt(parkedScout.id, { idleTtlMs: 0 }, parkedScout);
				const manager = raw.sessionManager;
				const usage = { input: 5, output: 2, totalTokens: 7, cacheRead: 0, cacheWrite: 0,
					cost: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 } };
				manager.appendModelUsage({ purpose: "cold-probe-cap", api: "openai-completions", provider: "mock",
					model: "worker-a", usage, stopReason: "stop" }, { sessionId: manager.getSessionId(), parentId: manager.getLeafId() });
				let refusal: string | undefined;
				try {
					const live = await lifecycle.ensureLive(scout.id);
					await live.prompt("COLD-SCOUT-AFTER-CAP");
				} catch (error) {
					refusal = String(error);
				}
				let parkedRefusal: string | undefined;
				try {
					const live = await lifecycle.ensureLive(parkedScout.id);
					await live.prompt("PARKED-SCOUT-AFTER-CAP");
				} catch (error) {
					parkedRefusal = String(error);
				}
				log("cold-child", { refusal, parkedRefusal, transcript: transcript && existsSync(transcript),
					removed: !registry.get(scout.id), parkedRemoved: !registry.get(parkedScout.id) });
			} else if (action === "park") {
				if (!worker || !(raw instanceof AgentSession)) throw new Error("test worker not live");
				await AgentLifecycleManager.global().park(worker.id);
				log("park", { disposed: raw.isDisposed, missing: !registry.get(worker.id) });
			} else if (action === "revive-child") {
				if (!(raw instanceof AgentSession)) throw new Error("test worker not attached");
				const id = "swarm~worker.Warm";
				const ref = registry.get(id);
				const original = ref?.session;
				if (!(original instanceof AgentSession)) throw new Error("native scout missing before operator park");
				const sid = original.sessionManager.getSessionId();
				const lifecycle = AgentLifecycleManager.global();
				await lifecycle.park(id);
				const parked = original.isDisposed && ref?.status === "parked" && ref.session === null;
				const revived = await lifecycle.ensureLive(id);
				if (!(revived instanceof AgentSession)) throw new Error("native scout missing after operator revive");
				// Focused scout turns can deliver a native result back to the
				// worker after the scout itself has stopped streaming.
				const result = Promise.withResolvers<void>();
				const timer = setTimeout(() => result.reject(new Error("revived scout result did not reach worker")), 8_000);
				const off = raw.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "async-result"
						&& JSON.stringify(event.message.content).includes("WARM-SCOUT-REVIVED")) result.resolve();
				});
				try {
					await Promise.all([
						revived.prompt("SCOUT-WARM-SECOND").then(() => revived.waitForIdle()),
						result.promise,
					]);
					await raw.waitForIdle();
				} finally {
					clearTimeout(timer);
					off();
				}
				log("revived-child", {
					parked, freshSession: revived !== original, sameRef: registry.get(id) === ref,
					sameTranscript: revived.sessionManager.getSessionId() === sid,
				});
			} else {
				if (!worker || !(raw instanceof AgentSession)) throw new Error("test worker not live");
				lastWorker = raw;
				if (action === "held" || action === "one") {
					const count = action === "held" ? 3 : 1;
					const deadline = Date.now() + (action === "held" ? fanoutWaitMs : 8_000);
					const jobs = () => raw.asyncJobManager?.getAllJobs({ ownerId: worker.id }).filter(job => job.type === "task") ?? [];
					while (raw.isStreaming || !raw.isRunActive || !raw.wakeSources?.jobs.length || jobs().length !== count
						|| childIds.size !== Math.min(count, 2)
						|| (action === "one" && !existsSync(process.env.SWARM_SCOUT_REQUEST_MARK!))) {
						signal?.throwIfAborted();
						if (Date.now() >= deadline) throw new Error(`worker did not pause with ${count} scouts registered or queued`);
						await Bun.sleep(10);
					}
					raw.subscribe(event => {
						if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "async-result")
							log("worker-result", { content: event.message.content });
					});
					log("held", { workerId: worker.id, jobs: jobs().map(j => ({ ownerId: j.ownerId, status: j.status, queued: j.queued === true })), children: [...childIds] });
				} else if (action === "burn") {
					const manager = raw.sessionManager;
					const usage = { input: 5, output: 2, totalTokens: 7, cacheRead: 0, cacheWrite: 0,
						cost: { input: 0.006, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
					manager.appendModelUsage({ purpose: "test-spend", api: "openai-completions", provider: "mock",
						model: "worker-a", usage, stopReason: "stop" }, { sessionId: manager.getSessionId(), parentId: manager.getLeafId() });
					log("burn", { running: raw.isRunActive });
				} else if (action === "denied") {
					const task = raw.getToolByName("task");
					const result = await task?.execute("denied-after-cap", { context: "Cap check",
						tasks: [{ name: "denied", agent: "scout", task: "CAP-REFUSED-SCOUT", solutionSpace: "Do not start" }] });
					const evaluation = await raw.getToolByName("eval")?.execute("denied-eval-after-cap", {
						language: "js", title: "Test stateless invocation under a cap",
						code: `try { const attempt = await completion("CAP-REFUSED-EVAL", { model: "smol" }); await attempt.wait(); } catch (error) { console.log(String(error)); }`,
					});
					log("denied", {
						message: result?.content?.[0]?.type === "text" ? result.content[0].text : undefined,
						eval: evaluation?.content?.[0]?.type === "text" ? evaluation.content[0].text : undefined,
					});
				} else if (action === "settled") {
					await raw.waitForIdle();
					const direct = raw.sessionManager.getUsageStatistics();
					const childMetrics = [...childIds].map(id => {
						const ref = registry.get(id);
						const observed = observer.getSession(id);
						return { id, parentId: ref?.parentId, model: observed?.progress?.resolvedModel, status: observed?.status, metrics: progressMetrics(observed) };
					});
					const requests = raw.sessionManager.getEntriesView().flatMap(entry => {
						if (entry.type === "model_usage") return [{ purpose: entry.purpose, cost: entry.usage.cost.total, tokens: entry.usage.totalTokens }];
						if (entry.type === "message" && entry.message.role === "assistant")
							return [{ purpose: "assistant", cost: entry.message.usage.cost.total, tokens: entry.message.usage.totalTokens }];
						return [];
					});
					const main = registry.get(MAIN_AGENT_ID)?.session;
					log("settled", { childMetrics, directCost: direct.cost - direct.subagentCost, requests,
						mainTaskEffort: main instanceof AgentSession ? cfgTaskEnableEffort.get(main.settings) : undefined,
						workerTaskEffort: cfgTaskEnableEffort.get(raw.settings),
						jobs: raw.asyncJobManager?.getAllJobs({ ownerId: worker.id }).filter(j => j.type === "task").map(j => j.status) });
				} else if (action === "settings") {
					const roles = ["worker", "fresh", "narrator", "monitor"].map(name => {
						const s = registry.get(`swarm~${name}`)?.session;
						return s instanceof AgentSession ? { name, tools: s.getActiveToolNames(), models: cfgTaskAgentModelOverrides.get(s.settings) } : { name };
					});
					log("settings", { roles });
				} else {
					const refs: AgentRef[] = [];
					const add = (id: string, parentId?: string, createdAt?: number): AgentRef => {
						const ref = registry.register({ id, parentId, createdAt, kind: "sub", displayName: "not an ownership key", status: "running", session: null });
						refs.push(ref);
						return ref;
					};
					const frame = (id: string, totalTokens: number, total: number, timestamp = Date.now()) => ({ id, event: {
						type: "message_end", message: { role: "assistant", provider: "mock", model: "synthetic", timestamp, usage: { totalTokens, cost: { total } } },
					} });
					try {
						const child = add("probe-parent", worker.id);
						const nested = add("another-name", child.id);
						const otherRoot = add("unrelated-root");
						const confusing = add(`${worker.id}.looksOwned`, otherRoot.id);
						const priced = frame(nested.id, 12, 0.002);
						pi.events.emit(TASK_SUBAGENT_EVENT_CHANNEL, priced);
						pi.events.emit(TASK_SUBAGENT_EVENT_CHANNEL, { ...priced });
						pi.events.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, { progress: { id: nested.id, cost: 0.002, tokens: 12, requests: 1 } });
						pi.events.emit(TASK_SUBAGENT_EVENT_CHANNEL, frame(confusing.id, 2, 5));
						pi.events.emit(TASK_SUBAGENT_EVENT_CHANNEL, frame(worker.id, 3, 5)); // the worker is not its own child
						registry.unregister(nested.id, nested);
						const replacement = add(nested.id, child.id, Date.now() + 100);
						// Distinct message from the old generation: dedup by JS
						// object alone cannot stop it from reaching the new owner.
						pi.events.emit(TASK_SUBAGENT_EVENT_CHANNEL, frame(nested.id, 99, 5, replacement.createdAt - 1));
						registry.unregister(child.id, child);
						add(child.id, worker.id);
						pi.events.emit(TASK_SUBAGENT_EVENT_CHANNEL, frame(child.id, 11, 0.003));
						pi.events.emit(TASK_SUBAGENT_EVENT_CHANNEL, frame(child.id, 4, 0)); // a prior positive request must not mask missing pricing
						log("injected", { workerId: worker.id });
					} finally {
						for (const ref of refs) registry.unregister(ref.id, ref);
					}
				}
			}
			return { content: [{ type: "text", text: `SCOUTS-PROBE-${action}` }], details: {} };
		},
	});
}
