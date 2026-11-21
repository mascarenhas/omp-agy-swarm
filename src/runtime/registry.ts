// Process-global map: coordinator session id → SwarmRuntime (one runtime per sid, §3.1).

import { join } from "node:path";
import { CorruptBoardError, hasRoster, resolveSwarmDir } from "../board/store.ts";
import { LeaseError } from "../board/lock.ts";
import type { CoordinatorPort } from "./ports.ts";
import { type RuntimeDeps, SwarmRuntime } from "./runtime.ts";

export class SwarmRegistry {
	readonly #runtimes = new Map<string, SwarmRuntime>();
	/** Why a session's swarm could not attach (lease held elsewhere, corrupt board). */
	readonly #refusals = new Map<string, string>();
	readonly #createdListeners = new Set<(rt: SwarmRuntime) => void>();

	get(sid: string): SwarmRuntime | undefined {
		return this.#runtimes.get(sid);
	}

	/** Every live runtime (session switch and shutdown stop the ones that are not current). */
	all(): SwarmRuntime[] {
		return [...this.#runtimes.values()];
	}

	refusal(sid: string): string | undefined {
		return this.#refusals.get(sid);
	}

	onCreated(cb: (rt: SwarmRuntime) => void): () => void {
		this.#createdListeners.add(cb);
		return () => this.#createdListeners.delete(cb);
	}

	#open(binding: CoordinatorPort, deps: RuntimeDeps, dir: string, ephemeral: boolean): SwarmRuntime | { error: string } {
		try {
			const rt = SwarmRuntime.open(binding, deps, dir, ephemeral);
			this.#runtimes.set(binding.sessionId, rt);
			this.#refusals.delete(binding.sessionId);
			if (ephemeral) deps.log(`omp-agy-swarm: swarm directory ${dir}`);
			for (const cb of this.#createdListeners) cb(rt);
			return rt;
		} catch (err) {
			const msg = err instanceof LeaseError || err instanceof CorruptBoardError ? err.message : `cannot open the swarm: ${(err as Error).message}`;
			this.#refusals.set(binding.sessionId, msg);
			return { error: msg };
		}
	}

	/** At session_start: attach only when the session's swarm directory already holds a roster. */
	attach(binding: CoordinatorPort, deps: RuntimeDeps): SwarmRuntime | undefined {
		const sid = binding.sessionId;
		const existing = this.#runtimes.get(sid);
		if (existing) {
			existing.rebind(binding);
			return existing;
		}
		const envDir = deps.env.dir;
		const artifacts = binding.artifactsDir();
		const candidate = envDir ?? (artifacts ? join(artifacts, "swarm") : undefined);
		if (!candidate || !hasRoster(candidate)) return undefined;
		const r = this.#open(binding, deps, resolveSwarmDir(envDir, artifacts).dir, false);
		return "error" in r ? undefined : r;
	}

	/** Lazily creates the session's swarm (first add, title, channel create). */
	ensure(binding: CoordinatorPort, deps: RuntimeDeps): SwarmRuntime | { error: string } {
		const existing = this.#runtimes.get(binding.sessionId);
		if (existing) return existing;
		let choice: { dir: string; ephemeral: boolean };
		try {
			choice = resolveSwarmDir(deps.env.dir, binding.artifactsDir());
		} catch (err) {
			return { error: `cannot create the swarm directory: ${(err as Error).message}` };
		}
		return this.#open(binding, deps, choice.dir, choice.ephemeral);
	}

	async drop(sid: string): Promise<void> {
		const rt = this.#runtimes.get(sid);
		if (!rt) return;
		this.#runtimes.delete(sid);
		await rt.shutdown();
	}
}

export const registry = new SwarmRegistry();
