// SwarmReadModel → the /api/swarm shape the vendored frontend reads (upstream main.mjs
// buildSnapshot), cached per etag. raw.board grows incrementally; a poll never re-serializes the
// whole board.

import { realpathSync, statSync } from "node:fs";
import { ALL, MAIN } from "../../board/channels.ts";
import type { BoardMessage } from "../../board/types.ts";
import { LIMITS } from "../../env.ts";
import { type MemberView, normalizeReelFrames, postedFrames, type ReelFrame, type SwarmReadModel } from "../model.ts";
import { validTargetPath } from "../view-files.ts";

export const URL_HOSTS = ["github.com", "docs.google.com"];
const VIEW_LISTS = ["attention", "workstreams", "milestones", "risks"];
const STUCK_MS = 10 * 60 * 1000;

export interface Snapshot {
	etag: string;
	body: Record<string, unknown>;
	frames: Set<string>;
	allowedFiles: Record<string, string>;
}

function isRoleWorker(m: MemberView | undefined): boolean {
	return !!m && (m.role === "narrator" || m.role === "monitor");
}

/** `file` action targets that are safe to open (path rules, realpath under a root, regular file). */
export function allowedFilesOf(json: Record<string, unknown> | null, roots: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	if (!json) return out;
	let seen = 0;
	for (const list of VIEW_LISTS) {
		const items = json[list];
		if (!Array.isArray(items)) continue;
		for (const item of items) {
			const actions = item && typeof item === "object" ? (item as { actions?: unknown }).actions : undefined;
			if (!Array.isArray(actions)) continue;
			for (const a of actions) {
				const act = a as { type?: unknown; target?: unknown };
				if (act?.type !== "file" || typeof act.target !== "string" || Object.hasOwn(out, act.target)) continue;
				if (++seen > LIMITS.allowedFiles) return out;
				if (!validTargetPath(act.target)) continue;
				try {
					const real = realpathSync(act.target);
					if (roots.some(r => real.startsWith(r)) && statSync(real).isFile()) out[act.target] = `/api/file?path=${encodeURIComponent(act.target)}`;
				} catch {}
			}
		}
	}
	return out;
}

export class SnapshotBuilder {
	readonly #model: SwarmReadModel;
	readonly #roots: readonly string[];
	#cache: Snapshot | undefined;
	#rawBoard = "";
	#rawCount = 0;

	constructor(model: SwarmReadModel, roots: readonly string[]) {
		this.#model = model;
		this.#roots = roots;
	}

	etag(): string {
		const files = this.#model.files();
		return `${this.#model.sid}|coordinator|${this.#model.version}|${files.key}`;
	}

	#raw(messages: readonly BoardMessage[]): string {
		if (messages.length < this.#rawCount) {
			this.#rawBoard = "";
			this.#rawCount = 0;
		}
		for (let i = this.#rawCount; i < messages.length; i++) {
			const m = messages[i] as BoardMessage;
			const rec = { seq: m.seq, agent: m.agent, text: m.text, time: m.time, ...(m.channel ? { channel: m.channel } : {}), ...(m.control ? { control: m.control } : {}) };
			this.#rawBoard += `${JSON.stringify(rec)}\n`;
		}
		this.#rawCount = messages.length;
		return this.#rawBoard;
	}

	build(): Snapshot {
		const etag = this.etag();
		if (this.#cache?.etag === etag) return this.#cache;
		const model = this.#model;
		const files = model.files();
		const members = model.members();
		const byName = new Map(members.map(m => [m.name, m]));
		const names = members.map(m => m.name);
		const messagesIn = model.messages();
		const channels = model.channels();
		const posts = new Map<string, { posts: number; lastPostSeq: number; lastPostTime: string; lastPostTs: number | null }>();
		const edges = new Map<string, { from: string; to: string; count: number; direct: number; viaAll: number }>();
		const messages = messagesIn.map(m => {
			const base = { seq: m.seq, agent: m.agent, text: m.text, time: m.time, ts: m.ts };
			const chan = { ...(m.channel && m.channel !== MAIN ? { channel: m.channel } : {}), ...(m.control ? { control: m.control } : {}) };
			if (m.control) return { ...base, mentions: [] as string[], all: false, ...chan };
			const a = model.addressees(m);
			const viaChannel = a.channels.length
				? names.filter(n => n !== m.agent && !a.mentions.includes(n) && m.ring.mentions.has(n) && !a.all)
				: [];
			const p = posts.get(m.agent) ?? { posts: 0, lastPostSeq: 0, lastPostTime: "", lastPostTs: null };
			posts.set(m.agent, { posts: p.posts + 1, lastPostSeq: m.seq, lastPostTime: m.time, lastPostTs: m.ts });
			if (!isRoleWorker(byName.get(m.agent))) {
				const direct = new Set([...a.mentions, ...viaChannel]);
				const targets = new Set(a.all ? names : a.mentions);
				for (const n of direct) targets.add(n);
				targets.delete(m.agent);
				for (const to of targets) {
					if (isRoleWorker(byName.get(to))) continue;
					const key = `${m.agent}\0${to}`;
					const e = edges.get(key) ?? { from: m.agent, to, count: 0, direct: 0, viaAll: 0 };
					e.count++;
					if (direct.has(to)) e.direct++;
					else e.viaAll++;
					edges.set(key, e);
				}
			}
			const chanMentions = a.channels.length ? { channel_mentions: a.channels, via_channel: viaChannel } : {};
			return { ...base, mentions: a.mentions.filter(n => n !== m.agent), all: a.all, ...chan, ...chanMentions };
		});
		const now = Date.now();
		const outMembers = members.map(m => {
			const p = posts.get(m.name) ?? { posts: 0, lastPostSeq: 0, lastPostTime: "", lastPostTs: null };
			const status = m.killed ? "killed" : m.state === "working" ? "working" : "waiting";
			return {
				name: m.name,
				conversation_id: m.conversationId,
				model: m.model ? `${m.model}${m.effort ? ` · ${m.effort}` : ""}` : "",
				model_id: m.model,
				effort: m.effort,
				role: m.role,
				wake_mode: m.wakeMode,
				status,
				...(m.state === "stopped" ? { stopped: true } : {}),
				wait_since: 0,
				last_read_seq: m.lastReadSeq,
				unread: m.unread,
				last_nudged_seq: 0,
				last_park_blocked_seq: 0,
				killed: m.killed,
				steps: m.steps,
				activity: m.activity,
				activityKind: m.activityKind,
				replied: false,
				narrator: m.role === "narrator",
				roleWorker: isRoleWorker(m),
				failure: m.failure ? { kind: m.failure.kind === "quota" ? "quota" : "error", text: m.failure.text } : null,
				transcriptMtime: m.lastEventAt || 0,
				local: true,
				...p,
				...(channels.length ? { channels: m.channels.map(c => (c === "all" ? ALL : c)) } : {}),
			};
		});
		outMembers.sort((a, b) => (a.role === "coordinator" ? 0 : 1) - (b.role === "coordinator" ? 0 : 1) || a.name.localeCompare(b.name));
		const narrator = members.find(m => m.role === "narrator" && !m.killed) ?? members.find(m => m.role === "narrator");
		const narratorState = !narrator ? "absent" : narrator.killed ? "killed" : narrator.failure ? "paused" : narrator.state === "working" ? "working" : "waiting";
		const viewJson = files.view;
		const viewFrames = normalizeReelFrames((viewJson?.reel as { frames?: unknown } | undefined)?.frames);
		const posted = viewFrames.length ? [] : postedFrames(messagesIn, members, LIMITS.postedFrames);
		const allReel = viewFrames.length ? viewFrames : posted;
		const frames = new Set<string>(
			allReel
				.filter(
					(f): f is ReelFrame & { path: string } =>
						f.kind === "image" && typeof f.path === "string" && validTargetPath(f.path) && /\.(?:png|jpe?g|webp)$/i.test(f.path),
				)
				.map(f => f.path),
		);
		const allowedFiles = allowedFilesOf(viewJson, this.#roots);
		const systemAttention: Record<string, unknown>[] = [];
		for (const m of members) {
			if (m.killed || m.role !== "worker") continue;
			if (m.failure)
				systemAttention.push({
					id: `sys-${m.name}-${m.failure.kind === "quota" ? "quota" : "error"}`,
					kind: m.failure.kind === "quota" ? "quota" : "error",
					member: m.name,
					conversation_id: m.conversationId,
					text: `${m.name}: last step failed (${m.failure.kind === "quota" ? "quota" : "error"})`,
					detail: m.failure.text,
				});
			else if (m.state === "working" && m.lastEventAt && now - m.lastEventAt > STUCK_MS)
				systemAttention.push({ id: `sys-${m.name}-stuck`, kind: "stuck", member: m.name, conversation_id: m.conversationId, text: `${m.name}: no progress, and not waiting on the board`, detail: "", since: m.lastEventAt });
		}
		const body: Record<string, unknown> = {
			conversationId: model.sid,
			swarm: model.sid,
			member: "coordinator",
			id: model.sid,
			title: model.title || "Untitled swarm",
			appData: "",
			dir: model.swarmDir,
			etag,
			head: model.head,
			members: outMembers,
			messages,
			...(channels.length ? { channels } : {}),
			edges: [...edges.values()],
			narrator: narrator
				? { name: narrator.name, conversation_id: narrator.conversationId, state: narratorState, reason: narrator.failure?.kind ?? "", detail: narrator.failure?.text ?? "", last_read_seq: narrator.lastReadSeq, transcriptMtime: narrator.lastEventAt || 0 }
				: null,
			narratorState,
			view: {
				exists: !!files.view || !!files.viewHtml,
				dir: model.swarmDir,
				source: "swarm",
				json: files.view,
				jsonMtime: 0,
				jsonError: files.viewError ?? "",
				html: files.viewHtml,
				htmlKey: files.viewHtml ? files.key : "",
				htmlMtime: 0,
				htmlError: files.htmlError ?? "",
			},
			...(files.plan ? { plan: files.plan } : {}),
			...(posted.length ? { frames: posted } : {}),
			builtinOverview: true,
			graphTab: true,
			rawTab: true,
			allowedFiles,
			urlHosts: URL_HOSTS,
			systemAttention,
			raw: { members: model.rawRoster(), board: this.#raw(messagesIn), view: files.viewRaw },
			...(channels.length ? { unseen: [] } : {}),
		};
		this.#cache = { etag, body, frames, allowedFiles };
		return this.#cache;
	}
}
