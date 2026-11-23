// Loaded only by the compiled-host integration test. No profile files or model credentials.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRef, AgentRegistry, AgentSession, type ExtensionAPI, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import { HistoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { sessionFileBelongsToRoot } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { SessionObserverRegistry, TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentLifecyclePayload } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { z } from "@oh-my-pi/omptype/zod";
import { CoordinatorBinding } from "../../src/runtime/coordinator.ts";
import { createSessionFactory, scopedSettings } from "../../src/runtime/omp-adapter.ts";
import type { CreateWorkerOptions } from "../../src/runtime/ports.ts";

export default function hubProbe(pi: ExtensionAPI): void {
	const registry = AgentRegistry.global();
	const observer = new SessionObserverRegistry();
	observer.subscribeToEventBus(pi.events, pi.events);
	const lensId = "swarm~lens~3";
	const earlyId = "swarm~early";
	const firstCycleId = "swarm~cycle~2";
	const revivedCycleId = "swarm~cycle~3";
	let firstCycleSession: AgentSession | undefined;
	let secondCycleSession: AgentSession | undefined;
	let explicitSession: AgentSession | undefined;
	const explicitOrder: string[] = [];
	const emit = (row: Record<string, unknown>): void => {
		appendFileSync(process.env.SWARM_TEST_HUB_LOG!, `${JSON.stringify(row)}\n`);
	};
	const parked = registry.register({ id: "swarm~lens", kind: "sub", displayName: "native parked", status: "parked", session: null });
	const aborted = registry.register({ id: "SWARM~LENS~2", kind: "sub", displayName: "native aborted", status: "aborted", session: null });
	const cycleBase = registry.register({ id: "swarm~cycle", kind: "sub", displayName: "native cycle base", status: "idle", session: null });
	async function waitFor(ready: () => boolean, signal: AbortSignal | undefined): Promise<void> {
		if (ready()) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const limited = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
		limited.throwIfAborted();
		const changed = observer.onChange(() => { if (ready()) resolve(); });
		const cancelled = (): void => reject(limited.reason);
		limited.addEventListener("abort", cancelled, { once: true });
		try { await promise; } finally { changed(); limited.removeEventListener("abort", cancelled); }
	}
	const off = registry.onChange(({ type, ref }) => {
		if (type !== "registered" || ref.id !== earlyId) return;
		const unattached = !ref.session;
		void AgentLifecycleManager.global().release(ref.id, ref, { tombstone: true }).catch(() => {
			// The session header need not exist yet, but release must still fence it.
		}).finally(() => emit({ stage: "early-release", unattached, registeredAfterRelease: registry.get(ref.id) === ref }));
	});
	pi.on("session_start", async () => {
		if (process.env.SWARM_TEST_RESET_MAIN !== "1") return;
		const main = registry.get(MAIN_AGENT_ID)?.session;
		if (!(main instanceof AgentSession)) throw new Error("test Main session is missing");
		const before = main.sessionManager.getSessionId();
		const providerBefore = main.sessionId;
		const reset = await main.resetSessionContext();
		emit({ stage: "reset", reset: !!reset, sameConversation: main.sessionManager.getSessionId() === before,
			providerRotated: main.sessionId !== providerBefore && main.sessionId !== before });
	});
	pi.on("session_stop", () => {
		const main = registry.get(MAIN_AGENT_ID)?.session;
		const worker = registry.get(lensId);
		emit({ stage: "session-stop", runningWorker: !!worker && registry.isRunning(worker), mainWakeAgents: main instanceof AgentSession ? main.wakeSources?.agents ?? [] : null });
	});
	pi.on("session_shutdown", () => {
		off();
		observer.dispose();
		emit({ stage: "root-shutdown", normalGone: !registry.get("swarm~normal"), parkedUnchanged: registry.get(parked.id) === parked, abortedUnchanged: registry.get(aborted.id) === aborted });
	});

	pi.registerTool({
		name: "hub_probe", label: "Hub probe", description: "Collect native worker registry evidence for integration tests.",
		parameters: z.object({ action: z.enum(["wait", "stop", "collide", "park", "dispose", "unregister", "before_kill", "after_kill", "shutdown"]) }),
		async execute(_id, { action }, signal, _onUpdate, ctx) {
			const lifecycle = AgentLifecycleManager.global();
			const parkedOnBoard = (id: string): boolean => {
				const observed = observer.getSession(id);
				return observed?.status === "active" && observed.progress?.currentToolArgs === "waiting on board";
			};
			if (action === "wait") {
				await waitFor(() => parkedOnBoard(lensId) && parkedOnBoard("swarm~normal") && parkedOnBoard(firstCycleId), signal);
				const ref = registry.get(lensId);
				if (!ref?.session || !ref.sessionFile) throw new Error("native worker ref is missing");
				const main = registry.get(MAIN_AGENT_ID)?.session;
				const history = new HistoryProtocolHandler();
				const rootFile = ctx.sessionManager.getSessionFile();
				emit({
					file: ref.sessionFile, stage: "parked", status: ref.status, activity: ref.activity,
					parentless: ref.parentId === undefined, raw: ref.session instanceof AgentSession,
					ownsFocus: await lifecycle.ensureLive(ref.id) === ref.session,
					contextStatus: observer.getSession(ref.id)?.status,
					mainWakeAgents: main instanceof AgentSession ? main.wakeSources?.agents ?? [] : null,
					inRoot: !!rootFile && sessionFileBelongsToRoot(ref.sessionFile, rootFile),
					history: await history.locate(parseInternalUrl(`history://${ref.id}`), { cwd: ctx.cwd, sessionFile: rootFile }),
				});
			} else if (action === "stop") {
				const ref = registry.get(lensId);
				if (!ref) throw new Error("nothing to stop");
				const stop = lifecycle.release(ref.id, ref, { tombstone: true });
				const synchronousTombstone = ref.status === "aborted" && ref.session === null;
				await stop;
				let cannotRefocus = false;
				try { await lifecycle.ensureLive(ref.id); } catch { cannotRefocus = true; }
				emit({ stage: "stopped", synchronousTombstone, cannotRefocus, noRef: !registry.get(ref.id), observer: observer.getSession(ref.id)?.status });
			} else if (action === "park") {
				const raw = registry.get(firstCycleId)?.session;
				if (!(raw instanceof AgentSession)) throw new Error("cycle worker was not attached");
				firstCycleSession = raw;
				await lifecycle.park(firstCycleId);
				const noRef = !registry.get(firstCycleId);
				if (noRef) registry.register({ id: firstCycleId, kind: "sub", displayName: "native suffix occupant", status: "parked", session: null });
				emit({ stage: "host-park", noRef, disposed: raw.isDisposed });
			} else if (action === "dispose") {
				await waitFor(() => parkedOnBoard(revivedCycleId), signal);
				const raw = registry.get(revivedCycleId)?.session;
				if (!(raw instanceof AgentSession)) throw new Error("cycle worker did not revive at the canonical suffix");
				secondCycleSession = raw;
				const manager = raw.sessionManager;
				const close = manager.close.bind(manager);
				let closeCalls = 0;
				manager.close = async () => {
					if (++closeCalls === 1) throw new Error("injected transcript close failure");
					await close();
				};
				let error = "";
				try { await raw.dispose(); } catch (err) { error = (err as Error).message; }
				emit({ stage: "direct-dispose", error, closeCalls, noRef: !registry.get(revivedCycleId),
					sameConversation: raw.sessionManager.getSessionId() === firstCycleSession?.sessionManager.getSessionId(),
					sameFile: raw.sessionFile === firstCycleSession?.sessionFile,
					baseUnchanged: registry.get(cycleBase.id) === cycleBase });
			} else if (action === "unregister") {
				await waitFor(() => parkedOnBoard(revivedCycleId), signal);
				const ref = registry.get(revivedCycleId);
				const raw = ref?.session;
				if (!ref || !(raw instanceof AgentSession)) throw new Error("cycle worker was not attached");
				const current = observer.getSession(ref.id);
				const before = current?.status;
				const progress = current?.progress;
				const lifecycleFrames: string[] = [];
				const stopCounting = pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
					const frame = data as SubagentLifecyclePayload;
					if (frame.id === ref.id) lifecycleFrames.push(frame.status);
				});
				try {
					const removed = registry.unregister(ref.id, ref);
					await raw.dispose();
					await raw.waitForIdle();
					const observed = observer.getSession(ref.id);
					emit({ stage: "external-unregister", removed, before, noRef: !registry.get(ref.id),
						observer: observed?.status, sameProgress: observed?.progress === progress, lifecycleFrames });
				} finally {
					stopCounting();
				}
			} else if (action === "before_kill") {
				await waitFor(() => parkedOnBoard(revivedCycleId), signal);
				const raw = registry.get(revivedCycleId)?.session;
				if (!(raw instanceof AgentSession) || raw === secondCycleSession) throw new Error("cycle worker did not revive after failed disposal");
				explicitSession = raw;
				const abort = raw.abort.bind(raw);
				const dispose = raw.dispose.bind(raw);
				raw.abort = async options => { await abort(options); explicitOrder.push("abort finished"); };
				raw.dispose = options => { explicitOrder.push("dispose started"); return dispose(options); };
			} else if (action === "after_kill") {
				let cannotRefocus = false;
				try { await lifecycle.ensureLive(revivedCycleId); } catch { cannotRefocus = true; }
				emit({ stage: "explicit-kill", noRef: !registry.get(revivedCycleId), disposed: explicitSession?.isDisposed,
					cannotRefocus, explicitOrder, sameConversation: explicitSession?.sessionManager.getSessionId() === firstCycleSession?.sessionManager.getSessionId() });
			} else if (action === "shutdown") {
				const id = "swarm~normal";
				await waitFor(() => parkedOnBoard(id), signal);
				const ref = registry.get(id);
				if (!ref?.sessionFile || !registry.isRunning(ref)) throw new Error("test worker has no active run");
				emit({ stage: "before-shutdown", file: ref.sessionFile, workerRunning: true });
				// Request the compiled print-mode graceful teardown, not a simulated
				// onHostDispose or the print stop-gate's normal quiescence outcome.
				process.kill(process.pid, "SIGTERM");
			} else {
				const binding = new CoordinatorBinding(pi, ctx, scopedSettings());
				const left = createSessionFactory(binding, pi.events, () => {});
				const right = createSessionFactory(binding, pi.events, () => {});
				const opts: CreateWorkerOptions = {
					name: "race", agentId: "swarm~race", role: "worker", brief: "", signal: new AbortController().signal,
					cwd: ctx.cwd, sessionsDir: join(ctx.cwd, "left"), model: ctx.model, effort: undefined,
					toolNames: [], customTools: [], appendSystemPrompt: "", mode: { kind: "new" }, enableLsp: false,
					onHostKill: () => {}, onHostDispose: () => {}, onHostRelease: () => {},
				};
				const injected = Promise.withResolvers<AgentRef>();
				// Inject after the adapter reserves the slot but before the SDK's
				// null-CAS. A parked corpse would otherwise be reclaimed.
				Object.defineProperty(binding, "ctx", {
					configurable: true,
					get() {
						Reflect.deleteProperty(binding, "ctx");
						injected.resolve(registry.register({ id: opts.agentId, kind: "sub", displayName: "native CAS winner", status: "parked", session: null }));
						return ctx;
					},
				});
				const first = left.create(opts);
				const winner = await Promise.race([injected.promise, first.then(() => { throw new Error("collision was not injected"); })]);
				const [a, b] = await Promise.all([first, right.create({ ...opts, sessionsDir: join(ctx.cwd, "right") })]);
				const distinct = new Set([a.agentId, b.agentId]).size === 2;
				const live = [a, b].every(w => {
					const raw = registry.get(w.agentId)?.session;
					return raw instanceof AgentSession && !!raw.freshSession() &&
						w.sessionId === raw.sessionManager.getSessionId() && w.sessionId !== raw.sessionId;
				});
				const customOutOfRoot = !!ctx.sessionManager.getSessionFile() && !!a.sessionFile
					&& !sessionFileBelongsToRoot(a.sessionFile, ctx.sessionManager.getSessionFile()!);
				await Promise.all([a.dispose(), b.dispose()]);
				emit({ stage: "collide", distinct, live, customOutOfRoot, ids: [a.agentId, b.agentId].sort(), nativeUnchanged: registry.get(winner.id) === winner,
					ownRefsGone: !registry.get(a.agentId) && !registry.get(b.agentId) });
				const saved = { ...opts, name: "rebase", agentId: "swarm~rebase~2" };
				const preferred = await left.create(saved);
				await preferred.dispose();
				const suffixOwner = registry.register({ id: saved.agentId, kind: "sub", displayName: "native suffix owner", status: "idle", session: null });
				const rebased = await left.create(saved);
				await rebased.dispose();
				emit({ stage: "suffix-fallback", preferred: preferred.agentId, fallback: rebased.agentId,
					suffixUnchanged: registry.get(suffixOwner.id) === suffixOwner });
				const faultyId = "swarm~badinit";
				let failedSession: AgentSession | undefined;
				const inject = registry.onChange(({ type, ref }) => {
					if (type !== "status_changed" || ref.id !== faultyId || ref.status !== "idle" || !(ref.session instanceof AgentSession)) return;
					failedSession = ref.session;
					const session = failedSession;
					Object.defineProperty(session, "extensionRunner", {
						configurable: true,
						get() {
							Reflect.deleteProperty(session, "extensionRunner");
							throw new Error("injected initializeExtensions rejection");
						},
					});
				});
				let initError = "";
				const retryOpts = { ...opts, agentId: faultyId, name: "badinit" };
				try {
					const session = await left.create(retryOpts);
					await session.dispose();
				} catch (err) {
					initError = (err as Error).message;
				} finally {
					inject();
				}
				const rolledBack = !registry.get(faultyId) && failedSession?.isDisposed === true;
				const retried = await left.create(retryOpts);
				const sameId = retried.agentId === faultyId;
				await retried.dispose();
				emit({ stage: "init-failure", rolledBack, initError, sameId });
			}
			return { content: [{ type: "text", text: `HUB-PROBE-${action}` }], details: {} };
		},
	});
}
