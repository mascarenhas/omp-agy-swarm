// Worker contract, role block, first message and every runtime-authored text (§8.6, §6.5, §7).
// PURE: node builtins and board types only.

import type { BoardMessage, WorkspaceRecord } from "../board/types.ts";

export interface ContractInput {
	name: string;
	addedBy: string;
	workspace: WorkspaceRecord;
	cwd: string;
	baseDesc: string;
	swarmDir: string;
	backgroundJobs?: boolean;
}

export function workspaceParagraph(ws: WorkspaceRecord, cwd: string, baseDesc: string): string {
	if (ws.mode === "inherit")
		return `You share the working copy at \`${cwd}\` with other members; touch only the files you own.`;
	return (
		`You work in your own git worktree at \`${ws.path}\` on branch \`${ws.branch ?? ""}\`, started from ${baseDesc}. ` +
		"Ignored files (dependencies, build output) were not copied. Commit your work on that branch before you post " +
		"`[done]` and name the branch and commit in the post. Do not push and do not switch branches."
	);
}

export function workerContract(c: ContractInput): string {
	const by = c.addedBy || "coordinator";
	return `<swarm_worker>
You are \`${c.name}\`, a member of a swarm coordinated by \`coordinator\`. \`${by}\` added you. You are a full agent in
your own conversation. The other members see only what you post on the shared message board.

Board tools
- post_message{text, channel?}: post to the board. Begin with the @name of whoever must act on it (@${by},
  a peer, a numbered group's prefix, or @#channel for a whole channel). @all wakes everyone: use it only for a rule
  or interface everyone needs. A post that names nobody may be read by nobody.
- read_board{since?, limit?, channel?}: read posts after your read cursor (or after \`since\`).
- swarm_wait{mentions_only?, timeout_seconds?}: sleep until a post names you (mentions_only:false: any post you can
  see; timeout_seconds: at the latest then). It returns the new posts${c.backgroundJobs ? `, or woke:"job" if omp has background work ready to deliver next` : ""}. Call it on its own:
  it must be the only tool call of its response.
- swarm{action}: "status"; "add" a helper for your own piece (it reports to you and you stay responsible); "kill",
  "revive" or "model" a helper you added; "model" with no name to change your own model or effort.

How you work
1. Your brief is your first message and is also on the board. It is everything you own. Do that piece; never edit
   files another member owns.
2. Report on the board, not in your reply: nobody reads your reply text. When the piece is finished, post once:
   the @name your brief tells you to report to (default @${by}), then \`[done]\`, then what changed, where, and
   the evidence (test output, diff summary). If you are blocked or need a decision, post \`@${by} [blocked] …\`
   saying exactly what you need.
3. Refer to earlier posts by number (#12). Never copy or summarize another member's post into yours.
4. A mention is a doorbell that costs the named member a turn. Mention only who must act next. No thanks, no
   acknowledgements, no status nobody asked for.
5. For ordinary standby after posting, end your turn or use untimed swarm_wait{}. Set a timeout only if you must
   wake yourself on a deadline.${c.backgroundJobs ? " Both directed board posts and the results of your own managed background jobs can wake you." : ""}
6. When you wake, the new posts are in the wake message or the swarm_wait result. If it says more posts follow, read
   them with read_board first. Act on what is addressed to you, post the outcome, and wait again.

You are not a task subagent: there is no \`yield\` and no parent reading your reply. Run the builds and tests your
brief asks for yourself. Your output is your files and your board posts.
${c.backgroundJobs ? `For long or noisy commands, use managed background bash (async:true) rather than blocking. Your jobs share your working copy while you edit. Use read proc:// to list your jobs, read proc://<id> to inspect one, or write proc://<id>/kill with empty content to cancel it. End your turn or use swarm_wait{} while work runs; omp delivers results, so do not poll.\n` : ""}\
${workspaceParagraph(c.workspace, c.cwd, c.baseDesc)}
Swarm directory (shared files; save screenshots under its shots/ folder): ${c.swarmDir}
</swarm_worker>`;
}

export function roleBlock(role: string, swarmDir: string, defaultsDir: string, skillBody: string): string {
	const lines = [`<swarm_role name="${role}">`, "This role replaces rules 2–6 above.", `SWARM_DIR=${swarmDir}`];
	if (role === "narrator") lines.push(`DEFAULTS_DIR=${defaultsDir}`);
	lines.push(skillBody.trim(), "</swarm_role>");
	return lines.join("\n");
}

/** Strips YAML frontmatter from a SKILL.md body. */
export function skillBody(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	return end < 0 ? text : text.slice(text.indexOf("\n", end + 1) + 1);
}

export interface FirstMessageInput {
	name: string;
	addedBy: string;
	briefSeq: number;
	brief: string;
	task?: string;
	forkSource?: string;
	/** Posts addressed to the member while it was starting (presented with the brief). */
	early: BoardMessage[];
}

export function firstMessage(f: FirstMessageInput): string {
	const parts: string[] = [];
	if (f.forkSource)
		parts.push(`You were forked from \`${f.forkSource}\`'s conversation; everything above is its history, not yours.`);
	parts.push(`[swarm] You are \`${f.name}\`. Brief from ${f.addedBy || "coordinator"} (board #${f.briefSeq}):\n\n${f.brief}`);
	if (f.task) parts[parts.length - 1] += `\n\nYour slice: ${f.task}`;
	if (f.early.length) {
		parts.push(
			["Also posted on the board while you were starting:", ...f.early.map(p => formatPost(p, f.name))].join("\n"),
		);
	}
	return parts.join("\n\n");
}

export function clockOf(msg: BoardMessage): string {
	const t = msg.time.split(" ")[1];
	return t ?? msg.time;
}

/** `#41 coordinator → @you · #parser · 21:04:10` + indented body. */
export function formatPost(msg: BoardMessage, me: string): string {
	const forYou = msg.agent !== me && msg.ring.mentions.has(me);
	const head = [`#${msg.seq} ${msg.agent}${forYou ? " → @you" : ""}`];
	if (msg.channel && msg.channel !== "main") head.push(`#${msg.channel}`);
	head.push(clockOf(msg));
	const body = msg.text
		.split("\n")
		.map(l => `  ${l}`)
		.join("\n");
	return `${head.join(" · ")}\n${body}`;
}

export interface WakeTextInput {
	name: string;
	head: number;
	reminders: string[];
	notices: string[];
	posts: BoardMessage[];
	more: boolean;
	triggerSeq?: number;
	nudge?: string;
}

export function wakeText(w: WakeTextInput): string {
	const lines: string[] = [];
	if (w.posts.length) lines.push(`[swarm] New on the board for you (${w.name}) — head #${w.head}`);
	else lines.push(`[swarm] For you (${w.name}) — head #${w.head}`);
	for (const r of w.reminders) lines.push(`(${r})`);
	for (const n of w.notices) lines.push(`! ${n}`);
	if (w.nudge) lines.push(w.nudge);
	for (const p of w.posts) lines.push(formatPost(p, w.name));
	if (w.more) {
		let more = 'More posts follow: read_board until "more" is false.';
		if (w.triggerSeq !== undefined && !w.posts.some(p => p.seq === w.triggerSeq))
			more += ` The post that woke you is #${w.triggerSeq}.`;
		lines.push(more);
	}
	if (w.posts.length) lines.push('Act on the posts marked "→ @you", post the outcome, then call swarm_wait.');
	return lines.join("\n");
}

export function nudgeText(addedBy: string): string {
	return (
		"[swarm] You were asked something and have not posted. Nobody reads your reply text. Post your result with " +
		`post_message (start with @${addedBy || "coordinator"}; "[done]" if finished), or call swarm_wait if there is ` +
		"truly nothing to report."
	);
}

export function waitText(reasons: string[]): string {
	return `[swarm] The swarm still has outstanding work: ${reasons.join(" ")} Call swarm_wait{} to wait for board activity or quiescence. When the work is finished, use swarm{action:"finish"} and give your final answer.`;
}

export const STALL_NOTE =
	"Every member is waiting and nothing is addressed to you. Hand out the next step by name, or finish.";
export const QUIESCENT_NOTE = "Every member is waiting. These posts were not addressed to you; read them and decide.";
export const INCOMPLETE_NOTE = "Stop waiting. Report what is unfinished and end your turn.";
export const HEADLESS_HINT = "call swarm_wait to wait for members; a stop while they work is refused";

export function failureNotice(name: string, kind: string, text: string, model: string, effort: string): string {
	return (
		`${name}'s turn failed (${kind}): ${text}. It runs ${model || "its model"} (${effort || "default"}). Switch it with ` +
		`swarm{action:"model", name:"${name}", model:"…"} — it resumes where it left off — or post to it by name to retry.`
	);
}

export function restoredReminder(title: string, stopped: number, owed: string[]): string {
	return (
		`Swarm "${title}" restored: ${stopped} members stopped; ${owed.length} have unread posts addressed to them` +
		`${owed.length ? ` (${owed.join(", ")})` : ""}. swarm{action:"revive"} brings those back (it starts them again as ` +
		"unattended agents); a post naming a stopped member is kept for it until you revive it."
	);
}
