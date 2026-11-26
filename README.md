# omp-agy-swarm

An Antigravity-style multi-agent swarm extension for [omp](https://omp.sh) **19.2.1**: parallel worker agents, each in its own isolated conversation, collaborating through one append-only shared message board.

- **In-process workers, zero persistent agent profiles:** workers run as restricted `createAgentSession` instances registered in omp's global `AgentRegistry`—making live workers inspectable via `/hub`, native transcript focus, and (in tray-capable hosts like Tern) Tray cards without touching `~/.omp/agent/agents/` (worker transcripts stay under `<swarm_dir>/sessions/`).
- **Full per-worker model and exact reasoning effort control:** inherit the coordinator's model and effort by default, or pin any runnable `provider/id` and exact effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — never `auto`) with live boundary model switching, immediate effort-only switching, and no silent fallback downgrades.
- **Native Tern & ANSI TUI (`/swarm`) + opt-in local web board (`/swarm-ui`):** `/swarm` provides four read-only, keyboard-driven views (Overview, Board, Members, Transcript) plus a live status widget under the editor with **zero open network ports**—rendering natively with pointer support on terminals that negotiate TSP (such as Tern) and falling back to ANSI where TSP is not negotiated (plain terminals and ordinary SSH). `/swarm-ui` starts a separate optional read-only loopback web board only when explicitly requested.
- **First-class headless (`omp -p`) execution:** stop-gate, stall/quiescence detection, spend ceilings, monotonic deadlines, and durable `metrics.json` outcomes.
- **Private personal repository:** `"private": true` in `package.json`; see [`NOTICE.md`](./NOTICE.md) for the provenance and SHA-256 verification of the vendored Antigravity web frontend files.

---

## Installation & Loading

Requires **omp `19.2.1`** (`@oh-my-pi/pi-coding-agent: 19.2.1`), **Bun**, and **git** (for `share`/`branch` workspaces).

```sh
# 1. Link a local checkout for persistent use in omp
omp plugin link /path/to/omp-agy-swarm

# 2. Or install from a local path / git repository
omp plugin install /path/to/omp-agy-swarm

# 3. Or load ad-hoc for one session
omp -e /path/to/omp-agy-swarm

# 4. Or load isolated (without other installed extensions)
omp --no-extensions -e /path/to/omp-agy-swarm
```

At `session_start` in the main session, the extension activates all four swarm tools (`swarm`, `post_message`, `read_board`, `swarm_wait`) automatically so they are available from turn 1.

---

## Quick Start

### Interactive TUI

Start `omp` in your project directory and ask it to run a swarm (or prompt it to read `skill://swarm`):

```text
Read skill://swarm and split the parser rewrite across two authors (lexer and parser) plus one verifier.
```

- A status widget appears below the editor (ANSI: `swarm · <title> · ●2 ○1 · #12 · /swarm`; native TSP: wrapping text with word counts such as `2 working · 1 waiting`).
- Run `/swarm` at any time to open the full-screen terminal board (or `/swarm board`, `/swarm members`, `/swarm transcript <name>`).
- Open omp's **Agent Hub** (`/hub` → `1` Agents → select → `Enter`)—or click a **Tern Tray** card in a tray-capable host—to focus a live member's native omp transcript.
- Optionally run `/swarm-ui start` to start the read-only loopback web board: in TUI the status widget immediately shows `http://127.0.0.1:<port>/` (even mid-turn; native wraps the full URL, while ANSI clips it only if the URL alone exceeds the terminal width), and a copyable transcript notice appears immediately when idle or when the active run ends (a brief toast is also sent, though it may not appear when idle—notably in Tern—and neither display depends on it).

### Headless (`omp -p`)

```sh
omp -p "Read skill://swarm. Add two workers to implement and test feature X, verify their diff, then finish." \
  --mode json \
  --no-extensions -e /path/to/omp-agy-swarm
```

In headless runs (`print` and `json` modes):
- `swarm{action:"add"}` and `swarm{action:"status"}` report `mode: "headless"` and `open_board: ""`.
- The coordinator stays in `swarm_wait` while workers run; premature turn stops while task workers are live or posts/notices are unread are refused by the stop-gate.
- Coordinator background work is supported: while a headless swarm is active, the plugin leases omp's print wake (`async.printWake = true`) if it is not already enabled, and restores the prior override on completion or close unless a later operator override or clear changed it.
- The coordinator finishes via `swarm{action:"finish", summary:"…"}` (or posting `[done] <summary>` with no `@mentions`) and then prints its final answer.
- Outcomes (`complete`, `complete_with_abandonment`, `quiescent_no_done`, `incomplete`, `coordinator_failed`, `aborted`), swarm-level `spend` (`{ tokens, cost, ceiling, unknown? }`), and per-member token/USD spend are written atomically to `<swarm_dir>/metrics.json`.

---

## Tools Reference

### `swarm` actions

Omit unused `effort`, `workspace`, `role`, and `op` fields. If a caller must send every field, use `"omit"` for these enums; it has the same effect as leaving the field out. Gemini rejects tool declarations that offer `""` as an enum value.

| Action | Key parameters | Purpose | Approval tier | Who can call |
|---|---|---|---|---|
| `status` | — | Swarm state, mode, `swarm_dir`, `open_board`, `completion`, `outcome`, swarm-level `spend` (`{ tokens, cost, ceiling, unknown? }`), `scout` override, `scout_default_effort`, `scout_effort_policy`, `attention`, and per-member `agent_id`/status/cursors/owed/spend | `read` | Coordinator, workers |
| `models` | `query?`, `provider?`, `limit?` (1..100, default 40) | Lists runnable models, supported `efforts`, context window, and per-provider `quota` summary | `read` | Coordinator, workers |
| `add` | `name?`, `brief?`, `model?`, `effort?`, `tasks?` (1..16), `n?` (2..16), `fork?`, `workspace?`, `channels?`, `role?` (`worker`\|`narrator`\|`monitor`) | Starts a worker, numbered group (`<name>-1..k`), or singleton role worker (`narrator`/`monitor`), returns its `agent_id`, and posts its brief | `exec` | Coordinator (any role); workers (`worker` helpers up to depth 2) |
| `model` | `name?`, `model?`, `effort?` | Changes a member's (or caller's) model and/or reasoning effort while keeping its conversation | `write` | Coordinator (anyone); workers (self or own helpers) |
| `scout` | `model?`, `effort?` | Replaces the swarm's scout override (`effort` alone keeps native model selection; omitting both resets to default precedence); returns `scout_default_effort` and `scout_effort_policy`; applies to newly added or revived workers only (Main keeps its native scout settings) | `write` | Coordinator only |
| `kill` | `name`, `discard_ignored?`, `keep_workspace?` | Permanently stops a member (or group) and runs preservation-first worktree cleanup | `exec` | Coordinator (any non-coordinator); workers (own helpers) |
| `revive` | `name?` | Revives stopped members after a restart (omit `name` to revive all stopped members with owed posts) and replays owed posts | `exec` | Coordinator (any non-coordinator); workers (own helpers) |
| `finish` | `summary` (≤ 2,000 chars, no `@`), `abandon?` | Marks the swarm `[done]`; normal `finish` is an immediate state check that refuses with a specific reason while task workers are live (including background jobs and timed waits) or unread; `abandon: true` fences workers and waits for bounded cleanup (without cancelling Main's own jobs) | `exec` | Coordinator only |
| `title` | `title` (≤ 80 chars) | Sets the swarm's title | `write` | Coordinator only |
| `channel` | `op` (`create`\|`list`\|`subscribe`\|`unsubscribe`\|`archive`), `channel?`, `topic?`, `name?` | Manages topic channels (`main` is always visible to everyone) | `read` (`list`), `write` (others) | `list`: coordinator & workers; `create`/`archive`: coordinator only; `(un)subscribe`: coordinator (anyone) or worker (self/own helpers) |

### Board & waiting tools

- **`post_message{text, channel?}`** (`write`): posts 1..8,000 characters to `channel` (default: caller's first channel, else `main`). Begin with `@name`, `@group-prefix`, `@#channel`, or `@all` (`@#main` is refused). Returns `seq`, `channel`, `mentions`, `all`, `channel_mentions`, `woke`, plus `unknown_mentions` and `stopped` (with a `revive` hint) when relevant. Disabled for `narrator`.
- **`read_board{since?, limit?, channel?, status?}`** (`read`): reads up to `limit` posts (1..200, default 50, capped at 48 KB per page) after `since` (default: caller's read cursor; own-view cursor reads never skip unread posts, omit already-receipted mid-turn posts, and while a mid-turn aside is queued return the other unread posts excluding only queued/receipted ones, whereas explicit history—`since < cursor` or an explicit `channel`—still includes them). Pass `channel: "<name>"` for one channel or `"*"` for all. Pass `status: true` to return member states, `detail`, `wake_mode`, `wait_since`, `wait_until`, `last_read_seq` (contiguous floor; sparse mid-turn receipts may exist above it), `channels`, `last_post_seq`/`last_post_time`, and `error` instead of posts.
- **`swarm_wait{since?, mentions_only?, timeout_seconds?}`** (`read`; host `interruptible`/`exclusive` flags on Main only — workers enforce the sole-call rule plus the job-ready check): parks without consuming model turns until a matching post (`mentions_only: true` default; `false` for any visible post), a notice, ready worker background work (`woke: "job"`, which omits `remaining_seconds`), a stall/incomplete signal, or `timeout_seconds` (1..86,400) arrives. Omit `timeout_seconds` for ordinary standby; any armed task-worker timer counts as live work and blocks normal `finish`.
  - **Call position:** must be the **last** tool call of a response in the coordinator (main session), and the **only** tool call of a response in workers (otherwise returns `woke: "not_parked"`).
  - **Server-side cursor:** `since` is advisory; the runtime advances a member's read cursor only after the host confirms receipt of the delivered message or tool result (sparse mid-turn receipts are tracked separately in `addressed_read_seqs` so unread unaddressed chatter survives restarts).
  - **Wake reasons (`woke`):** `post`, `job`, `notice`, `timeout`, `stall`, `incomplete`, `nudge`, `switch`, `not_parked`, `interrupted` (including when a wake is already queued, instead of parking), `aborted`, `killed`, `closing`, `no_swarm`.

### Role tool sets & permissions

- **Coordinator (main session):** full access to all 4 swarm tools (with main-session approval tiers above) and all main-session tools.
- **Task worker (`role: "worker"`):** all 4 swarm tools + `OMP_SWARM_WORKER_TOOLS` (default: `read, bash, edit, write, glob, grep, eval, task, todo, web_search, lsp, ast_grep, ast_edit`), intersected with the main session's active tools. Hard-excluded tools (`wait`, `manage_skill`, `new_context`, `yield`, `irc`, `async`, `job`) are always stripped. Task workers get omp-managed background jobs (`async.enabled: true`, following omp's `bash`/`eval` auto-background defaults) and, when `task` is active, native `task` (and eval `agent()`/`workpool()`) restricted by the SDK to the `scout` agent.
- **Narrator (`role: "narrator"`):** `read_board`, `swarm_wait`, plus `read, write, edit, bash, glob, grep` (intersected with active tools). Has no `post_message`, no `swarm` tool, cannot spawn subagents, and has async/auto-backgrounding disabled.
- **Monitor (`role: "monitor"`):** `read_board`, `swarm_wait`, `post_message` only (no `swarm`, no filesystem/shell/cron tools, cannot spawn subagents, and has async/auto-backgrounding disabled).

### Worker background jobs, scouts & liveness

- **Managed background jobs:** task workers (`role: "worker"`) share a per-swarm `AsyncJobManager` (`async.enabled: true`, inheriting omp's `bash`/`eval` auto-background defaults). Long or noisy commands should run in the background (`bash` with `async: true`) rather than blocking, since 10 minutes without activity while `working` trips the stuck check. Background jobs share the worker's working copy/worktree while it edits.
- **Parking & wakeups:** when a worker ends its turn awaiting a native wake source (`agent_pause{awaiting: true}`), it becomes `waiting` (`detail: "waiting on background work"` — idle on the board, still live, not flagged stuck, and not prematurely nudged). Both job results and directed board posts wake it. Calling untimed `swarm_wait{}` while jobs run shows `detail: "in swarm_wait, with background work"` and returns `woke: "job"` when omp has background work ready to deliver next; do not poll.
- **Mid-turn delivery:** posts addressing a busy member (`@name`, group prefix, `@all`, or a subscribed `@#channel`) and its targeted notices arrive at the next tool-batch or stop boundary (starting another model turn in the same run) through omp's aside queue (the same channel as native IRC). Foreground tools are not interrupted, though omp's native interruptible waits can be; unaddressed chatter still waits for the next normal `read_board` or wake. A single long blocking tool call delays delivery until it returns (managed background jobs keep boundaries frequent). Applies to eligible working workers, narrator, monitor, and TUI/RPC coordinators (headless coordinator stop-gate behavior is unchanged). After an assistant error (workers or interactive/RPC coordinator), one aside already queued in the host may resume the same native run, but no further pushed asides are sent until the run settles or omp's native auto-retry succeeds (`auto_retry_end` with `success: true`; an exhausted retry does not lift the fence—including while paused on background work, where wakes stay blocked until that work finishes—and same-ID `/clear` or same-file `/resume` resets the latch). At most one pushed page is in flight per member and can coexist with an explicit `read_board`; receiving a mid-turn aside does not reset the stuck clock or nudge cycle, and switch, non-coordinator spend, kill, and finish fences apply before dispatch (an eligible TUI/RPC coordinator keeps receiving reporting wakes whether idle or streaming; `finish{abandon:true}` also detaches task workers with a queued mid-turn wake).
- **Owner-scoped job control (`proc://`):** workers inspect and cancel only their own jobs via native `proc://` (`read proc://`, `read proc://<id>`, `write proc://<id>/kill` with empty content). There is no `job` tool, and worker jobs do not appear in Main's jobs sheet.
- **Teardown & restart:** `swarm{action:"kill"}`, Hub/Tray stop, `finish{abandon:true}`, and shutdown attempt bounded cancellation and reaping of the member's jobs (`finish{abandon:true}` detaches async-bearing worker sessions so late results cannot reopen turns or post after `[done]`, without cancelling Main's own jobs). If stop is not confirmed within the teardown bound, the worktree is retained; detached members remain `stopped` and `swarm{action:"revive"}` waits until any pending disposal finishes. Background jobs are lost on restart; `revive` reminds the worker to check outputs before restarting work.
- **Liveness & `finish` refusals:** a task worker awaiting background work or parked in a timed `swarm_wait` counts as live work (use untimed `swarm_wait{}` for ordinary standby). Normal `swarm{action:"finish"}` stays an immediate state check and refuses with the specific reason — timed wait with wake ETA and options, pending background work, or `"<name> posted, but its turn is still open. Call swarm_wait{}; when it wakes, retry finish without abandon:true."` (plus unread posts/notices only when actually owed).
- **Native scouts (`agent: "scout"`):** ordinary workers (`role: "worker"` with `task` active) can spawn native `scout` subagents via `task` — enforced by the SDK for `task` as well as eval `agent()` and `workpool()` (`narrator` and `monitor` cannot spawn, and `wait` stays excluded). Bundled native `task` scouts run in the background by default as the worker's own jobs and wake the worker with their results (a custom shadow `scout` profile can declare `blocking: true`); scouts are not swarm board members and are not resumed on restart. Native profile precedence is `project` > `user` > `extension` > `bundled`, and the operator's `task.agentModelOverrides.scout` applies. For worker scouts spawned without a per-call model pin, effort precedence is: explicit swarm effort → configured selector suffix → a custom scout profile's declared thinking level (kept even with a bare operator or swarm model-only override) → `high` (replacing the bundled scout's `medium` and the no-level case). Workers' `task` tool does not expose or honor a per-call `effort` parameter (eval `agent()`/`workpool()` have none). Approved per-call model pins (`task` `model`, eval `agent()` and `workpool()`) follow omp's native permission/conflict checks and are capped at the lower of the operator's `task.maxEffort` and the swarm effort (or `high`): without an explicit swarm effort a pin's own suffix applies under that cap (e.g. `:low` stays low), an effort-only swarm override supplies the effort for an approved pin, a configured scout model override (operator or swarm) makes native preflight reject pins, and swarm effort `off` disables pins. Main's own scouts keep native settings (bundled `scout` defaults to `@smol` at `medium` unless a higher-priority selector applies).
- **Swarm scout override (`swarm{action:"scout", model?, effort?}`):** coordinator-only (`write` tier). Each call replaces the swarm override: `effort` alone keeps native model selection, a model-only override falls through to a custom scout profile's declared thinking level or `high`, and omitting both fields resets to that default precedence (without creating an absent swarm; returns `scout_default_effort` and `scout_effort_policy`). The setting persists in `members.json` and applies only to workers added or revived afterwards (running workers are unchanged, and Main's own scouts keep their native settings).
- **Spend attribution:** scouts are attributed once to the owning member by exact registry ancestry (no double-billing from Hub progress or task-result totals); stateless eval `completion()`/`judge()` calls are billed through the calling session's journal (Main's other journaled auxiliary calls, such as composer predictions and labels, also count toward swarm spend). Any token-bearing request without a usable price fails closed under `OMP_SWARM_MAX_COST_USD`.

### Model & effort resolution

1. Omitting `model` and `effort` on `add` inherits the caller's live model and reasoning effort.
2. Resolution order for `model`: `@role[:effort]` alias → exact `provider/id` → exact bare `id` (prefers caller's provider if ambiguous) → trailing `:effort` split. Qualified specs never fuzzy-match.
3. Supported effort values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`auto` is rejected). Unsupported efforts for a model are clamped to the nearest supported level (or `off` for non-reasoning models) and reported in `notes`.
4. **Live switching (`swarm{action:"model"}`):** effort-only changes take effect immediately. Model changes apply at a run boundary (other workers must be `waiting` or `stopped`; coordinator self-switch schedules for the next turn boundary). Switching a failed worker clears its failure and resumes it where it left off; host model fallbacks are disabled so workers never silently switch models.

---

## Visualization UI

### Primary UI: Native TUI (`/swarm`)

Binds no network ports, is strictly read-only (nothing in `/swarm` moves any agent's read cursor), and stays keyboard-driven. `/swarm-ui` remains the separate optional web board.

- **Tern (TSP) vs. ANSI/SSH:** in Tern (terminals that negotiate the Tern Surface Protocol), `/swarm` (a fullscreen reactive `@oh-my-pi/pi-tui` `omp.swarm` page with `dock: 1`, a shared header showing title, mode, `#seq`, directory basename—full path in the coordinator's Members details—spend, and worker counts, a dock, and a hoisted modal help overlay on peers with `overlay` support, falling back to inline help with a Close button on reduced peers), the below-editor status widget, wake messages (`swarm-wake`), and web-board notices (`swarm-ui`) render as native semantic nodes with zero `rows` fallbacks and pointer support for tabs, lists, filters, paging, help, and search/jump inputs. Active search (`/`) and `#seq` jump inputs mount inside the focused `page` subtree (not `dock`), so Tern focuses them automatically on open and clears focus on close without losing page focus, with pointer/keyboard editing and `Esc`/`Enter` working cleanly. Main-session tool calls and results return `ExtensionRows`—compact one-line summaries in ANSI terminals while Tern keeps omp's full expandable tool cards. Plain terminals and ordinary SSH sessions (non-TSP peers) render `/swarm` (`≥ 24×6`), the status widget, and `swarm-wake`/`swarm-ui` notices via width-aware `<canvas>` rows.
- **Tabs:**
  - **1 Overview:** goal and outcome work threads, attention items, recent flagged screenshot captions (up to 8), and jump actions to the selected member or board post (Overview/header file info refreshes every 2 s; in native mode, timed waits format the saved deadline in the host locale without reading `Date.now()`).
  - **2 Board:** in native mode, selected post detail above the feed (with expand/collapse and sender link), filter toolbar, bounded 50-post feed with unread divider (leaving follow keeps the current window and slides at its edges; Older/Newer page explicitly), plus focused search (`/`) and `#seq` jump inputs in the page; in ANSI mode, visible post blocks lay out by available rows and expose filters via keys and the status line.
  - **3 Members:** grouped roster (coordinator, task workers/groups/helpers, narrator/monitor) with killed toggle (`K`), selected member facts, and **View transcript** (`Enter` / `t` in native; `t` in ANSI).
  - **4 Transcript:** read-only conversation history for live and historical members (newest-first, content-budgeted right after the member line in native, with paging moving the window; search typing/`Esc` keep your place), plus member cycling and follow. To watch a live worker in omp's native transcript instead: close `/swarm`, open `/hub`, press `1`, select the displayed registry ID (e.g., `swarm~parser`), and press `Enter`—or click its Tern Tray card (stopped, killed, and coordinator entries show no live-focus hint).

```text
/swarm [overview | board | members | transcript [name]]
```

In `rpc` mode, `/swarm` prints a compact text summary notification.

| Scope | Keys | Action |
|---|---|---|
| **Global** | `1`–`4`, `Tab` / `Shift-Tab` | Switch between Overview, Board, Members, Transcript |
| | `?` | Toggle keybindings help |
| | `q`, `Esc` | Close overlay (`Esc` first pops navigation back-stack or closes detail/search) |
| **1 Overview** | `↑` / `↓`, `Enter` | Select row; open member in Members (if a member) or jump to post in Board |
| **2 Board** | `↑` / `↓`, `PgUp` / `PgDn`, `Home` / `End` | Navigate posts |
| | `/`, `n` / `N` | Filter/search (`Enter` keeps, `Esc` clears); next/previous |
| | `#` `<digits>` `Enter`, `b` | Jump to `#seq` (suspends filters only if they exclude the target); `b` restores the snapshot taken at the first suspending jump |
| | `a` / `A`, `m`, `c`, `x` | Cycle author (`A` clears), cycle mention filter, cycle unique channels, clear all filters |
| | `f`, `u`, `Enter`, `o` | Toggle follow tail, select first post past coordinator cursor in the current filtered list, expand/collapse long post, open author in Members (if a member) |
| **3 Members** | `↑` / `↓`, `PgUp` / `PgDn` | Select member (native places the roster and selected card in a wrapping row that stacks on narrow panes; ANSI renders side-by-side at width ≥ 110 cols) |
| | `Enter`, `t`, `K` | Open transcript (native) or toggle detail view (ANSI), open transcript, toggle killed members |
| **4 Transcript** | `↑` / `↓`, `PgUp` / `PgDn`, `Home` / `End` | Page backwards/forwards across the full conversation branch |
| | `f`, `[` / `]`, `/`, `Esc` | Toggle follow, cycle member, search loaded items, go back |

### Native omp Agent Hub & Tern Tray (`/hub`)

Live workers (including `narrator` and `monitor`) register in omp's global `AgentRegistry` without writing any agent profiles (`~/.omp/agent/agents/` is never touched). In interactive sessions, they appear in `/hub` (subject to the persisted-root filter below) and in Tray on tray-capable native hosts such as Tern with agent display enabled (which may group settled members).

- **Native transcript focus & input:** open `/hub` → `1` (Agents) → select a member → `Enter` (or click its Tray card) to view the worker's live native omp transcript (`Esc` returns to Main when the composer is empty; otherwise it clears the draft first). Submitting sends live human input to the focused worker—steering an active run or starting an idle one.
- **Live activity:** Tray cards and Hub rows show live tool/activity updates; a worker parked in `swarm_wait` shows `waiting on board`.
- **Registry IDs:** new allocations and collision fallbacks use `swarm~<name>` (adding `~2`, `~3`, … only on collision), persisted in `members.json` and preferred on `revive` (an available persisted legacy ID is reused verbatim). The assigned ID is shown in Tray and Hub and returned as `agent_id` in `swarm{action:"add"}` and `swarm{action:"status"}` results.
- **Stop, exit, and `/clear`:**
  - Stopping a member from Hub (`x`) or Tray permanently **kills** it in the swarm: the fence engages at the native tombstone transition (Hub/Tray may await abort first), the coordinator receives one stop notice (unlike explicit `swarm{action:"kill"}`, which emits no stop notice), and preservation-first workspace WIP cleanup runs once stop is confirmed.
  - Normal session exit reloads non-killed members as `stopped`; `swarm{action:"revive"}` restarts members that have a valid recorded transcript and workspace (an interrupted launch that never recorded a session cannot be revived).
  - `/clear` keeps live workers running and preserves their registry refs and existing Hub/Tray visibility.
- **Limitations:**
  - A custom `OMP_SWARM_DIR` outside a persisted root session's artifact tree hides workers from the in-session Hub filter and excludes them from native subagent tree cost (durable swarm spend in `status`/`metrics.json` is unaffected; when the default `<Main artifacts>/swarm/sessions` directory is reached through a symlink such as `/home` → `/var/home`, worker transcript paths use Main's spelling when both resolve to that same physical directory, while custom paths keep their own spelling and stay subject to Hub's lexical filter). With `--no-session` (which falls back to a temp dir only when `OMP_SWARM_DIR` is unset), the Hub's root-file filter is disabled so workers remain visible, though file-backed worker refs do not contribute to native tree cost without a matching root.
  - After a restart, stopped workers stay hidden from Hub and Tray until revived with `swarm{action:"revive"}`.
  - Creating, forking, and reviving workers never overwrites the terminal's resume breadcrumb, so `omp --continue` (and auto-resume) follows omp's normal breadcrumb and recent-session rules rather than jumping to a worker transcript. If an older plugin version left the terminal's resume pointer on a worker transcript, resume the coordinator session once explicitly (`omp --resume <session id prefix>`) to reset it.
  - Live swarm workers are among the global registry's visible peers and can appear in `agent://all` broadcast receipts (workers disable both `enableIrc` and `task.crossInstance`, so they neither use IRC nor advertise cross-instance peers).
  - Headless (`print`/`json`) runs register globally too, but have no Hub or Tray UI.

### Optional Web Board (`/swarm-ui`)

Opt-in, read-only (`GET`-only; non-`GET` returns `405` with `Allow: GET`), and bound strictly to `127.0.0.1`. No HTTP server is created or port bound at load; start it with `/swarm-ui start` or `/swarm-ui open` (or `OMP_SWARM_UI=1`, which auto-starts once when a new or restored swarm attaches in interactive `tui`/`rpc` sessions, never in headless `print`/`json`).

```text
/swarm-ui [status | start [port] | open | stop]
```

- `status` (default): if running, triggers a brief toast (which may not show when idle) and re-posts the copyable transcript notice (immediately when idle, or when the active run ends); otherwise notifies that the web board is off.
- `start [port]`: starts the server on `127.0.0.1` (`port` defaults to `OMP_SWARM_UI_PORT`, or an ephemeral port if `0`), updates the TUI status widget below the editor immediately with the live `http://127.0.0.1:<port>/` URL (even mid-turn; native renders the full URL in a wrapping text node, while ANSI clips it only if the URL alone cannot fit; RPC has no widget), sends a brief toast (which may not appear when idle), and posts a persistent, copyable transcript notice (`customType: "swarm-ui"`, excluded from model context, no turn triggered; appears immediately when idle or when the active run ends) with the URL and remote-access commands. Auto-start via `OMP_SWARM_UI=1` announces the same way.
- `open`: starts if needed, announces the URL the same way, and makes a best-effort attempt to launch the host browser (`xdg-open` / `open`).
- `stop`: closes the listener and removes the URL from the status widget immediately (earlier transcript notices remain in history).

Because the URL is plain (`http://127.0.0.1:<port>/`, with no credentials), page reloads and bookmarks work while that address is listening. While running, the TUI status widget shows the full live URL (ANSI: `swarm · http://127.0.0.1:<port>/ · <title> · ●2 ○1 · #12 · /swarm`, dropping other segments before clipping the URL; native: wrapping text node with word counts such as `2 working · 1 waiting`; RPC has no widget), and `open_board` in `swarm{action:"add"}` and `swarm{action:"status"}` returns `http://127.0.0.1:<port>/` (otherwise `/swarm` in TUI and `""` in RPC/headless; `/swarm` remains available independently).

**Security model:**
There is no authentication: anyone who can reach the loopback port or a Tailscale Serve proxy exposing it can read the board, transcripts, and allowlisted files under `<swarm_dir>` (plus up to 4 optional `OMP_SWARM_UI_ROOTS`); use tailnet-only `tailscale serve`, never `tailscale funnel` (marked `Tailscale-Funnel-Request` `GET` requests return `403`, while non-`GET` requests return `405` first). To block DNS rebinding and cross-site reads, the server accepts only `GET` requests with a `Host` of `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` (a bare loopback `Host` is accepted only when listening on `http` port `80` or forwarded `https` port `443`), or `*.ts.net` (optional `:<port>`) (`421` otherwise) and, when `Origin` is present, a matching origin using `http` for direct loopback and `https` for MagicDNS hosts or `X-Forwarded-Proto: https` (`403` otherwise), serves no CORS headers, and sets strict CSP (`frame-ancestors 'none'; connect-src 'self'`), `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on `/api/*`.

**Remote access (Tailscale Serve or SSH):**
- **Tailscale Serve** (tailnet-only — never `tailscale funnel`, whose marked `Tailscale-Funnel-Request` `GET` requests return `403` and non-`GET` requests `405`; requires HTTPS enabled in your tailnet; `*.ts.net` hosts are accepted):
  ```sh
  tailscale serve <port>
  ```
  Runs in the foreground (`Ctrl+C` stops serving) and proxies `http://127.0.0.1:<port>` on default HTTPS port `443` at `https://<machine>.<tailnet>.ts.net`. Add `--bg` to persist in the background (`tailscale serve --bg <port>`) and optional `--https=<https-port>` to serve on another HTTPS port; to stop only that background serve without resetting other Serve entries, run `tailscale serve --https=443 off` (or `tailscale serve --https=<https-port> off`).
- **SSH port forwarding:**
  ```sh
  ssh -L <port>:127.0.0.1:<port> <host>
  ```
  Forward the **same** port locally (pinning `OMP_SWARM_UI_PORT=43123` makes the forward reusable across sessions), then open `http://127.0.0.1:<port>/` in your local browser.

---

## Workspaces

Each task worker's `workspace` mode defaults to `inherit`:

| Mode | Behavior | Requirements |
|---|---|---|
| `inherit` | Shares the adder's working directory (best for readers, verifiers, or disjoint single-owner files) | None |
| `share` | Creates a git worktree at `<swarm_dir>/workspaces/<name>` on branch `swarm/<sid>/<name>` from a snapshot of the adder's current working copy via a scratch index (leaves user's index, worktree, and stash untouched; includes tracked, untracked, and tracked-and-ignored files; excludes untracked ignored files, nested git repos, `<swarm_dir>`, and other worktrees) | Git repo with ≥ 1 commit, non-sparse checkout, clean submodules, untracked files ≤ `OMP_SWARM_SHARE_MAX_MB` and ≤ 20,000 files |
| `branch` | Creates a git worktree at `<swarm_dir>/workspaces/<name>` on branch `swarm/<sid>/<name>` from clean `HEAD` | Git repo with ≥ 1 commit |

Every git invocation runs with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and `-c core.hooksPath=/dev/null` (no shell).

**Landing changes:** authors commit on their branch (and never push or switch branches). Land their commits into your working copy with:

```sh
git cherry-pick <base>..<branch>
# or on a dirty working tree:
git diff --binary <base> <branch> | git apply --3way --index
```

**Preservation-first cleanup on `kill`:**
- The runtime never deletes branches or refs and never runs `push`, `merge`, `prune`, or `gc`.
- Before removing a worktree, `kill` verifies worktree identity and saves any uncommitted work to `refs/swarm/<sid>/<name>/wip` (and detached HEAD to `refs/swarm/<sid>/<name>/head` if not an ancestor of the branch).
- If `keep_workspace: true` is set, ignored files exist (unless `discard_ignored: true`), live `inherit` helpers still use the worktree, or any conflict/unmerged/staged-vs-worktree/nested-repo ambiguity is detected, the worktree is **retained**, reported in `kill.workspaces` with a cleanup command, and raises a `workspace_retained` notice (which the coordinator must read before `finish`).

---

## Bundled Skills

| Skill | Visibility | Audience | Purpose |
|---|---|---|---|
| `swarm` | Public (`skill://swarm`) | Coordinator | Full coordinator playbook: sizing, briefing, headless runs, model/effort control, workspaces, channels, addressing, waiting, restart revival |
| `swarm_pane` | Public (`skill://swarm_pane`) | Coordinator | Default Overview contract: `<swarm_dir>/plan.json` schema and `<swarm_dir>/shots/` screenshot timeline convention |
| `swarm_narrator` | `hide: true` | Injected into `role:"narrator"` | Narrator contract: `view.json`, optional sandboxed `view.html`, `prefs.md`, user defaults, and coordinator feedback relay |
| `swarm_monitor` | `hide: true` | Injected into `role:"monitor"` | Stall monitor contract: 180 s `swarm_wait` tick loop, stall diagnosis, repeat throttling, dormant mode, and restart resume |

---

## Configuration (Environment Variables)

All plugin tunables are read from `src/env.ts` at runtime startup:

| Variable | Default | Range / Format | Behavior |
|---|---|---|---|
| `OMP_SWARM_DIR` | `<session artifacts>/swarm` (or private temp dir with `--no-session`) | Absolute/relative directory path | Overrides where `board.jsonl`, `members.json`, `metrics.json`, `plan.json`, `view.json`, `sessions/`, `workspaces/`, `shots/`, and `owner.lock` live |
| `OMP_SWARM_UI` | unset (`off`) | `1` to enable | Auto-starts the loopback web board when a new or restored swarm attaches in `tui`/`rpc` sessions (never in headless `print`/`json`) |
| `OMP_SWARM_UI_PORT` | `0` (ephemeral) | Integer `0..65535` | Default port on `127.0.0.1` when `/swarm-ui start`, `/swarm-ui open`, or `OMP_SWARM_UI=1` starts the listener |
| `OMP_SWARM_UI_ROOTS` | unset | Colon-separated absolute paths (up to 4) | Extra canonical root directories permitted for web `/api/frame` and `/api/file` reads in addition to `<swarm_dir>` |
| `OMP_SWARM_MAX_WORKERS` | `24` | Integer `1..256` | Maximum concurrent non-killed members (excluding coordinator) |
| `OMP_SWARM_WORKER_TOOLS` | `read,bash,edit,write,glob,grep,eval,task,todo,web_search,lsp,ast_grep,ast_edit` | Comma-separated tool names | Built-in tool allowlist for task workers (intersected with main session's active tools; hard-excluded tools are always stripped) |
| `OMP_SWARM_GATE_MAX_REFUSALS` | `8` | Integer `1..1000` | Maximum headless stop-gate refusals without progress before declaring the run `incomplete` |
| `OMP_SWARM_GATE_WAIT_SECONDS` | `20` | Integer `1..25` | Seconds one headless `session_stop` call may wait for live workers before refusing and prompting `swarm_wait` |
| `OMP_SWARM_NO_PROGRESS_SECONDS` | `3600` | Integer `0..604800` (`0` disables) | Headless inactivity budget (seconds without worker progress while parked/gated) before declaring `incomplete` |
| `OMP_SWARM_DEADLINE_SECONDS` | `0` (disabled) | Integer `0..604800` | Headless monotonic wall-clock deadline across the entire run before declaring `incomplete` |
| `OMP_SWARM_SHARE_MAX_MB` | `200` | Integer `1..100000` | Maximum MB of untracked files copied into a `workspace: "share"` snapshot (file count cap: 20,000) |
| `OMP_SWARM_MAX_COST_USD` | `0` (disabled) | Non-negative number | Soft USD spend ceiling across all members (including native scouts, eval `completion()`/`judge()`, and Main's other journaled auxiliary calls). Once reached (or if token usage arrives without a usable price, failing closed with `spend.unknown`), no new members or non-coordinator wakes are admitted (an eligible TUI/RPC coordinator still receives reporting wakes both idle and mid-turn so it can wrap up), worker chat and other gated inference (including native result wakes and eval inference) plus native spawn admission are blocked, and headless runs become `incomplete`; omp's automatic compaction summaries, in-flight requests, and Main's reporting turns can still add cost. Main's native delegation (`task` / eval `agent()`) stays blocked while that capped swarm is registered, including after `finish` and after reopen; to resume delegation, restart without `OMP_SWARM_MAX_COST_USD` or switch to a session without that swarm. Under a ceiling, worker-owned scouts run on the main thread (session-scoped `task.workerThreads=0`) so each scout request checks an up-to-date ledger (without a ceiling, thread placement follows omp's defaults); Main keeps the operator's thread settings, so while new Main scout launches are blocked, an already-running Main scout on a worker thread can issue another auxiliary request before its prior bill reaches the ledger. Unknown spend persists across reopen; disabling the ceiling lets work continue without erasing the unknown-spend marker, and a fresh swarm starts a fresh capped ledger. A host cost-cap refusal records a `cost` failure with no automatic retry |

---

## Development, Testing & Evaluation

```sh
bun install

# Static typecheck
bun run typecheck

# Unit + integration suites (includes real-Chrome Playwright tests for /swarm-ui)
bun run test

# Real TUI PTY tests against a scripted mock provider
bun run test:pty

# Hermetic deterministic e2e scenarios against the real omp binary + scripted mock LLM
bun run test:e2e
# Filter to specific scenario IDs or keep temp dirs for inspection:
bun test/e2e/run.ts D0a D1 --keep

# Run the full deterministic verification suite (typecheck + test + test:pty + test:e2e)
bun run test:all

# Bump @oh-my-pi/* pins + SUPPORTED_HOST + README to the installed omp version, reinstall, and run test:all
bun run bump-omp
# Optional flags: bun run bump-omp 19.2.0 --dry-run | --no-test

# Channel-semantics oracle parity test vs upstream channels.mjs (500 generated boards)
AGY_SWARM_REF=/path/to/agy-swarm/plugins/swarm/sidecars/swarm_board \
  bun test test/unit/channels.test.ts

# Opt-in paid evaluation suite (spends real provider quota; default ceiling $15 / 90 min)
OMP_SWARM_PAID=1 bun run test:paid
# Optional overrides: OMP_SWARM_PAID_CEILING_USD=10 OMP_SWARM_PAID_MINUTES=45 bun test/e2e/run.ts --paid R1 R7
```

GitHub Actions CI (`.github/workflows/ci.yml`) runs the deterministic suites (typecheck, unit/integration, PTY, deterministic e2e, and loopback paid-harness self-tests) on pull requests and pushes to `main` against the compiled `omp` release matching `package.json`, with no provider secrets.

---

## Known Limits & Platform Notes

- **omp `19.2.1` target:** pinned and tested against `@oh-my-pi/pi-coding-agent` `19.2.1`; loading under another host version logs a warning on stderr.
- **Linux `/proc/self/fd` file containment:** `safeRead` (`src/ui/view-files.ts`) verifies opened regular-file descriptors via `/proc/self/fd/<fd>` after `O_NOFOLLOW` open so symlink swaps cannot escape `<swarm_dir>` or `OMP_SWARM_UI_ROOTS`. On non-Linux platforms this check fails closed (`unverifiable`), so `plan.json`, `view.json`, `view.html`, `/api/frame`, and `/api/file` reads are refused.
- **Explicit revival after restart:** after a process restart, non-killed members attach in `stopped` state and previous background jobs are not resumed. Board posts never auto-revive unattended agents; the coordinator must invoke `swarm{action:"revive"}` (exec-tier) to restart them and replay owed posts.
- **Private package & vendored frontend:** `web/vendor/` holds verbatim copies of Antigravity's swarm board frontend (`NOTICE.md`). `test/unit/static.test.ts` enforces both SHA-256 integrity and `"private": true` in `package.json`.
