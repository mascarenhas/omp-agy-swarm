// Store and lease: commit-before-visible, failed writes, roster checkpoints, load validation,
// recovery, and the exclusive OS lock (two simultaneous stale takeovers, one winner).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, LeaseError, leaseOwner } from "../../src/board/lock.ts";
import { CorruptBoardError, resolveSwarmDir, SwarmStore } from "../../src/board/store.ts";
import { SwarmRuntime } from "../../src/runtime/runtime.ts";
import { FakeBinding, Harness, REPO } from "../helpers/harness.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "swarm-store-"));
	dirs.push(d);
	return d;
}
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SID = "01a1fc2e-701b-741a-8abd-a6061302517d";

describe("journal", () => {
	test("a post is durable before it is visible; a failed write commits nothing and leaves no gap", async () => {
		h = new Harness();
		const rt = h.rt;
		const heads: number[] = [];
		let fail = false;
		const real = rt.store;
		// Re-open with a write seam: record the head at write time; fail on demand.
		await rt.shutdown();
		h.deps.storeOptions = {
			write: (fd, buf, off, len, pos) => {
				heads.push(h?.rt.board.head ?? -1);
				if (fail) throw new Error("ENOSPC: no space left on device");
				return writeSync(fd, buf, off, len, pos);
			},
		};
		void real;
		const rt2 = h.reopen();
		const a = await h.post("one");
		expect(a.details.seq).toBe(1);
		expect(heads.at(-1)).toBe(0);
		fail = true;
		const b = await h.post("two");
		expect(b.isError).toBe(true);
		expect(String(b.details.error)).toContain("nothing was posted");
		expect(rt2.board.head).toBe(1);
		expect(rt2.coordinator.notices.some(n => n.kind === "storage")).toBe(true);
		fail = false;
		const c = await h.post("three");
		expect(c.details.seq).toBe(2);
		const lines = readFileSync(join(h.dir, "board.jsonl"), "utf8").trim().split("\n");
		expect(lines.map(l => JSON.parse(l).seq)).toEqual([1, 2]);
		expect(JSON.parse(lines[1] as string).text).toBe("three");
	});

	test("roster checkpoints use a unique temp file and rename; reload equals memory", async () => {
		h = new Harness();
		await h.post("hello");
		await h.swarm({ action: "title", title: "the title" });
		expect(readdirSync(h.dir).filter(n => n.includes(".tmp"))).toEqual([]);
		const roster = JSON.parse(readFileSync(join(h.dir, "members.json"), "utf8"));
		expect(roster.id).toBe(SID);
		expect(roster.title).toBe("the title");
		const before = h.rt.board.messages.map(m => [m.seq, m.text]);
		await h.rt.shutdown();
		const rt = h.reopen();
		expect(rt.board.messages.map(m => [m.seq, m.text])).toEqual(before);
		expect(rt.title).toBe("the title");
	});

	test("interior damage refuses to attach and modifies nothing; cursors beyond the head are clamped", async () => {
		const dir = tmp();
		const good = (seq: number) => JSON.stringify({ seq, agent: "coordinator", text: `p${seq}`, time: "2026-01-01 00:00:00" });
		writeFileSync(join(dir, "board.jsonl"), `${good(1)}\nnot json\n${good(3)}\n`);
		writeFileSync(join(dir, "members.json"), JSON.stringify({ version: 1, id: SID, title: "", created_at: "", board_head: 3, channels: [], members: {} }));
		const before = readFileSync(join(dir, "board.jsonl"), "utf8");
		expect(() => SwarmStore.open(dir, SID)).toThrow(CorruptBoardError);
		expect(readFileSync(join(dir, "board.jsonl"), "utf8")).toBe(before);
		const dir2 = tmp();
		writeFileSync(join(dir2, "board.jsonl"), `${good(1)}\n`);
		writeFileSync(
			join(dir2, "members.json"),
			JSON.stringify({ version: 1, id: SID, title: "", created_at: "", board_head: 1, channels: [], members: { coordinator: { role: "coordinator", last_read_seq: 9 } } }),
		);
		const binding = new FakeBinding(SID, "print", dir2);
		const helper = new Harness();
		const deps = helper.deps;
		await helper.close();
		const rt = SwarmRuntime.open(binding, { ...deps, env: { ...deps.env, dir: dir2 } }, dir2, false);
		expect(rt.coordinator.lastReadSeq).toBe(1);
		expect(rt.recovered).toBe(true);
		await rt.shutdown();
	});

	test("a foreign roster id and a nonempty unowned directory fail closed", () => {
		const dir = tmp();
		writeFileSync(join(dir, "members.json"), JSON.stringify({ version: 1, id: "someone-else", title: "", created_at: "", board_head: 0, channels: [], members: {} }));
		expect(() => SwarmStore.open(dir, SID)).toThrow(/holds the swarm of session someone-else/);
		// A refused open never records the refused caller as the owner.
		expect(existsSync(join(dir, "owner.json"))).toBe(false);
		const dir2 = tmp();
		writeFileSync(join(dir2, "notes.txt"), "user file");
		expect(() => SwarmStore.open(dir2, SID)).toThrow(/not empty and holds no swarm/);
		// The lease was released on refusal: an unrelated session can take an empty dir.
		const dir3 = tmp();
		const { store } = SwarmStore.open(dir3, SID);
		expect(leaseOwner(dir3)?.session_id).toBe(SID);
		store.close();
	});

	test("a nonempty unowned directory is refused on every attempt and is never written (H1)", () => {
		for (const withLock of [false, true]) {
			const dir = tmp();
			writeFileSync(join(dir, "notes.txt"), "user file");
			// With a lock file present the check runs under the lease instead of before it.
			if (withLock) writeFileSync(join(dir, "owner.lock"), "");
			expect(() => SwarmStore.open(dir, SID)).toThrow(LeaseError);
			expect(() => SwarmStore.open(dir, SID)).toThrow(LeaseError);
			expect(existsSync(join(dir, "owner.json"))).toBe(false);
			expect(existsSync(join(dir, "board.jsonl"))).toBe(false);
			expect(existsSync(join(dir, "members.json"))).toBe(false);
			expect(existsSync(join(dir, "owner.lock"))).toBe(withLock);
		}
	});

	test("this session's own interrupted first open (journal, no roster) is resumed; another session's is not", () => {
		const dir = tmp();
		const first = SwarmStore.open(dir, SID);
		first.store.close();
		expect(existsSync(join(dir, "board.jsonl"))).toBe(true);
		expect(existsSync(join(dir, "members.json"))).toBe(false);
		expect(() => SwarmStore.open(dir, "other-session")).toThrow(/not empty and holds no swarm/);
		expect(leaseOwner(dir)?.session_id).toBe(SID);
		const again = SwarmStore.open(dir, SID);
		again.store.close();
	});

	test("ephemeral swarm dirs are private (0700)", () => {
		const choice = resolveSwarmDir(undefined, null);
		dirs.push(choice.dir);
		expect(choice.ephemeral).toBe(true);
		expect(statSync(choice.dir).mode & 0o777).toBe(0o700);
	});
});

describe("lease", () => {
	test("a second holder is refused while the first lives; release frees it; owner.json only on commit", () => {
		const dir = tmp();
		const a = acquireLease(dir, SID);
		expect(existsSync(join(dir, "owner.json"))).toBe(false);
		a.commitOwner();
		expect(() => acquireLease(dir, "other")).toThrow(/in use by pid/);
		a.release();
		const b = acquireLease(dir, "other");
		expect(b.previous?.session_id).toBe(SID);
		b.release();
		expect(leaseOwner(dir)?.session_id).toBe(SID);
	});

	test("two simultaneous stale takeovers: exactly one winner", async () => {
		const dir = tmp();
		mkdirSync(dir, { recursive: true });
		// A stale owner.json naming a dead process (metadata only; the flock decides).
		writeFileSync(join(dir, "owner.json"), JSON.stringify({ session_id: SID, pid: 999_999, host: "x", acquired_at: "" }));
		const child = join(REPO, "test", "helpers", "lock-child.ts");
		const spawn = () => Bun.spawn(["bun", child, dir, SID], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOLD_MS: "800" } });
		for (let round = 0; round < 5; round++) {
			const ps = [spawn(), spawn(), spawn()];
			const outs = await Promise.all(ps.map(p => new Response(p.stdout).text()));
			await Promise.all(ps.map(p => p.exited));
			const won = outs.filter(o => o.startsWith("won")).length;
			expect([round, won]).toEqual([round, 1]);
			expect(outs.filter(o => o.startsWith("lost")).every(o => o.includes("in use"))).toBe(true);
		}
	});
});
