// Resolves the user's installed host `omp` binary, skipping `node_modules/.bin` shims injected
// into PATH by `bun run` (which point at the devDependencies JS CLI, not the compiled host).

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export const REPO = join(import.meta.dir, "..");

function canon(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

export function isLocalNodeModulesBin(dir: string, repoDir = REPO): boolean {
	if (!dir) return false;
	const localBin = join(repoDir, "node_modules", ".bin");
	if (canon(dir) === canon(localBin)) return true;
	const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized.endsWith("/node_modules/.bin") || normalized === "node_modules/.bin";
}

export function stripNodeModulesBins(pathEnv: string | undefined, repoDir = REPO): string {
	if (!pathEnv) return "";
	return pathEnv
		.split(delimiter)
		.filter(dir => dir && !isLocalNodeModulesBin(dir, repoDir))
		.join(delimiter);
}

export function resolveOmpBin(env: Record<string, string | undefined> = process.env, repoDir = REPO): string {
	const explicit = env.OMP_BIN?.trim();
	if (explicit) return explicit;
	const cleanPath = stripNodeModulesBins(env.PATH, repoDir);
	for (const dir of cleanPath.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "omp");
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// continue scanning PATH
		}
	}
	throw new Error("could not find host `omp` binary on PATH (outside node_modules/.bin); set OMP_BIN to override");
}
