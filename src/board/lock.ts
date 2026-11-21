// Exclusive single-writer lease on a swarm directory (SW-05).
//
// The lock is a lifetime OS-exclusive `flock(LOCK_EX | LOCK_NB)` on `owner.lock`, a stable file
// that is never unlinked or replaced, so its inode never changes. The kernel releases the lock
// when the owning process dies, so a crashed owner needs no stale-lease takeover protocol, and
// two processes racing for one directory can never both win. `owner.json` is metadata only
// (who holds the lock, for messages); it never decides ownership.
//
// If the lock cannot be established at all (no flock on this platform), acquisition fails
// closed: the session has no swarm. PURE: node builtins and bun:ffi only.

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type FlockFn = (fd: number, op: number) => number;
let flockFn: FlockFn | null | undefined;

function loadFlock(): FlockFn | null {
	if (flockFn !== undefined) return flockFn;
	const candidates =
		process.platform === "darwin" ? ["libc.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const lib of candidates) {
		try {
			const handle = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
			const fn = handle.symbols.flock as unknown as FlockFn;
			flockFn = (fd, op) => Number(fn(fd, op));
			return flockFn;
		} catch {}
	}
	flockFn = null;
	return null;
}

export class LeaseError extends Error {}

export interface OwnerInfo {
	session_id: string;
	pid: number;
	host: string;
	acquired_at: string;
}

export interface Lease {
	readonly dir: string;
	readonly fd: number;
	/** What owner.json said when this lease was taken (metadata only). */
	readonly previous: OwnerInfo | null;
	/**
	 * Records this session in owner.json. Called by the store only after it has validated the
	 * directory, so a refused open never touches owner.json.
	 */
	commitOwner(): void;
	release(): void;
}

/** owner.json is a few hundred bytes; anything past 4 KB is not ours and is ignored (bounded read). */
function readOwner(dir: string): OwnerInfo | null {
	let fd: number | undefined;
	try {
		fd = openSync(join(dir, "owner.json"), "r");
		const buf = Buffer.allocUnsafe(4097);
		const n = readSync(fd, buf, 0, buf.length, 0);
		if (n > 4096) return null;
		const v = JSON.parse(buf.subarray(0, n).toString("utf8")) as Partial<OwnerInfo>;
		if (typeof v.session_id === "string" && typeof v.pid === "number") return v as OwnerInfo;
	} catch {
		// absent or unreadable: no owner metadata
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return null;
}

let tmpCounter = 0;

/**
 * Takes the exclusive lease on `dir` for session `sid`. Throws `LeaseError` when another live
 * process holds it or the lock cannot be established. Does not inspect the directory's
 * contents and writes nothing but the lock file; the store validates the directory under the
 * lease and then calls `commitOwner()`.
 */
export function acquireLease(dir: string, sid: string): Lease {
	const flock = loadFlock();
	if (!flock) throw new LeaseError(`cannot take an exclusive lock on ${dir}: flock is unavailable on this platform`);
	let fd: number;
	try {
		fd = openSync(join(dir, "owner.lock"), "a", 0o600);
	} catch (err) {
		throw new LeaseError(`cannot open ${join(dir, "owner.lock")}: ${(err as Error).message}`);
	}
	if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		closeSync(fd);
		const o = readOwner(dir);
		throw new LeaseError(
			o
				? `swarm directory ${dir} is in use by pid ${o.pid} (session ${o.session_id})`
				: `swarm directory ${dir} is in use by another process`,
		);
	}
	const previous = readOwner(dir);
	let released = false;
	return {
		dir,
		fd,
		previous,
		commitOwner() {
			if (released) return;
			const info: OwnerInfo = { session_id: sid, pid: process.pid, host: hostname(), acquired_at: new Date().toISOString() };
			const tmp = join(dir, `owner.json.${process.pid}.${++tmpCounter}.tmp`);
			try {
				writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
				renameSync(tmp, join(dir, "owner.json"));
			} catch {
				// owner.json is metadata only; the flock is the lease.
				try {
					unlinkSync(tmp);
				} catch {}
			}
		},
		release() {
			if (released) return;
			released = true;
			try {
				flock(fd, LOCK_UN);
			} catch {}
			try {
				closeSync(fd);
			} catch {}
		},
	};
}

/** Who `owner.json` says holds the lease (metadata, for messages and tests). */
export function leaseOwner(dir: string): OwnerInfo | null {
	return readOwner(dir);
}
