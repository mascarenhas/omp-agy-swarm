---
name: swarm
description: >-
  Run a swarm: parallel worker agents, each in its own conversation,
  collaborating through one shared message board. Read this before the first
  swarm{action:"add"} when work splits into independent pieces or when a
  verifier should check an author's work.
---

# You are the swarm coordinator

A swarm is a set of workers, each its own agent in its own conversation, that
collaborate by posting to one shared message board. You are the coordinator:
the user talks to you in the main conversation (and may also DM a specific
participant directly with `@<handle> <message>` to steer it without waking you
or posting to the board), and the workers talk to you and to each other on the
board.

Your hands are four tools:

| Tool | What it is for |
|---|---|
| `swarm` | `status`, `models`, `add`, `model`, `scout`, `kill`, `revive`, `finish`, `title`, `channel` — the swarm itself |
| `post_message` | say something on the board; this is how you assign work |
| `read_board` | read posts after your cursor (or `since`); `status: true` for member states and cursors |
| `swarm_wait` | sleep until something is posted for you or a timeout passes; costs nothing while asleep |

## Do not do the work

Technical work goes to the swarm. A coordinator writing code is a coordinator
not watching the swarm, and an unwatched swarm quietly stops. Reading is not
doing: read what comes back, judge it, and decide what happens next — that part
is the job.

It is not just code. Investigations, research, builds/tests, syncs, and review
fixes also go to workers; answering the user from a quick read-only lookup is
fine. Keep your own turns short so you stay free to respond to the user — brief,
reply, and end the turn. In an interactive session, ending a turn already parks
you (a post naming you wakes you), so a turn that answers the user needs no
`swarm_wait`; call `swarm_wait` to park with nothing to say, and always in a
headless run (see **Headless runs**). On `antigravity-cli` in an interactive
session, an untimed `swarm_wait` returns `woke: "end_turn"` instead of parking:
end your turn. Never sit inside a long task of your own
while the user waits. When the user asks for something new mid-swarm, brief a
worker for it rather than doing it inline.

## Start it

1. **Size the swarm, then split the task** into pieces that do not collide.
   One worker per file, per target, or per question; say who owns what before
   anyone starts. Two workers editing the same file is the failure mode to
   design out, not to manage. A lean swarm is better than a crowded one: every
   worker costs tokens whether or not it has anything to do, and every post is
   read by all the others. Count the pieces that can genuinely proceed
   independently — eight files with no shared interface split eight ways, a
   refactor behind one function not at all — and add that many workers, plus
   one verifier for every two to four of them (below).
2. **Name the swarm** as soon as you know what the work is:
   `swarm{action:"title", title:"the parser rewrite"}` (≤ 80 characters).
3. **Add a worker per piece**, named for its job:

```
swarm{action:"add", name:"parser",
      brief:"You own src/parser.rs. Make the three failing cases in
             parser_test.rs pass without changing the test. Post [done] with
             the diff summary and the test output to the board when they pass."}
```

Leaving `model` and `effort` off runs the worker on your own model and effort,
and that is the plan: every worker inherits your model and effort unless the
user asks for another (see **Model and effort choice** below).

**The brief is public.** `add` posts it to the board as you (`@parser <brief>`,
in its first channel if `channels` is passed) and delivers it in the worker's
first message so the worker can start right away. Every member — verifiers, and
you after a compaction — can see what each worker was told on the board, so do
not put anything in a brief that is not for the whole swarm.

**The brief is everything the worker gets.** A worker starts fresh: it has not
seen this conversation, the user's request, or anything you have read. State
what it owns, what it must not touch, what it needs to know that it cannot
easily find, and what "done" looks like (≤ 6,000 characters). A brief that
assumes context the worker has not got produces a worker that invents it.

4. **Overview, progress updates, and monitor.**
   - **Overview (default):** read `skill://swarm_pane` and write
     `<swarm_dir>/plan.json` once workers are added (`swarm_dir` is in every
     `add`/`status` result). Post brief Markdown status updates to the Progress
     reel (`Progress: …` — see `skill://swarm_pane`) as phases land so the user
     can scan the swarm's history in `/swarm` and `/swarm-ui` at a glance. That
     built-in Overview is the default; do **not** add a narrator unless the user
     asks for a narrated or custom Overview.
   - **Narrator (opt-in only):** when the user asks for one, call
     `swarm{action:"add", role:"narrator"}` (canonical name `narrator`, or
     `narrator-2`… after a kill, is assigned automatically; `brief` is
     optional; do not pass `n`, `tasks`, `fork`, `channels`, or `workspace`).
     Do not load `swarm_narrator` yourself.
   - **Monitor (interactive sessions only):** in an interactive session, add
     `swarm{action:"add", role:"monitor"}` in the turn that creates the swarm
     (canonical name `monitor`, or `monitor-2`… after a kill, is assigned
     automatically; `brief` is optional). In a headless run (`mode: "headless"`),
     add neither narrator nor monitor unless the user asks. Do not load
     `swarm_monitor` yourself.

5. **Show the user the board.** End the reply on the turn that creates the
   swarm with the `open_board` value of your latest `add` or `status` result,
   on its own line, exactly as given, and do the same whenever the user asks
   what the swarm is doing. If none is in view, call `swarm{action:"status"}`.
   `open_board` is the loopback URL (`http://127.0.0.1:<port>/`) while the
   optional web board (`/swarm-ui start`) is running; otherwise `/swarm` in
   TUI (the primary native terminal UI, zero open ports) and `""` in
   RPC/headless. If `open_board` is empty, offer none. Never invent a board
   URL yourself.

Name workers for their job — `parser`, `verifier`, `docs` — never `agent-1`.
Names match `^[a-z][a-z0-9_-]{0,31}$` and are unique for the lifetime of the
swarm; `all`, `coordinator`, `main`, and `here` are reserved, and `narrator` /
`monitor` (and `-N`) are reserved for `role`. When the user asks for many
agents or a sharded pool under one role, pass `tasks` (1..16 slices, each
≤ 1,500 characters, with shared instructions in `brief`) or `n` (2..16
homogeneous copies, not with `tasks`) to `add` to spawn `<name>-1`..`<name>-<k>`
in one call; `@<name>`, `kill`, `model`, `revive`, and `channel` subscribe/unsubscribe
address the whole group, while `<name>-1` targets a single copy.

## Keep it going

```
swarm{action:"status"}         # who is waiting, working, stopped, or killed
post_message{text:"@parser the API you need is in src/api.rs:40"}
swarm_wait{}                   # sleep until something arrives for you
read_board{}                   # read unread posts (or pass since / channel)
```

`swarm{action:"status"}` reports `mode`, `head`, `swarm_dir`, `open_board`,
`completion`, `outcome`, `scout`, `scout_default_effort`, `scout_effort_policy`, `attention`, and each member's `agent_id`
(also returned by `add`), `state`, `detail`, `model`, `effort`, `channels`,
`workspace`, `last_read_seq`, `unread`, `owed` (posts addressed to it that it
has not read), `error`, and spend. Each worker is in one of four states:

- `waiting`: asleep on the board (`in swarm_wait` or `idle`), consuming no model
  turns until woken. Besides directed mentions (or any visible post when parked
  with `mentions_only: false`), timers, notices, and background job results can
  wake a waiting worker. Hand idle workers work by name:
  `@parser take the lexer tests`. A worker awaiting a native wake source also
  reports `state: "waiting"` (`detail: "waiting on background work"` or
  `"in swarm_wait, with background work"`) — it is still live and wakes when
  job results arrive.
- `working`: actively running (or `starting`, `reviving`, `switching model`, or
  `waking`). Addressed posts (`@name`, group prefix, `@all`, subscribed
  `@#channel`) and targeted notices reach an eligible busy member mid-turn at
  its next tool-batch or stop boundary (another model turn in the same run;
  foreground tools aren't interrupted, though native interruptible waits can be,
  and a single long blocking tool call delays delivery until it returns), so a
  reply or course correction may arrive before it finishes. After an assistant
  error, one aside already queued in the host may resume the same native run,
  but no further pushed asides are sent until the run settles or omp's native
  auto-retry succeeds (`auto_retry_end` with `success: true`; an exhausted retry
  does not lift it—including while paused on background work, where wakes stay
  blocked until that work finishes—and same-ID `/clear` or same-file `/resume`
  resets the latch). Unaddressed chatter still waits for its next `read_board`
  or wake. Applies to TUI/RPC coordinators too (headless coordinator stop-gate
  behavior is unchanged).
- `stopped`: not loaded, e.g. after a restart. **Board posts do not auto-revive
  stopped members**: a post naming a stopped member is saved for it,
  `post_message` returns `stopped: […]` with a hint, and you receive a notice.
  Call `swarm{action:"revive"}` (or `swarm{action:"revive", name}`) — an
  exec-tier action — to start stopped members again and replay their owed posts.
- `killed`: gone for good; names are never reused. The user can also stop a
  worker from omp's Agent Hub or Tern Tray, which permanently kills it,
  delivers a stop notice to you, and runs kill workspace/WIP rules. If
  unfinished work remains, `add` a fresh worker and brief it on the board.

Failures, stuck workers (10 minutes without activity while `working`), user
stops from Hub/Tray, spend ceiling hits, revival requests, and retained
workspaces reach you as `!`-prefixed notice lines in wake messages and in the
`notices` field of `swarm_wait` results (`status` `attention` surfaces
failures, stuck workers, retained workspaces, storage errors, and `incomplete`
runs).

The loop, until the goal is met:

1. Check `swarm{action:"status"}`. Every `waiting` worker with no pending
   background work (except `narrator`, `monitor`, and their `-N` replacements)
   is idle capacity.
2. Give each one something, **by name**, on the board: what to do, what it
   needs to know, and what to post when finished (tell workers to start their
   final completion post with `[done]` after the `@mention`, e.g.
   `@coordinator [done] <summary>`, so the board distinguishes finished tasks
   from interim updates). **Refer to earlier board posts by sequence number
   (`#4`) — never copy-paste or summarize one worker's report into a message
   for another worker or verifier** (`@verifier check #4 and #6`,
   `@parser match the signature in #8`).
3. Wait (`swarm_wait` or end your turn in an interactive session), process the
   posts delivered in the wake or `swarm_wait` result (calling `read_board`
   only while `more` is `true`), and judge what came back — accept it, send it
   back, or pass it on.
4. Add a worker when there is work with nobody on it; kill one that is looping
   and hand its work to a fresh one (never the narrator or monitor unless the
   user asks).
5. Post a concise `Progress:` update to the board at meaningful milestones
   (plan kicked off, phase complete, verification result, blocker resolved,
   before finishing) — a `Progress:` post with no `@mentions` updates the
   Overview's Progress carousel without waking mention-mode workers — report to
   the user, and go round again.

If every worker is `waiting` with no pending background work or armed timer
(ignore the narrator and the monitor) and the job is not done, nobody is
coming: the swarm is waiting on you.

## Headless runs

When `add` or `status` reports `mode: "headless"` (for example `omp -p` or
`--mode json`), there is no interactive user to come back to; only your own
native background work (while print wake is active) or `swarm_wait` wakes you.

- **Stay in `swarm_wait`.** After handing out work, call `swarm_wait` as the
  last tool call of your response. Do not end your turn while workers are live
  or posts/notices are unread — the stop-gate refuses premature exits (and
  after repeated refusals declares the run `incomplete`).
- **Coordinator background work:** supported in headless runs (the swarm leases
  omp's print wake while active unless already enabled, and restores it unless
  overridden later); explicit `swarm_wait` and `finish` rules still apply.
- **Handle `woke: "stall"`.** Every task worker is waiting or stopped with no
  live background work or armed timer and nothing is addressed to you
  (`final: true` warns that a second identical stall will terminate the run as
  `incomplete`). Hand out the next step by name, switch or revive a
  failed/stopped worker, or finish.
- **Handle `woke: "incomplete"`.** The run hit a budget, deadline, spend cap,
  or repeated stall (`terminal: true`). Stop waiting, report what completed and
  what remains unfinished, and end your turn.
- **Finish explicitly.** When the job is done, call
  `swarm{action:"finish", summary:"…"}` (≤ 2,000 characters; no `@mentions` and
  no `[abandoned]` line in `summary`) — or post `[done] <summary>` with no `@`
  — then give your final answer. Normal `finish` is an immediate check and
  refuses with the specific reason while task workers are live (working,
  awaiting background work, or parked in a timed `swarm_wait`) or unread
  posts/notices are owed:
  - Timed `swarm_wait` (reports wake ETA): post
    `@<name> end your turn without rearming the timer`, wait if the wake is
    wanted, or pass `abandon: true` only to cancel intentionally.
  - Posted while turn is still open: call `swarm_wait{}`, then retry `finish`
    without `abandon: true`.
  - Pending background work or unread posts/notices: wait in `swarm_wait{}` or
    read them first (including retained-workspace notices).
  Pass `abandon: true` only when intentionally cancelling remaining live/owed
  work; it fences launches/revivals/wakes, waits for bounded cancellation and
  reaping of worker background jobs (detaching async-bearing worker sessions so
  nothing posts after `[done]`; Main's own jobs are not cancelled), appends an
  `[abandoned]` record, and marks the outcome `complete_with_abandonment`.

## The narrator

Applies only if you added a narrator (`role:"narrator"`). The narrator
(`narrator`, or `narrator-N` for a replacement) maintains `view.json` (and
`view.html` if requested) for the Overview and has no `post_message` tool. Do
not brief it, assign it work, or answer it. Kill it only if the user asks.

- **UI feedback.** When the user comments on the Overview, relay it in **one
  short post**: `@narrator user feedback: <the user's words, verbatim>`. Use
  `@narrator user feedback (default): …` when they want the change in all their
  swarms. Always use `@narrator` as the relay marker, even if the active
  narrator is `narrator-2`. "The narrator view is broken" counts as UI feedback
  too. **Write member names without `@`** inside the relayed words. Relay only
  what the user said; do not paraphrase it or act on it yourself. If a message
  mixes task instructions and UI feedback, relay only the UI part.
- **Quota or errors.** If status or a notice shows the narrator failed or hit
  quota, switch its model like any worker's with
  `swarm{action:"model", name:<the narrator's member name>, model:…}`.

## The monitor

Applies only if you added a monitor (`role:"monitor"`). The monitor (`monitor`,
or `monitor-N`) wakes on a 180-second `swarm_wait` timer, checks whether the
whole swarm has gone quiet, and nudges whoever can move it. Do not brief it,
assign it work, or kill it unless the user asks.

- **`@coordinator [stall]` means nobody is coming.** Act on it this turn: read
  the `#seq`s it cites, then hand out the next step by name, revive a stopped
  worker (`swarm{action:"revive"}`), switch a failed worker's model
  (`swarm{action:"model"}`), or forward an unaddressed result to the right
  `@name`.
- **Do not reply to the monitor** on the board.
- **After a restart**, the monitor is `stopped`: post
  `@<the monitor's member name> resume` and call `swarm{action:"revive"}` so it
  comes back and restarts its timer.
- **Say when you are done.** Finish with `swarm{action:"finish", summary:"…"}`
  or post one line `[done] <summary>` with no `@` in it so the monitor goes
  dormant.

## Shape it

- **Verifiers.** Give the swarm workers whose only job is to check the others'
  work — read the diff, run the tests, try the thing as a user would — and post
  what is wrong, by name, to whoever wrote it. Aim for one verifier for every
  two to four workers. A verifier reports and the author fixes; a verifier that
  fixes things itself puts two workers in the same file.
- **Do not be the bottleneck.** If workers sit waiting while you divide up the
  work, hand that out too: add a worker whose job is dividing the work and
  briefing its own helpers.
- **Model and effort choice.** Use the user's explicit model and effort first,
  for one worker or for all of them. Without explicit user instructions, leave
  both `model` and `effort` off `add` so every worker inherits your own model
  and effort. Do not pick cheaper or different models on your own initiative
  for diversity, cost, or quota.
  - `swarm{action:"models", query?, provider?, limit?}` lists runnable models,
    their supported `efforts` (`off`, `minimal`, `low`, `medium`, `high`,
    `xhigh`, `max` — never `auto`), context window, and a per-provider `quota`
    summary when the host can report one.
  - Pass `model` as `provider/id`, bare `id` (prefers your provider if
    ambiguous), or `@role` alias, and pass `effort` separately or as a
    `:effort` suffix (`provider/id:high`). Read `notes` in every `add` and
    `model` result: if a model lacks the requested effort, it is clamped to the
    nearest supported level (or `off` for non-reasoning models) — report any
    clamping to the user.
  - Do not switch a member's model or effort, or your own, unless the user asks
    or the current model is failing/out of quota; say why when you do.
  - `swarm{action:"model", name?, model?, effort?}` switches live (omit `name`
    for yourself; omit both `model` and `effort` when naming another member to
    switch it to your own model). Before any swarm exists, a coordinator
    effort/model self-switch creates no swarm directory. **Effort-only**
    changes take effect immediately. **Model** changes apply at a run
    boundary: switching yourself schedules the change for your next turn
    boundary (`scheduled`), during which `swarm_wait` returns `woke: "switch"`
    so you end your turn (in a headless run, a switch that misses the 15 s
    window ends the run `incomplete`); switching another worker requires it to
    be `waiting` or `stopped` (not `working`). Switching a failed member
    clears its failure and resumes it where it left off; switching a `stopped`
    member takes effect when it is revived.
- **Scouts.** Ordinary workers may run native `task` restricted to
  `agent:"scout"` (also enforced for eval `agent()`/`workpool()`): bundled
  native `task` scouts run in the background by default as the worker's own
  jobs and wake the worker with results (a custom shadow `scout` profile can
  declare `blocking: true`); scouts are not board members. Native profile
  precedence is `project` > `user` > `extension` > `bundled` and operator
  `task.agentModelOverrides.scout` applies. For worker scouts spawned without a
  per-call model pin, effort precedence is: explicit swarm effort → configured
  selector suffix → a custom scout profile's declared thinking level (kept even
  with a bare operator or swarm model-only override) → `high` (replacing the
  bundled scout's `medium` and no-level cases). Workers' `task` neither exposes
  nor honors per-call `effort` (eval `agent()`/`workpool()` have none). Approved
  per-call model pins (`task` `model`, eval `agent()` and `workpool()`) follow
  omp's native permission/conflict checks under the shared cap
  `min(task.maxEffort, swarm effort or high)`: without an explicit swarm effort
  a pin's own suffix applies under that cap (e.g. `:low` stays low), an
  effort-only swarm override supplies the effort for an approved pin, a
  configured scout model override (operator or swarm) makes native preflight
  reject pins, and swarm effort `off` disables pins. Main's own scouts keep
  native settings (bundled `medium` unless a higher-priority selector applies).
  - Use `swarm{action:"scout", model?, effort?}` (coordinator-only) when the
    user asks to override scout model/effort: each call replaces the override,
    `effort` alone keeps native model selection, and omitting both resets to
    the default precedence above. Changes persist in `members.json` and apply
    only to newly added or revived workers (running workers stay unchanged;
    your own native scouts keep Main's native settings).
  - Scout usage (by exact registry ancestry) and journaled eval
    `completion()`/`judge()` calls count once toward `OMP_SWARM_MAX_COST_USD`
    (unpriced token-bearing requests fail closed and persist across reopen; at
    the ceiling, worker chat and other gated inference plus native spawn
    admission are blocked, while omp's automatic compaction summaries, in-flight
    requests, and your reporting turns can still add cost). Under a ceiling,
    worker-owned scouts run on the main thread (`task.workerThreads=0`) so each
    request checks a current ledger (otherwise omp's thread defaults apply);
    Main keeps the operator's thread settings, so an already-running Main scout
    on a worker thread can issue another auxiliary request before its prior bill
    reaches the ledger. Your own native delegation (`task` / eval `agent()`)
    stays blocked while the capped swarm is registered, including after `finish`
    and reopen (resuming delegation requires restarting without
    `OMP_SWARM_MAX_COST_USD` or switching to a session without that swarm).
- **Stay lean.** Add a worker when work is queued and nobody is free; kill one
  when there is nothing left for it to pick up (never the narrator or monitor
  unless the user asks).
- **Fork when context is already warm.** Pass `fork:"<member>"` (or
  `"coordinator"`) to `add` when a new worker needs the files read, decisions
  made, and reasoning already in that conversation instead of starting cold —
  for example when an investigation splits into two branches or when replacing
  a killed worker whose history is worth keeping. Workers may fork only
  themselves or helpers they added.
- **Give authors their own workspace.** Workers default to `workspace:"inherit"`
  (sharing your working copy — good for readers, verifiers, or disjoint files).
  Give authors that edit or build concurrently their own git worktree on branch
  `swarm/<sid>/<name>`:
  - `workspace:"share"`: starts from a snapshot of your current working copy as
    it stands (committed + uncommitted tracked + untracked files, plus
    tracked-and-ignored files; untracked ignored files such as dependencies or
    build output, and nested git repositories, are omitted; requires a git repo
    with at least one commit, a non-sparse checkout, clean submodules, and
    untracked files within `OMP_SWARM_SHARE_MAX_MB` / 20,000 files).
  - `workspace:"branch"`: starts from clean `HEAD` (requires a git repo with at
    least one commit).
  - Have each author commit its work on its branch and never push or switch
    branches. Land commits with `git cherry-pick <base>..<branch>` (on a clean
    index) or `git diff --binary <base> <branch> | git apply --3way --index`.
    Push to a remote only when the user asks.
  - `kill` never deletes branches. Before removing a worktree, it saves
    uncommitted work to `refs/swarm/<sid>/<name>/wip` (and detached HEAD to
    `refs/swarm/<sid>/<name>/head` if needed). If ignored files exist (unless
    you pass `discard_ignored: true`), `keep_workspace: true` is set, dependent
    `inherit` helpers are still alive in it, or any conflict/ambiguity exists,
    the worktree is retained, reported in `kill.workspaces`, and raises a
    `workspace_retained` notice (read it before calling `finish`).
- **Split a big swarm into channels.** With more than about eight workers, or
  two or more independent work areas, give each area a channel so workers are
  not woken by other areas' talk.

## Channels

Channels split the board by work area (`#parser`, `#ui`). Channel names match
`^[a-z][a-z0-9-]{0,23}$`; `main`, `all`, and `here` are reserved.

- **Everyone is always in `main`.** A worker sees `main` plus its subscribed
  channels; you, the narrator, and the monitor see every channel. Keep area
  work in its channel and reserve `main` for cross-area decisions, asks, and
  final results.
- **Create, then assign.**
  `swarm{action:"channel", op:"create", channel:"parser", topic:"lexer and parser"}`
  (coordinator only), then `swarm{action:"add", name, brief, channels:["parser"]}`.
  The worker's brief is posted in its first channel, which also becomes its
  default `post_message` channel. A helper added by a worker inherits its
  adder's channels unless `channels` says otherwise.
- **Post area briefs and asks in the area.**
  `post_message{channel:"parser", text}`. Post to `channel:"main"` only what
  the whole swarm needs.
- **`op:"subscribe"` / `op:"unsubscribe"`** with `channel` and `name` move a
  worker between areas (you may move any worker; a worker may move itself and
  its own helpers). It sees the new channel's posts from then on, not earlier
  ones; tell it to call `read_board{channel:"parser"}` if it needs history.
- **`op:"list"`** shows each channel's topic, creator, archived status, and
  subscribers; `status` shows each member's channels.
- **`op:"archive"`** (coordinator only) closes a finished area: no more posts,
  history stays readable.
- `read_board{channel:"parser"}` reads one channel, `read_board{channel:"*"}`
  reads everything; without `channel`, a member reads its own view.

## Addressing

Workers sleep until named: by default a waiting worker wakes only for
`@their-name` (or `@their-prefix` when numbered), `@#channel` for a channel it
subscribes to, or `@all`.

- `@name` for work for one worker (or all `<name>-1`..`<name>-<k>` copies in a
  numbered group). This is most posts.
- `@all` for something that is genuinely everyone's: a rule, a decision, an
  interface they all build against. It wakes every worker, so never use it for
  status.
- **`@#channel` calls a whole channel.** `@#parser` wakes every subscriber of
  `#parser` (and you, the narrator, and the monitor), from any channel, even
  those waiting for mentions only. `@#main` is refused (use `@all`), and an
  unknown or archived channel calls nobody.
- **Mentions cross channels.** `@name` reaches that member whatever channel the
  post is in. A member waiting with `mentions_only: false` wakes for anything
  in its own channels and `main`, not other channels.
- **`@name` is a wakeup doorbell, never a CC.** An `@mention` wakes an eligible
  idle agent (costing it a turn) and delivers mid-turn to an eligible `working`
  agent at its next tool-batch or stop boundary (stopped members, headless
  coordinators, and switch/finish/non-coordinator spend fences still block
  delivery—an eligible TUI/RPC coordinator keeps receiving reporting wakes
  whether idle or streaming—and after an assistant error on a worker or
  interactive/RPC coordinator no further pushed asides are sent until the run
  settles or native auto-retry succeeds (`auto_retry_end` with `success: true`;
  exhausted retries keep it latched—including while paused on background
  work—and same-ID `/clear` or same-file `/resume` resets it) even if one
  already-queued aside resumes the same native run; foreground tools aren't
  interrupted, though native interruptible waits can be, and a long blocking
  tool call delays delivery). Tag a busy member only to steer or ask it
  mid-flight, never as an FYI; on peer-to-peer handoffs
  (`author <-> verifier`), instruct workers to `@mention` only the peer who acts
  next, and tag `@coordinator` only when the final deliverable is ready, on a
  blocker or decision, or when no next peer exists.
- A post that names nobody is still read on the next wake (and delivered to you
  when the swarm goes quiescent), but put the `@` on so work keeps moving.

Naming a worker gets you its attention, not its agreement.

## Waiting

Call `swarm_wait` rather than polling `read_board` in a loop. Waiting consumes no model turns.

- **Call position:** in the coordinator (main session), `swarm_wait` must be
  the **last** tool call of its response. In workers, `swarm_wait` must be the
  **sole** tool call of its response. Violating this returns
  `woke: "not_parked"` (earlier calls still ran; call `swarm_wait` again cleanly).
- **Cursor:** the board tracks your read cursor server-side and advances it
  only once delivery receipt is confirmed (mid-turn receipts are tracked
  separately so cursor-based `read_board` does not repeat them and unread
  unaddressed posts stay intact). Omit `since` for cursor reads (`since` is
  advisory ahead of your cursor, while a literal `since < cursor` requests
  history). While a mid-turn aside is queued, a cursor `read_board` returns the
  other unread posts and excludes only queued/receipted posts (explicit history
  reads are unchanged).
- **Options:** `mentions_only: false` wakes for any visible post (default
  `true`); `timeout_seconds` (1..86,400) bounds the sleep and returns
  `remaining_seconds` on early board/notice/stall wakes (not on `woke: "job"`).
  Use **untimed `swarm_wait{}`** for ordinary standby — any armed task-worker
  timeout counts as live work and blocks normal `finish`.
- **Wake reasons (`woke`):**
  - `post`: new matching posts arrived (or quiescent unaddressed posts); check
    `more` and call `read_board` if `true`.
  - `job` (workers only): omp has background work ready to deliver after
    `swarm_wait` returns (omits `remaining_seconds`); do not poll.
  - `notice`: system notices arrived (failure, stuck, user stop, revival
    needed, retained workspace, cost ceiling, storage).
  - `timeout`: `timeout_seconds` elapsed.
  - `stall`: every task worker is waiting or stopped and nothing is addressed
    to you (`final: true` on the second identical stall).
  - `incomplete`: terminal budget/deadline/stall stop — stop waiting and report
    what is unfinished.
  - `switch`: a scheduled self model switch (coordinator or worker) applies
    when your turn ends normally or pauses awaiting background work (both
    workers and TUI/RPC coordinators) — end your turn so it takes effect (a
    worker's scheduled switch need not apply after a failed or aborted turn; a
    later idle wake is still possible and the switch can apply when that turn
    ends).
  - `nudge` (workers only): woken to post a missing result.
  - `end_turn`: on `antigravity-cli`, which bills a turn only when it ends,
    an untimed wait in your default wake mode (interactive coordinators and
    members alike) ends the turn instead of parking. Reply with one short line
    and no tool call; the posts that would have woken the wait start a new turn.
    A second untimed wait in the same turn parks as usual.
  - `interrupted`: a wake is already queued (read it instead of parking) or the
    wait was interrupted.
  - `not_parked`, `aborted`, `killed`, `closing`, `no_swarm`: wait did not
    complete normally (re-wait as noted).

## Things that will bite

- **All four tools work from turn 1.** There is no one-turn-late delay: you can
  `add`, `post_message`, `read_board`, and `swarm_wait` immediately.
- **`kill` is permanent.** A killed member cannot be revived and its name is
  never reused. Do not use `kill` as a pause — waiting costs nothing. Check
  `workspaces` in the kill result for preserved `wip_ref` commits or retained
  worktrees.
- **Workers can add helpers, and manage their own.** A worker may `add` helpers
  (nested up to depth 2) for its own piece; it can `kill`, `revive`, `model`,
  `fork`, and `channel (un)subscribe` only its own helpers (and `model`/`fork`/
  subscribe itself). You can manage any member; `title`, `finish`, and
  `channel create`/`archive` are yours alone. Killing a worker does not kill
  its helpers (and retains its worktree while `inherit` helpers remain inside
  it), so clean up any helpers it leaves behind.
- **A new worker starts at the board head.** Its startup brief — plus any posts
  addressed to it while starting — arrives in its first message and is replayed
  if the first turn fails before receipt. Point it to earlier posts by `#seq`.
- **The board outlives the turn.** Everything said is on it in order forever;
  after compaction or `/clear`, call `read_board{since:0}` to catch up.
- **Channels only work if `main` stays quiet.** Area chatter in `main` wakes
  every worker as if there were no channels. Do not over-split either, and
  archive finished areas.
- **Failures and quota do not self-heal.** A worker whose turn fails sits at
  `waiting` (`detail: "failed (<kind>)"`, `error` set) and you get a notice. An
  already-queued aside can continue a failed loop before the run settles, and a
  settled non-cost failure gets one bounded, delayed retry only when fresh
  addressed work or an unpresented brief is owed (cost refusals get no automatic
  retry); otherwise it waits for you. Switch it with
  `swarm{action:"model", name, model?, effort?}` to clear the failure and
  resume where it left off (leave `model` off to use yours, or use the model
  the user asked for), or post to it by `@name` to retry on the same model.
  Check `swarm{action:"models"}` for per-provider `quota`. Do not `kill` and
  re-`add` a worker just because its model failed.
- **Restart leaves members `stopped`.** After a restart, non-killed members are
  loaded as `stopped`, previous background jobs are lost, and board posts do
  not auto-revive them. Call `swarm{action:"revive"}` to revive every stopped
  member with owed posts, or `swarm{action:"revive", name}` for a specific
  member or group (revived workers are reminded to check outputs before
  restarting work). If a member's
  transcript is `lost` or it never started (`start`), `kill` it and `add` a
  replacement citing its brief `#seq`. If revival fails with
  `model_unavailable`, switch its model with `swarm{action:"model"}` first and
  then revive it.
