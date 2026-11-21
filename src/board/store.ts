// Swarm directory, synchronous journal and roster checkpoints (§5.3). PURE: node builtins only.
//
// All writes are synchronous on the JS thread: a post is appended with writeSync before it is
// visible; the roster is written to a unique temp file, fsynced and renamed. Nothing is ever
// appended after a failed write: the journal is truncated back to the committed size, and if
// that cannot be confirmed the board becomes read-only for the rest of the session.

import {
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../env.ts";
import { acquireLease, type Lease, LeaseError } from "./lock.ts";
import type { BoardRecord, RosterFile } from "./types.ts";

export class StorageError extends Error {}
export class CorruptBoardError extends Error {}

export type WriteFn = (fd: number, buf: Uint8Array, offset: number, length: number, position: number) => number;

export interface StoreOptions {
	/** Test seam: replaces writeSync for the journal. */
	write?: WriteFn;
}

export interface LoadResult {
	records: BoardRecord[];
	roster: RosterFile | null;
	/** Human-readable notes about repairs made while loading (torn tail cut, newline restored). */
	repairs: string[];
}

const LEASE_FILES = /^(?:owner\.lock|owner\.json(?:\.\d+\.\d+\.tmp)?)$/;
/** What a crash of this session can leave behind before members.json is first written. */
const OWN_PRE_ROSTER_FILES = /^(?:board\.jsonl(?:\.corrupt-\d+)?|members\.json\.\d+\.\d+\.tmp)$/;

function foreignEntries(dir: string): string[] {
	return readdirSync(dir).filter(n => !LEASE_FILES.test(n));
}

function notOurs(dir: string): LeaseError {
	return new LeaseError(`${dir} is not empty and holds no swarm of this session; use an empty directory`);
}

/** Reads at most `max + 1` bytes of a file; `tooLarge` when it holds more than `max`. */
export function readBounded(path: string, max: number): { buf: Buffer; tooLarge: boolean } {
	const fd = openSync(path, "r");
	try {
		const cap = max + 1;
		const chunks: Buffer[] = [];
		let total = 0;
		while (total < cap) {
			const chunk = Buffer.allocUnsafe(Math.min(1 << 20, cap - total));
			const n = readSync(fd, chunk, 0, chunk.length, null);
			if (n <= 0) break;
			chunks.push(chunk.subarray(0, n));
			total += n;
		}
		const buf = Buffer.concat(chunks, total);
		return total > max ? { buf: buf.subarray(0, max), tooLarge: true } : { buf, tooLarge: false };
	} finally {
		closeSync(fd);
	}
}

export interface SwarmDirChoice {
	dir: string;
	ephemeral: boolean;
}

/** §5.1: OMP_SWARM_DIR, else <artifacts>/swarm for persisted sessions, else a private mkdtemp dir. */
export function resolveSwarmDir(envDir: string | undefined, artifactsDir: string | null | undefined): SwarmDirChoice {
	if (envDir) {
		mkdirSync(envDir, { recursive: true, mode: 0o700 });
		return { dir: realpathSync(envDir), ephemeral: false };
	}
	if (artifactsDir) {
		const dir = join(artifactsDir, "swarm");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return { dir: realpathSync(dir), ephemeral: false };
	}
	const dir = mkdtempSync(join(tmpdir(), "omp-agy-swarm-"));
	return { dir: realpathSync(dir), ephemeral: true };
}

/** Whether a directory holds an existing roster (cheap check used at session_start). */
export function hasRoster(dir: string): boolean {
	return existsSync(join(dir, "members.json"));
}

function parseRoster(text: string): RosterFile {
	const v = JSON.parse(text) as Partial<RosterFile>;
	if (!v || typeof v !== "object" || v.version !== 1 || typeof v.id !== "string" || !v.members || typeof v.members !== "object")
		throw new CorruptBoardError("members.json is not a version 1 roster");
	return {
		version: 1,
		id: v.id,
		title: typeof v.title === "string" ? v.title : "",
		created_at: typeof v.created_at === "string" ? v.created_at : new Date().toISOString(),
		board_head: Number(v.board_head) || 0,
		channels: Array.isArray(v.channels) ? v.channels : [],
		members: v.members,
	};
}

function validRecord(v: unknown, seq: number): v is BoardRecord {
	if (!v || typeof v !== "object") return false;
	const r = v as Partial<BoardRecord>;
	return r.seq === seq && typeof r.agent === "string" && typeof r.text === "string" && typeof r.time === "string";
}

let tmpCounter = 0;

export class SwarmStore {
	readonly dir: string;
	readonly lease: Lease;
	readonly #write: WriteFn;
	#fd = -1;
	#committed = 0;
	#readOnly: string | null = null;
	#closed = false;

	private constructor(dir: string, lease: Lease, opts: StoreOptions) {
		this.dir = dir;
		this.lease = lease;
		this.#write = opts.write ?? ((fd, buf, off, len, pos) => writeSync(fd, buf, off, len, pos));
	}

	/**
	 * Takes the lease on `dir`, checks that the directory is ours, and loads what it holds.
	 * Throws LeaseError (in use / unlockable / foreign) or CorruptBoardError (interior damage);
	 * in both cases owner.json, board.jsonl and members.json are untouched and the lease is
	 * released. owner.json is written only after every check passed.
	 */
	static open(dir: string, sid: string, opts: StoreOptions = {}): { store: SwarmStore; loaded: LoadResult } {
		const rosterPath = join(dir, "members.json");
		// A directory with user files and no swarm is refused before even the lock file is created.
		if (existsSync(dir) && !existsSync(rosterPath) && !existsSync(join(dir, "owner.lock")) && foreignEntries(dir).length > 0) throw notOurs(dir);
		const lease = acquireLease(dir, sid);
		try {
			let roster: RosterFile | null = null;
			if (existsSync(rosterPath)) {
				const { buf, tooLarge } = readBounded(rosterPath, LIMITS.rosterFile);
				if (tooLarge) throw new CorruptBoardError("members.json is too large");
				try {
					roster = parseRoster(buf.toString("utf8"));
				} catch (err) {
					if (err instanceof CorruptBoardError) throw err;
					throw new CorruptBoardError(`members.json does not parse: ${(err as Error).message}`);
				}
				if (roster.id !== sid)
					throw new LeaseError(`${dir} holds the swarm of session ${roster.id}; use an empty directory`);
			} else {
				// No roster: only an empty directory, or what this session's own interrupted first
				// open left (owner.json names it, and nothing but its journal and temp files exist).
				const foreign = foreignEntries(dir);
				const ownLeftovers = lease.previous?.session_id === sid && foreign.every(n => OWN_PRE_ROSTER_FILES.test(n));
				if (foreign.length > 0 && !ownLeftovers) throw notOurs(dir);
			}
			const store = new SwarmStore(dir, lease, opts);
			const loaded = store.#loadJournal(roster);
			lease.commitOwner();
			return { store, loaded };
		} catch (err) {
			lease.release();
			throw err;
		}
	}

	#loadJournal(roster: RosterFile | null): LoadResult {
		const path = join(this.dir, "board.jsonl");
		const repairs: string[] = [];
		const records: BoardRecord[] = [];
		if (existsSync(path)) {
			const { buf, tooLarge } = readBounded(path, LIMITS.journalFile);
			if (tooLarge) throw new CorruptBoardError("board.jsonl is too large to load");
			const text = buf.toString("utf8");
			const lines = text.split("\n");
			const endsWithNewline = text.length === 0 || text.endsWith("\n");
			const tail = lines.pop() ?? "";
			for (let i = 0; i < lines.length; i++) {
				let v: unknown;
				try {
					v = JSON.parse(lines[i] ?? "");
				} catch {
					throw new CorruptBoardError(`board.jsonl line ${i + 1} does not parse`);
				}
				if (!validRecord(v, i + 1)) throw new CorruptBoardError(`board.jsonl line ${i + 1} is not post #${i + 1}`);
				records.push(v);
			}
			let keepBytes = Buffer.byteLength(text, "utf8");
			let needNewline = false;
			if (!endsWithNewline) {
				let v: unknown;
				let ok = false;
				try {
					v = JSON.parse(tail);
					ok = validRecord(v, records.length + 1);
				} catch {}
				if (ok) {
					records.push(v as BoardRecord);
					needNewline = true;
					repairs.push(`restored the missing newline after post #${records.length}`);
				} else {
					const copy = join(this.dir, `board.jsonl.corrupt-${Date.now()}`);
					copyFileSync(path, copy);
					keepBytes -= Buffer.byteLength(tail, "utf8");
					repairs.push(`cut a torn last line (copy in ${copy})`);
				}
			}
			this.#fd = openSync(path, "r+", 0o600);
			if (fstatSync(this.#fd).size !== keepBytes) ftruncateSync(this.#fd, keepBytes);
			this.#committed = keepBytes;
			if (needNewline) this.#writeAt(Buffer.from("\n"));
		} else {
			this.#fd = openSync(path, "wx+", 0o600);
			this.#committed = 0;
		}
		return { records, roster, repairs };
	}

	get readOnly(): string | null {
		return this.#readOnly;
	}

	/** Writes `bytes` at the committed end; advances the committed size only when all landed. */
	#writeAt(bytes: Buffer): void {
		const start = this.#committed;
		let off = 0;
		while (off < bytes.length) {
			const n = this.#write(this.#fd, bytes, off, bytes.length - off, start + off);
			if (!(n > 0)) throw new Error("short write");
			off += n;
		}
		this.#committed = start + bytes.length;
	}

	/** Appends one record durably (page cache) before the caller makes it visible. */
	appendRecord(record: BoardRecord): void {
		if (this.#closed) throw new StorageError("the board is closed");
		if (this.#readOnly) throw new StorageError(`the board is read-only: ${this.#readOnly}`);
		try {
			const size = fstatSync(this.#fd).size;
			if (size !== this.#committed) {
				ftruncateSync(this.#fd, this.#committed);
				if (fstatSync(this.#fd).size !== this.#committed) throw new Error("size mismatch");
			}
		} catch (err) {
			this.#readOnly = `cannot confirm the journal size: ${(err as Error).message}`;
			throw new StorageError(this.#readOnly);
		}
		const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
		const before = this.#committed;
		try {
			this.#writeAt(bytes);
		} catch (err) {
			this.#committed = before;
			try {
				ftruncateSync(this.#fd, before);
			} catch {
				this.#readOnly = "a failed write could not be truncated";
			}
			throw new StorageError((err as Error).message);
		}
	}

	/** fsyncs the journal (structural checkpoints and shutdown). */
	syncJournal(): void {
		if (this.#fd >= 0 && !this.#closed) {
			try {
				fsyncSync(this.#fd);
			} catch {}
		}
	}

	/**
	 * Writes members.json atomically: unique temp file, fsync, rename. A structural checkpoint
	 * fsyncs the journal first, so a published board_head never runs ahead of the durable journal.
	 */
	writeRoster(roster: RosterFile, structural: boolean): void {
		if (this.#closed) return;
		const tmp = join(this.dir, `members.json.${process.pid}.${++tmpCounter}.tmp`);
		const fd = openSync(tmp, "w", 0o600);
		try {
			const bytes = Buffer.from(`${JSON.stringify(roster, null, 1)}\n`, "utf8");
			let off = 0;
			while (off < bytes.length) {
				const n = writeSync(fd, bytes, off, bytes.length - off);
				if (!(n > 0)) throw new StorageError("short write to members.json");
				off += n;
			}
			fsyncSync(fd);
		} catch (err) {
			closeSync(fd);
			try {
				unlinkSync(tmp);
			} catch {}
			throw err;
		}
		closeSync(fd);
		if (structural) this.syncJournal();
		renameSync(tmp, join(this.dir, "members.json"));
	}

	close(): void {
		if (this.#closed) return;
		this.syncJournal();
		this.#closed = true;
		try {
			closeSync(this.#fd);
		} catch {}
		this.lease.release();
	}
}
