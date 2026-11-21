// Typed line-for-line port of Antigravity's swarm_board/channels.mjs (same names, same semantics).
// Mentions and channel visibility; pure functions, no I/O. PURE: no imports.
//
// Shapes are the board's JSON: a message has `channel` ("" or absent = main) and, for a channel
// change, `control` {op, channel, topic, members, prev, next}; a member has `channels`
// (absent/null = its role's default, ["*"] = all).

export const MAIN = "main";
export const ALL = "*";

/** The subset of a board message these functions read. */
export interface ChannelMsg {
	seq?: number;
	agent?: string;
	text?: string;
	channel?: string;
	control?: unknown;
}

export interface ChannelControl {
	op?: unknown;
	channel?: unknown;
	topic?: unknown;
	members?: unknown;
	prev?: unknown;
	next?: unknown;
}

export interface RegistryEntry {
	name: string;
	archived?: boolean;
	topic?: string;
	created_by?: string;
}

export type ActiveTest = ((channel: string) => boolean) | null;

// ---------------------------------------------------------------------------
// Mentions: "@" at a word start, then the name (or "<prefix>" when name is "<prefix>-<digits>"),
// then a non-name rune or end of text.
// ---------------------------------------------------------------------------

const NAME_RUNE = /[\p{L}\p{Nd}_-]/u;

function namedToken(lowerText: string, lowerName: string): boolean {
	if (!lowerName) return false;
	for (let i = lowerText.indexOf("@"); i >= 0; i = lowerText.indexOf("@", i + 1)) {
		if (i > 0) {
			// Spreading the last two code units yields the whole preceding rune even when it is a
			// surrogate pair.
			const before = [...lowerText.slice(Math.max(0, i - 2), i)].pop() ?? "";
			if (NAME_RUNE.test(before)) continue;
		}
		if (!lowerText.startsWith(lowerName, i + 1)) continue;
		const j = i + 1 + lowerName.length;
		if (j >= lowerText.length) return true;
		if (!NAME_RUNE.test(String.fromCodePoint(lowerText.codePointAt(j) ?? 0))) return true;
	}
	return false;
}

function named(lowerText: string, lowerName: string): boolean {
	if (namedToken(lowerText, lowerName)) return true;
	const m = lowerName.match(/^(.+)-\d+$/);
	return m?.[1] ? namedToken(lowerText, m[1]) : false;
}

/** {mentions: the names text calls on by name or copy prefix, all: @all}. */
export function mentionsOf(text: unknown, names: readonly string[]): { mentions: string[]; all: boolean } {
	const lower = String(text || "").toLowerCase();
	return {
		mentions: names.filter(n => named(lower, String(n).toLowerCase())),
		all: named(lower, "all"),
	};
}

/** board.Mentions: whether text calls on name (by name, copy prefix or @all). */
export function mentions(text: unknown, name: unknown): boolean {
	const lower = String(text || "").toLowerCase();
	return named(lower, String(name || "").toLowerCase()) || named(lower, "all");
}

// ---------------------------------------------------------------------------
// Channels.
// ---------------------------------------------------------------------------

/** A message's channel; "" and absent are main. */
export const channelOf = (m: ChannelMsg | null | undefined): string =>
	typeof m?.channel === "string" && m.channel ? m.channel : MAIN;

/** A message's channel change, or null for an ordinary post. */
export const controlOf = (m: ChannelMsg | null | undefined): ChannelControl | null =>
	m?.control && typeof m.control === "object" && !Array.isArray(m.control) ? (m.control as ChannelControl) : null;

// board.DefaultChannels / EffectiveChannels: a stored set, or (null) its role's default:
// coordinator, narrator and monitor see every channel, everyone else only main. A "worker"
// (or roleless) member named narrator, monitor or <that>-<N> counts as that role.
const ALL_BY_ROLE: Readonly<Record<string, true>> = { coordinator: true, narrator: true, monitor: true };
const ROLE_WORKER_NAME = /^(?:narrator|monitor)(?:-\d+)?$/;
export function effectiveChannels(role: string | null | undefined, set: unknown, name: unknown): string[] {
	if (Array.isArray(set)) return set as string[];
	if (role && Object.hasOwn(ALL_BY_ROLE, role)) return [ALL];
	if ((!role || role === "worker") && ROLE_WORKER_NAME.test(String(name ?? ""))) return [ALL];
	return [];
}

// board's touches: a (un)subscribe whose members include name.
function touches(m: ChannelMsg, name: string): boolean {
	const c = controlOf(m);
	return (
		!!c && (c.op === "subscribe" || c.op === "unsubscribe") && Array.isArray(c.members) && c.members.includes(name)
	);
}

// A prev/next entry: an array, or null for the role default.
const storedSet = (map: unknown, name: string): string[] | null => {
	const v = map && typeof map === "object" ? (map as Record<string, unknown>)[name] : null;
	return Array.isArray(v) ? (v as string[]) : null;
};

/**
 * board.ChannelsAt: member name's stored set (null = role default) in force at each of msgs
 * (contiguous, ascending, ending at the head); current is its set now. Before msgs it is the
 * prev of the first control touching name, else current; each touching control (in effect at
 * its own message) sets it to its next. Returns an array aligned with msgs.
 */
export function channelsAt(name: string, current: unknown, msgs: readonly ChannelMsg[]): (string[] | null)[] {
	let set: string[] | null = Array.isArray(current) ? (current as string[]) : null;
	const first = msgs.find(m => touches(m, name));
	if (first) set = storedSet(controlOf(first)?.prev, name);
	return msgs.map(m => {
		if (touches(m, name)) set = storedSet(controlOf(m)?.next, name);
		return set;
	});
}

// ---------------------------------------------------------------------------
// "@#channel": "@#parser" calls on every member whose set as of the message holds #parser or
// "*", if #parser exists and is not archived as of the message; "@#main" calls on nobody.
// ---------------------------------------------------------------------------

const CHANNEL_NAME = /^[a-z][a-z0-9-]{0,23}$/;
const RESERVED: Readonly<Record<string, true>> = { main: true, all: true, here: true };

/** board.ChannelMentions: the channels text addresses with "@#name", first appearance order, lowercased, "main" included. */
export function channelMentions(text: unknown): string[] {
	const lower = String(text || "").toLowerCase();
	const out: string[] = [];
	for (let i = lower.indexOf("@#"); i >= 0; i = lower.indexOf("@#", i + 1)) {
		if (i > 0 && NAME_RUNE.test([...lower.slice(Math.max(0, i - 2), i)].pop() ?? "")) continue;
		let j = i + 2;
		while (j < lower.length) {
			const r = String.fromCodePoint(lower.codePointAt(j) ?? 0);
			if (!NAME_RUNE.test(r)) break;
			j += r.length;
		}
		const name = lower.slice(i + 2, j);
		if ((name === MAIN || (CHANNEL_NAME.test(name) && !Object.hasOwn(RESERVED, name))) && !out.includes(name))
			out.push(name);
	}
	return out;
}

/**
 * board.MentionsIn: whether text calls on name, whose effective set as of the message is set: a
 * mention (@name, prefix, @all), or "@#c" for a channel c in set (or set holds "*") that active(c)
 * reports active. A null active addresses no channel.
 */
export function mentionsIn(text: unknown, name: string, set: readonly string[], active: ActiveTest): boolean {
	if (mentions(text, name)) return true;
	if (!active) return false;
	const all = set.includes(ALL);
	return channelMentions(text).some(c => c !== MAIN && (all || set.includes(c)) && active(c));
}

/**
 * board.ActiveAt: for each of msgs (ascending, ending at the head), the active test as of that
 * message, from the registry at the head ([{name, archived}]) and the create/archive controls in
 * msgs: a channel counts from its create on, an archived one only before its archive. Null
 * entries when there is no registry.
 */
export function activeAt(registry: unknown, msgs: readonly ChannelMsg[]): ActiveTest[] {
	const reg = new Map((Array.isArray(registry) ? (registry as RegistryEntry[]) : []).map(c => [c.name, c]));
	if (!reg.size) return msgs.map(() => null);
	const created = new Map<string, number>();
	const archived = new Map<string, number>();
	for (const m of msgs) {
		const c = controlOf(m);
		if (c?.op === "create") created.set(String(c.channel), Number(m.seq) || 0);
		if (c?.op === "archive") archived.set(String(c.channel), Number(m.seq) || 0);
	}
	return msgs.map(m => {
		const seq = Number(m.seq) || 0;
		return (c: string) => {
			const ch = reg.get(c);
			if (!ch) return false;
			const createdAt = created.get(c);
			if (createdAt !== undefined && seq < createdAt) return false;
			if (ch.archived) {
				const archivedAt = archived.get(c);
				return archivedAt !== undefined && seq < archivedAt;
			}
			return true;
		};
	});
}

/**
 * board.SeesIn: whether member name, with effective set `set` in force at msg, sees it: main, a
 * channel the set holds (or "*"), its own post, or a post that calls on it.
 */
export function seesIn(name: string, set: readonly string[], msg: ChannelMsg, active: ActiveTest): boolean {
	const ch = channelOf(msg);
	if (ch === MAIN || msg?.agent === name) return true;
	if (set.includes(ALL) || set.includes(ch)) return true;
	return mentionsIn(msg?.text, name, set, active);
}

/** board.View.Unread: whether a visible message counts as unread. Control messages never do. */
export const countsUnread = (msg: ChannelMsg): boolean => !controlOf(msg);

/**
 * What member name (role, current stored set) sees of msgs: {visible, unread} as two arrays of
 * booleans aligned with msgs. registry is the channel registry at the head.
 */
export function memberView(
	name: string,
	role: string | null | undefined,
	current: unknown,
	msgs: readonly ChannelMsg[],
	registry: unknown,
): { visible: boolean[]; unread: boolean[] } {
	const sets = channelsAt(name, current, msgs);
	const active = activeAt(registry, msgs);
	const visible = msgs.map((m, i) => seesIn(name, effectiveChannels(role, sets[i], name), m, active[i] ?? null));
	return { visible, unread: msgs.map((m, i) => !!visible[i] && countsUnread(m)) };
}

/** The channel registry rebuilt from the log's control messages, in creation order. */
export function channelRegistry(
	msgs: readonly ChannelMsg[],
): { name: string; topic: string; created_by: string; archived: boolean }[] {
	const byName = new Map<string, { name: string; topic: string; created_by: string; archived: boolean }>();
	for (const m of msgs) {
		const c = controlOf(m);
		if (!c || typeof c.channel !== "string" || !c.channel) continue;
		if (c.op === "create" && !byName.has(c.channel)) {
			byName.set(c.channel, {
				name: c.channel,
				topic: typeof c.topic === "string" ? c.topic : "",
				created_by: String(m.agent ?? ""),
				archived: false,
			});
		} else if (c.op === "archive") {
			const e = byName.get(c.channel) || { name: c.channel, topic: "", created_by: "", archived: false };
			e.archived = true;
			byName.set(c.channel, e);
		}
	}
	return [...byName.values()];
}

/** A member's current stored set: the next of the last control in msgs that touches it, else `stored`. */
export function currentChannels(name: string, stored: unknown, msgs: readonly ChannelMsg[]): string[] | null {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m && touches(m, name)) return storedSet(controlOf(m)?.next, name);
	}
	return Array.isArray(stored) ? (stored as string[]) : null;
}

/** How many of msgs after lastRead member name sees and counts as unread. */
export function visibleUnread(
	name: string,
	role: string | null | undefined,
	current: unknown,
	msgs: readonly ChannelMsg[],
	lastRead: number,
	registry: unknown,
): number {
	const { unread } = memberView(name, role, current, msgs, registry);
	let n = 0;
	for (let i = 0; i < msgs.length; i++) {
		if (unread[i] && (Number(msgs[i]?.seq) || 0) > lastRead) n++;
	}
	return n;
}
