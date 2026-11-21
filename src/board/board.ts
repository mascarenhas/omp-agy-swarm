// In-memory board: committed messages, ring sets fixed at the post, member views, pages and the
// three unread questions. PURE: node builtins and sibling board modules only.
//
// Visibility follows channels.ts exactly (memberView semantics) but is computed incrementally:
// `setAt` is channelsAt for one message and `activeFor` is activeAt for one message, both over
// indexes maintained as controls are appended. A test checks the two agree on generated boards.

import {
	type ActiveTest,
	channelMentions,
	controlOf,
	effectiveChannels,
	MAIN,
	mentionsIn,
	mentionsOf,
	seesIn,
} from "./channels.ts";
import type {
	BoardMessage,
	BoardRecord,
	ChannelRecord,
	Control,
	Page,
	PageOptions,
	RingSets,
	Role,
	StoredSet,
	WakeMode,
} from "./types.ts";

/** A member as the board sees it: identity, role and the window during which posts ring it. */
export interface BoardMember {
	name: string;
	role: Role;
	/** Head when the member was reserved: posts with seq <= addedSeq predate it. */
	addedSeq: number;
	/** Head when it was killed (posts after it never ring it), or undefined while alive. */
	killedSeq: number | undefined;
}

export interface MemberDirectory {
	boardMembers(): Iterable<BoardMember>;
}

const EMPTY: ReadonlySet<string> = new Set();
const NO_RING: RingSets = { mentions: EMPTY, sees: EMPTY };

export function boardTime(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function parseBoardTime(t: string | undefined): number | undefined {
	const ms = t ? Date.parse(String(t).replace(" ", "T")) : Number.NaN;
	return Number.isFinite(ms) ? ms : undefined;
}

export function utf8Bytes(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

export class Board {
	readonly messages: BoardMessage[] = [];
	readonly #dir: MemberDirectory;
	/** Current stored set per member (null = role default), from the roster and the controls. */
	readonly #stored = new Map<string, StoredSet>();
	/** Indexes (0-based) of the controls that touch each member, ascending. */
	readonly #touches = new Map<string, number[]>();
	readonly #registry = new Map<string, ChannelRecord>();
	readonly #created = new Map<string, number>();
	readonly #archived = new Map<string, number>();
	/** Seqs of non-control posts per author, ascending (for last-post and post counts). */
	readonly #byAuthor = new Map<string, number[]>();

	constructor(dir: MemberDirectory) {
		this.#dir = dir;
	}

	get head(): number {
		return this.messages.length;
	}

	channels(): readonly ChannelRecord[] {
		return [...this.#registry.values()];
	}

	channel(name: string): ChannelRecord | undefined {
		return this.#registry.get(name);
	}

	/** Seeds a member's stored set (roster value at load, or the initial `channels` of an add). */
	seedStoredSet(name: string, set: StoredSet): void {
		this.#stored.set(name, set ? [...set] : null);
	}

	storedSet(name: string): StoredSet {
		return this.#stored.get(name) ?? null;
	}

	effective(name: string, role: Role): string[] {
		return effectiveChannels(role, this.storedSet(name), name);
	}

	postsBy(name: string): readonly number[] {
		return this.#byAuthor.get(name) ?? [];
	}

	/**
	 * Commits a record that is already durable on disk: assigns it to memory, applies its control
	 * and fixes its ring sets. `seq` must equal head + 1.
	 */
	append(record: BoardRecord): BoardMessage {
		if (record.seq !== this.head + 1) throw new Error(`board seq ${record.seq} does not follow head ${this.head}`);
		const msg: BoardMessage = { ...record, ts: record.ts ?? parseBoardTime(record.time) ?? Date.now(), ring: NO_RING };
		this.messages.push(msg);
		this.#applyControl(msg);
		if (!msg.control) {
			this.#indexAuthor(msg);
			msg.ring = this.#ringAt(msg);
		}
		return msg;
	}

	/** Loads a whole validated log; ring sets are recomputed with each member's set as of each message. */
	load(records: readonly BoardRecord[]): void {
		for (const r of records) {
			const msg: BoardMessage = { ...r, ts: r.ts ?? parseBoardTime(r.time) ?? 0, ring: NO_RING };
			this.messages.push(msg);
			this.#applyControl(msg);
			if (!msg.control) this.#indexAuthor(msg);
		}
		for (const msg of this.messages) if (!msg.control) msg.ring = this.#ringAt(msg);
	}

	#indexAuthor(msg: BoardMessage): void {
		let list = this.#byAuthor.get(msg.agent);
		if (!list) this.#byAuthor.set(msg.agent, (list = []));
		list.push(msg.seq);
	}

	#applyControl(msg: BoardMessage): void {
		const c = controlOf(msg) as Control | null;
		if (!c || typeof c.channel !== "string" || !c.channel) return;
		const index = msg.seq - 1;
		if (c.op === "create") {
			if (!this.#registry.has(c.channel)) {
				this.#registry.set(c.channel, {
					name: c.channel,
					topic: typeof c.topic === "string" ? c.topic : "",
					created_by: msg.agent,
					archived: false,
				});
			}
			this.#created.set(c.channel, msg.seq);
		} else if (c.op === "archive") {
			const e = this.#registry.get(c.channel) ?? { name: c.channel, topic: "", created_by: "", archived: false };
			e.archived = true;
			this.#registry.set(c.channel, e);
			this.#archived.set(c.channel, msg.seq);
		} else if ((c.op === "subscribe" || c.op === "unsubscribe") && Array.isArray(c.members)) {
			for (const name of c.members) {
				let list = this.#touches.get(name);
				if (!list) this.#touches.set(name, (list = []));
				list.push(index);
				const next = c.next && typeof c.next === "object" ? c.next[name] : null;
				this.#stored.set(name, Array.isArray(next) ? [...next] : null);
			}
		}
	}

	/** channelsAt for one message: the stored set member `name` had in force at seq. */
	setAt(name: string, seq: number): StoredSet {
		const list = this.#touches.get(name);
		if (!list || list.length === 0) return this.storedSet(name);
		const index = seq - 1;
		// last touching index <= index
		let lo = 0;
		let hi = list.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if ((list[mid] ?? 0) <= index) {
				found = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		if (found >= 0) {
			const c = this.messages[list[found] ?? 0]?.control;
			const v = c?.next?.[name];
			return Array.isArray(v) ? v : null;
		}
		const first = this.messages[list[0] ?? 0]?.control;
		const v = first?.prev?.[name];
		return Array.isArray(v) ? v : null;
	}

	/** activeAt for one message, from the registry at the head. */
	activeFor(seq: number): ActiveTest {
		if (this.#registry.size === 0) return null;
		return (c: string) => {
			const ch = this.#registry.get(c);
			if (!ch) return false;
			const createdAt = this.#created.get(c);
			if (createdAt !== undefined && seq < createdAt) return false;
			if (ch.archived) {
				const archivedAt = this.#archived.get(c);
				return archivedAt !== undefined && seq < archivedAt;
			}
			return true;
		};
	}

	#ringAt(msg: BoardMessage): RingSets {
		const mentionSet = new Set<string>();
		const seeSet = new Set<string>();
		const active = this.activeFor(msg.seq);
		for (const m of this.#dir.boardMembers()) {
			if (m.name === msg.agent) continue;
			if (msg.seq <= m.addedSeq) continue;
			if (m.killedSeq !== undefined && msg.seq > m.killedSeq) continue;
			const set = effectiveChannels(m.role, this.setAt(m.name, msg.seq), m.name);
			if (mentionsIn(msg.text, m.name, set, active)) mentionSet.add(m.name);
			if (seesIn(m.name, set, msg, active)) seeSet.add(m.name);
		}
		return { mentions: mentionSet, sees: seeSet };
	}

	/** memberView visibility of one message for member `name` with role `role`. */
	visibleTo(name: string, role: Role, msg: BoardMessage): boolean {
		const set = effectiveChannels(role, this.setAt(name, msg.seq), name);
		return seesIn(name, set, msg, this.activeFor(msg.seq));
	}

	/**
	 * A page of posts after `since`, ascending. Own view (channel undefined) follows memberView;
	 * "*" is every post; a name is that channel only. The first matching post is always included
	 * whole; further posts while count < limit and total text bytes <= maxBytes.
	 */
	page(name: string, role: Role, since: number, opts: PageOptions): Page {
		const out: BoardMessage[] = [];
		let bytes = 0;
		let more = false;
		const match = (msg: BoardMessage): boolean => {
			if (opts.channel === undefined) return this.visibleTo(name, role, msg);
			if (opts.channel === "*") return true;
			const ch = typeof msg.channel === "string" && msg.channel ? msg.channel : MAIN;
			return ch === opts.channel;
		};
		for (let i = Math.max(0, since); i < this.messages.length; i++) {
			const msg = this.messages[i];
			if (!msg || !match(msg)) continue;
			const b = utf8Bytes(msg.text);
			if (out.length > 0 && (out.length >= opts.limit || bytes + b > opts.maxBytes)) {
				more = true;
				break;
			}
			out.push(msg);
			bytes += b;
		}
		const last = out[out.length - 1];
		return { since, messages: out, more, next_since: last ? last.seq : since };
	}

	/** Posts after `floor` that ring `name` under `mode` (decided at each post). */
	wakePending(name: string, mode: WakeMode, floor: number): BoardMessage[] {
		const out: BoardMessage[] = [];
		if (mode === "working") return out;
		for (let i = Math.max(0, floor); i < this.messages.length; i++) {
			const msg = this.messages[i];
			if (!msg || msg.control || msg.agent === name) continue;
			const ring = mode === "mentions" ? msg.ring.mentions : msg.ring.sees;
			if (ring.has(name)) out.push(msg);
		}
		return out;
	}

	/** Posts visible to the coordinator after `floor`, not control, not its own ("a result went to nobody"). */
	gateUnread(floor: number): BoardMessage[] {
		const out: BoardMessage[] = [];
		for (let i = Math.max(0, floor); i < this.messages.length; i++) {
			const msg = this.messages[i];
			if (!msg || msg.control || msg.agent === "coordinator") continue;
			if (this.visibleTo("coordinator", "coordinator", msg)) out.push(msg);
		}
		return out;
	}

	/** visibleUnread exactly as upstream: visible, not control, own posts included, seq > lastRead. */
	uiUnread(name: string, role: Role, lastRead: number): number {
		let n = 0;
		for (let i = Math.max(0, lastRead); i < this.messages.length; i++) {
			const msg = this.messages[i];
			if (!msg || msg.control) continue;
			if (this.visibleTo(name, role, msg)) n++;
		}
		return n;
	}

	/** Display helpers for a post: who it names, @all, and the channels it addresses. */
	addressees(msg: BoardMessage, names: readonly string[]): { mentions: string[]; all: boolean; channels: string[] } {
		if (msg.control) return { mentions: [], all: false, channels: [] };
		const { mentions, all } = mentionsOf(msg.text, names);
		const active = this.activeFor(msg.seq);
		const channels = active ? channelMentions(msg.text).filter(c => c !== MAIN && active(c)) : [];
		return { mentions, all, channels };
	}
}
