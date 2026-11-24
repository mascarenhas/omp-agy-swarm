// SwarmReadModel over a live SwarmRuntime: cheap, synchronous projections for the TUI and web
// board. A UI refresh never calls a provider and never moves an agent cursor.

import { basename, join } from "node:path";
import type { BoardMessage } from "../board/types.ts";
import type { AttentionItem, MemberView, SwarmReadModel, TranscriptSource, ViewFiles } from "../ui/model.ts";
import { FileTranscript, LiveTranscript } from "../ui/transcript.ts";
import { ViewFilesReader } from "../ui/view-files.ts";
import { wakePendingFor } from "./delivery.ts";
import { completionLabel } from "./gate.ts";
import type { Member } from "./member.ts";
import type { SwarmRuntime } from "./runtime.ts";

export class RuntimeReadModel implements SwarmReadModel {
	readonly rt: SwarmRuntime;
	readonly #files: ViewFilesReader;
	readonly #fileTranscripts = new Map<string, FileTranscript>();
	readonly #liveTranscripts = new WeakMap<NonNullable<Member["session"]>, LiveTranscript>();
	#coordinatorTranscript: LiveTranscript | undefined;
	#membersKey = -1;
	#members: MemberView[] = [];

	constructor(rt: SwarmRuntime) {
		this.rt = rt;
		this.#files = new ViewFilesReader(rt.dir);
	}

	get version(): number {
		return this.rt.version;
	}
	get sid(): string {
		return this.rt.sid;
	}
	get title(): string {
		return this.rt.title;
	}
	get mode(): "interactive" | "headless" {
		return this.rt.binding.headless ? "headless" : "interactive";
	}
	get head(): number {
		return this.rt.board.head;
	}
	get swarmDir(): string {
		return this.rt.dir;
	}

	messages(): readonly BoardMessage[] {
		return this.rt.board.messages;
	}

	#view(m: Member): MemberView {
		const rt = this.rt;
		const posts = rt.board.postsBy(m.name);
		const last = posts[posts.length - 1];
		return {
			name: m.name,
			role: m.role,
			state: m.state,
			detail: m.detail,
			model: m.model,
			effort: m.effort,
			addedBy: m.addedBy,
			channels: rt.channelsView(m),
			defaultChannel: rt.defaultChannel(m),
			workspace: {
				mode: m.workspace.mode,
				path: m.workspace.path,
				branch: m.workspace.branch,
				state: m.workspace.state,
				reason: m.workspace.retained_reason,
				cleanup: m.workspace.cleanup,
			},
			wakeMode: m.phase === "parked" ? m.wakeMode : m.role === "narrator" ? "anything" : "mentions",
			lastReadSeq: m.lastReadSeq,
			unread: rt.board.uiUnread(m.name, m.role, m.lastReadSeq, m.addressedRead),
			owed: m.killed || m.role === "coordinator" ? [] : wakePendingFor(rt, m).map(p => p.seq),
			posts: posts.length,
			lastPostSeq: last,
			lastPostTs: last !== undefined ? rt.board.messages[last - 1]?.ts : undefined,
			steps: m.stats.steps,
			activity: m.tracker.activity,
			activityKind: m.tracker.activityKind,
			failure: m.failure ? { kind: m.failure.kind, text: m.failure.text } : undefined,
			tokens: m.stats.tokens,
			cost: m.stats.cost,
			killed: m.killed,
			conversationId: m.conversationId,
			sessionFile: m.sessionFile ?? undefined,
			liveAgentId: m.role !== "coordinator" && !m.killed && m.phase !== "stopped" && m.phase !== "killed" ? m.session?.agentId : undefined,
			briefSeq: m.briefSeq,
			task: m.task,
			lastEventAt: m.tracker.lastEventAt,
		};
	}

	members(): readonly MemberView[] {
		if (this.#membersKey !== this.rt.version) {
			this.#members = [...this.rt.members.values()].map(m => this.#view(m));
			this.#membersKey = this.rt.version;
		}
		return this.#members;
	}

	channels() {
		return this.rt.board.channels();
	}

	attention(): readonly AttentionItem[] {
		return this.rt.attention();
	}

	completion(absoluteTime?: { hour12?: boolean }): string {
		return completionLabel(this.rt, absoluteTime);
	}

	outcome(): { value: string; reason: string } | null {
		return this.rt.outcome ? { value: this.rt.outcome.value, reason: this.rt.outcome.reason } : null;
	}

	spend() {
		return this.rt.spendView();
	}

	files(): ViewFiles {
		return this.#files.read();
	}

	transcript(name: string): TranscriptSource | undefined {
		const m = this.rt.members.get(name);
		if (!m) return undefined;
		if (m.role === "coordinator") {
			// rt.epoch moves on session_clear: outstanding coordinator cursors expire.
			return this.#coordinatorTranscript ??= new LiveTranscript(this.rt.sid, () => this.rt.binding.branchEntries(), () => this.rt.epoch);
		}
		const session = m.session;
		if (session && !m.killed && m.phase !== "stopped" && m.phase !== "killed") {
			let src = this.#liveTranscripts.get(session);
			if (!src) {
				src = new LiveTranscript(session.sessionId, () => session.branchEntries());
				this.#liveTranscripts.set(session, src);
			}
			return src;
		}
		if (!m.sessionFile) return undefined;
		const path = join(this.rt.dir, "sessions", basename(m.sessionFile));
		let src = this.#fileTranscripts.get(path);
		if (!src) {
			src = new FileTranscript(path);
			this.#fileTranscripts.set(path, src);
		}
		return src;
	}

	onChange(cb: () => void): () => void {
		return this.rt.onChange(cb);
	}

	restored(): { stopped: number; owed: number } | null {
		const stopped = [...this.rt.members.values()].filter(m => m.phase === "stopped");
		if (!stopped.length) return null;
		return { stopped: stopped.length, owed: stopped.filter(m => wakePendingFor(this.rt, m).length > 0).length };
	}

	stalled(): boolean {
		return this.rt.stall.interactiveStalled && this.rt.coordinator.phase === "parked";
	}

	coordinatorCursor(): number {
		return this.rt.coordinator.lastReadSeq;
	}

	rawRoster(): string {
		return this.rt.rosterText;
	}

	addressees(msg: BoardMessage): { mentions: string[]; all: boolean; channels: string[] } {
		return this.rt.board.addressees(msg, [...this.rt.members.keys()].filter(n => n !== msg.agent));
	}
}
