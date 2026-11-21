// Deterministic random boards for the channels oracle and the incremental-view parity test.

import type { BoardRecord, Role, StoredSet } from "../../src/board/types.ts";

export function rng(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

export interface GenMember {
	name: string;
	role: Role;
	stored: StoredSet;
}

export interface GenBoard {
	members: GenMember[];
	records: BoardRecord[];
}

const WORDS = ["fix", "the", "tests", "now", "please", "done", "[done]", "see", "#3", "ok", "é", "😀", "x_"];

export function genBoard(seed: number, size = 40): GenBoard {
	const r = rng(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
	const channels = ["parser", "ui", "infra"];
	const members: GenMember[] = [
		{ name: "coordinator", role: "coordinator", stored: null },
		{ name: "lexer", role: "worker", stored: r() < 0.5 ? null : ["parser"] },
		{ name: "grp-1", role: "worker", stored: null },
		{ name: "grp-2", role: "worker", stored: r() < 0.5 ? ["ui"] : null },
		{ name: "narrator", role: "narrator", stored: null },
		{ name: "monitor-2", role: "worker", stored: null },
	];
	const names = members.map(m => m.name);
	const records: BoardRecord[] = [];
	const created = new Set<string>();
	// The tools refuse to archive twice or to (un)subscribe on an archived channel; mirror that.
	const archived = new Set<string>();
	const sets = new Map<string, string[] | null>(members.map(m => [m.name, m.stored]));
	for (let seq = 1; seq <= size; seq++) {
		const agent = pick(names);
		const roll = r();
		const ch = pick(channels);
		if (roll < 0.12 && !archived.has(ch)) {
			if (!created.has(ch)) {
				created.add(ch);
				records.push({ seq, agent, text: `created #${ch}`, time: "2026-01-01 00:00:00", control: { op: "create", channel: ch, topic: "t" } });
				continue;
			}
			if (r() < 0.3) {
				archived.add(ch);
				records.push({ seq, agent, text: `archived #${ch}`, time: "2026-01-01 00:00:00", control: { op: "archive", channel: ch } });
				continue;
			}
			const target = pick(names.filter(n => n !== "coordinator"));
			const op = r() < 0.6 ? "subscribe" : "unsubscribe";
			const prev = sets.get(target) ?? null;
			const base = new Set(prev ?? []);
			if (op === "subscribe") base.add(ch);
			else base.delete(ch);
			const next = [...base];
			sets.set(target, next);
			records.push({
				seq,
				agent,
				text: `${op} ${target} #${ch}`,
				time: "2026-01-01 00:00:00",
				control: { op, channel: ch, members: [target], prev: { [target]: prev }, next: { [target]: next } },
			});
			continue;
		}
		const parts: string[] = [];
		const n = 1 + Math.floor(r() * 5);
		for (let i = 0; i < n; i++) {
			const k = r();
			if (k < 0.25) parts.push(`@${pick([...names, "grp", "all", "nobody", "Lexer"])}`);
			else if (k < 0.4) parts.push(`@#${pick([...channels, "main", "nope"])}`);
			else parts.push(pick(WORDS));
		}
		const rec: BoardRecord = { seq, agent, text: parts.join(" "), time: "2026-01-01 00:00:00" };
		if (r() < 0.4) rec.channel = pick(channels);
		records.push(rec);
	}
	return { members, records };
}
