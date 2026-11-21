# omp-agy-swarm

An Antigravity-style multi-agent swarm extension for [omp](https://omp.sh) **19.0.1**: parallel worker agents, each in its own isolated conversation, collaborating through one append-only shared message board.

- **In-process workers, zero persistent agent profiles:** workers run as restricted `createAgentSession` instances in a per-swarm private `AgentRegistry` (`~/.omp/agent/agents/` is never touched; worker transcripts stay under `<swarm_dir>/sessions/`).
- **Full per-worker model and exact reasoning effort control:** inherit the coordinator's model and effort by default, or pin any runnable `provider/id` and exact effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — never `auto`) with live boundary model switching, immediate effort-only switching, and no silent fallback downgrades.
- **SSH-first native TUI (`/swarm`) + opt-in local web board (`/swarm-ui`):** `/swarm` provides four keyboard-driven views (Overview, Board, Members, Transcript) plus a live status widget under the editor with **zero open network ports**. `/swarm-ui` starts a read-only loopback web board only when explicitly requested.
- **First-class headless (`omp -p`) execution:** stop-gate, stall/quiescence detection, spend ceilings, monotonic deadlines, and durable `metrics.json` outcomes.
- **Private personal repository:** `"private": true` in `package.json`; see [`NOTICE.md`](./NOTICE.md) for the provenance and SHA-256 verification of the vendored Antigravity web frontend files.

---

## Installation & Loading

Requires **omp `19.0.1`** (`@oh-my-pi/pi-coding-agent: 19.0.1`), **Bun**, and **git** (for `share`/`branch` workspaces).

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

- A single-line status widget appears below the editor (`swarm · <title> · ●2 ○1 · #12 · /swarm`).
- Run `/swarm` at any time to open the full-screen terminal board (or `/swarm board`, `/swarm members`, `/swarm transcript <name>`).
- Optionally run `/swarm-ui start` to spin up the loopback web board and get a one-time private link.

### Headless (`omp -p`)

```sh
omp -p "Read skill://swarm. Add two workers to implement and test feature X, verify their diff, then finish." \
  --mode json \
  --no-extensions -e /path/to/omp-agy-swarm
```

In headless runs (`print` and `json` modes):
- `swarm{action:"add"}` and `swarm{action:"status"}` report `mode: "headless"` and `open_board: ""`.
- The coordinator stays in `swarm_wait` while workers run; premature turn stops while task workers are live or posts/notices are unread are refused by the stop-gate.
- The coordinator finishes via `swarm{action:"finish", summary:"…"}` (or posting `[done] <summary>` with no `@mentions`) and then prints its final answer.
- Outcomes (`complete`, `complete_with_abandonment`, `quiescent_no_done`, `incomplete`, `coordinator_failed`, `aborted`), swarm-level `spend` (`{ tokens, cost, ceiling, unknown? }`), and per-member token/USD spend are written atomically to `<swarm_dir>/metrics.json`.

---

## Tools Reference

### `swarm` actions

| Action | Key parameters | Purpose | Approval tier | Who can call |
|---|---|---|---|---|
| `status` | — | Swarm state, mode, `swarm_dir`, `open_board`, `completion`, `outcome`, swarm-level `spend` (`{ tokens, cost, ceiling, unknown? }`), `attention`, and per-member status/cursors/owed/spend | `read` | Coordinator, workers |
| `models` | `query?`, `provider?`, `limit?` (1..100, default 40) | Lists runnable models, supported `efforts`, context window, and per-provider `quota` summary | `read` | Coordinator, workers |
| `add` | `name?`, `brief?`, `model?`, `effort?`, `tasks?` (1..16), `n?` (2..16), `fork?`, `workspace?`, `channels?`, `role?` (`worker`\|`narrator`\|`monitor`) | Starts a worker, numbered group (`<name>-1..k`), or singleton role worker (`narrator`/`monitor`) and posts its brief | `exec` | Coordinator (any role); workers (`worker` helpers up to depth 2) |
| `model` | `name?`, `model?`, `effort?` | Changes a member's (or caller's) model and/or reasoning effort while keeping its conversation | `write` | Coordinator (anyone); workers (self or own helpers) |
| `kill` | `name`, `discard_ignored?`, `keep_workspace?` | Permanently stops a member (or group) and runs preservation-first worktree cleanup | `exec` | Coordinator (any non-coordinator); workers (own helpers) |
| `revive` | `name?` | Revives stopped members after a restart (omit `name` to revive all stopped members with owed posts) and replays owed posts | `exec` | Coordinator (any non-coordinator); workers (own helpers) |
| `finish` | `summary` (≤ 2,000 chars, no `@`), `abandon?` | Marks the swarm `[done]`; refuses while work is live or unread unless `abandon: true` cancels remaining work | `exec` | Coordinator only |
| `title` | `title` (≤ 80 chars) | Sets the swarm's title | `write` | Coordinator only |
| `channel` | `op` (`create`\|`list`\|`subscribe`\|`unsubscribe`\|`archive`), `channel?`, `topic?`, `name?` | Manages topic channels (`main` is always visible to everyone) | `read` (`list`), `write` (others) | `list`: coordinator & workers; `create`/`archive`: coordinator only; `(un)subscribe`: coordinator (anyone) or worker (self/own helpers) |

### Board & waiting tools

- **`post_message{text, channel?}`** (`write`): posts 1..8,000 characters to `channel` (default: caller's first channel, else `main`). Begin with `@name`, `@group-prefix`, `@#channel`, or `@all` (`@#main` is refused). Returns `seq`, `channel`, `mentions`, `all`, `channel_mentions`, `woke`, plus `unknown_mentions` and `stopped` (with a `revive` hint) when relevant. Disabled for `narrator`.
- **`read_board{since?, limit?, channel?, status?}`** (`read`): reads up to `limit` posts (1..200, default 50, capped at 48 KB per page) after `since` (default: caller's read cursor; own-view reads never skip unread posts). Pass `channel: "<name>"` for one channel or `"*"` for all. Pass `status: true` to return member states, `detail`, `wake_mode`, `wait_since`, `wait_until`, `last_read_seq`, `channels`, `last_post_seq`/`last_post_time`, and `error` instead of posts.
- **`swarm_wait{since?, mentions_only?, timeout_seconds?}`** (`read`, interruptible, exclusive): sleeps for free until a matching post (`mentions_only: true` default; `false` for any visible post), a notice, a stall/incomplete signal, or `timeout_seconds` (1..86,400) arrives.
  - **Call position:** must be the **last** tool call of a response in the coordinator (main session), and the **only** tool call of a response in workers (otherwise returns `woke: "not_parked"`).
  - **Server-side cursor:** `since` is advisory; the runtime advances a member's read cursor only after the host confirms receipt of the delivered message or tool result.
  - **Wake reasons (`woke`):** `post`, `notice`, `timeout`, `stall`, `incomplete`, `nudge`, `switch`, `not_parked`, `interrupted`, `aborted`, `killed`, `closing`, `no_swarm`.

### Role tool sets & permissions

- **Coordinator (main session):** full access to all 4 swarm tools (with main-session approval tiers above) and all main-session tools.
- **Task worker (`role: "worker"`):** all 4 swarm tools + `OMP_SWARM_WORKER_TOOLS` (default: `read, bash, edit, write, glob, grep, eval, todo, web_search, lsp, ast_grep, ast_edit`), intersected with the main session's active tools. Hard-excluded tools (`task`, `wait`, `manage_skill`, `new_context`, `yield`, `irc`, `async`, `job`) are always stripped, and auto-backgrounding is disabled inside worker sessions.
- **Narrator (`role: "narrator"`):** `read_board`, `swarm_wait`, plus `read, write, edit, bash, glob, grep` (intersected with active tools). Has no `post_message` and no `swarm` tool.
- **Monitor (`role: "monitor"`):** `read_board`, `swarm_wait`, `post_message` only (no `swarm`, no filesystem/shell/cron tools).

### Model & effort resolution

1. Omitting `model` and `effort` on `add` inherits the caller's live model and reasoning effort.
2. Resolution order for `model`: `@role[:effort]` alias → exact `provider/id` → exact bare `id` (prefers caller's provider if ambiguous) → trailing `:effort` split. Qualified specs never fuzzy-match.
3. Supported effort values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`auto` is rejected). Unsupported efforts for a model are clamped to the nearest supported level (or `off` for non-reasoning models) and reported in `notes`.
4. **Live switching (`swarm{action:"model"}`):** effort-only changes take effect immediately. Model changes apply at a run boundary (other workers must be `waiting` or `stopped`; coordinator self-switch schedules for the next turn boundary). Switching a failed worker clears its failure and resumes it where it left off; host model fallbacks are disabled so workers never silently switch models.

---

## Visualization UI

### Primary UI: Native TUI (`/swarm`)

Works directly over SSH and in any terminal (`≥ 24×6`), binds no network ports, and is strictly read-only (nothing in `/swarm` moves any agent's read cursor).

```text
/swarm [overview | board | members | transcript [name]]
```

In `rpc` mode, `/swarm` prints a compact text summary notification.

| Scope | Keys | Action |
|---|---|---|
| **Global** | `1`–`4`, `Tab` / `Shift-Tab` | Switch between Overview, Board, Members, Transcript |
| | `?` | Toggle keybindings help |
| | `q`, `Esc` | Close overlay (`Esc` first pops navigation back-stack or closes detail/search) |
| **1 Overview** | `↑` / `↓`, `Enter` | Select row; open member in Members or jump to post in Board |
| **2 Board** | `↑` / `↓`, `PgUp` / `PgDn`, `Home` / `End` | Navigate posts |
| | `/`, `n` / `N` | Filter/search (`Enter` keeps, `Esc` clears); next/previous |
| | `#` `<digits>` `Enter`, `b` | Jump to `#seq` (temporarily suspends filters); `b` restores filters |
| | `a` / `A`, `m`, `c`, `x` | Cycle author (`A` clears), cycle mention filter, cycle channel, clear all filters |
| | `f`, `u`, `Enter`, `o` | Toggle follow tail, jump to first unread past coordinator cursor, expand/collapse long post, open author in Members |
| **3 Members** | `↑` / `↓`, `PgUp` / `PgDn` | Select member (detail renders side-by-side at terminal width ≥ 110 cols) |
| | `Enter`, `t`, `K` | Toggle detail view, open transcript, toggle killed members |
| **4 Transcript** | `↑` / `↓`, `PgUp` / `PgDn`, `Home` / `End` | Page backwards/forwards across the full conversation branch |
| | `f`, `[` / `]`, `/`, `Esc` | Toggle follow, cycle member, search loaded items, go back |

### Optional Web Board (`/swarm-ui`)

No HTTP server is created or port bound until you opt in via `/swarm-ui start` (or `OMP_SWARM_UI=1` in an interactive `tui`/`rpc` session).

```text
/swarm-ui [status | start [port] | open | stop]
```

- `status` (default): reports whether the server is running and on which port.
- `start [port]`: starts the read-only server on `127.0.0.1` (`port` defaults to `OMP_SWARM_UI_PORT`, or an ephemeral port if `0`) and displays a one-time private link.
- `open`: starts if needed, prints a fresh private link, and launches the local browser (`xdg-open` / `open`).
- `stop`: closes the server immediately and invalidates all active tokens and links.

**Security model:**
- Binds strictly to `127.0.0.1` (never `0.0.0.0`).
- Rejects mismatched `Host` (`421`) and cross-origin `Origin` (`403`) headers; sends strict CSP (`frame-ancestors 'none'; connect-src 'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on API routes.
- **No cookies and no URL-query tokens:** the one-time 5-minute `#token=` fragment is stripped immediately by `web/preload.js` (`history.replaceState`) and exchanged via `POST /api/session` for an in-memory per-tab `Authorization: Bearer` token (up to 8 concurrent tabs). Frame images are fetched with the bearer header and rendered via revoked `blob:` URLs.
- **Confined file serving:** `/api/frame` and `/api/file` serve only allowlisted paths verified against `<swarm_dir>` (plus up to 4 optional `OMP_SWARM_UI_ROOTS`).

**Remote SSH / Tailscale access:**
Because the server binds `127.0.0.1` and enforces `Host: 127.0.0.1:<port>`, forward the **same** port locally over SSH (or over a Tailscale SSH tunnel):

```sh
ssh -L <port>:127.0.0.1:<port> <host>
```

Pinning `OMP_SWARM_UI_PORT=43123` makes the local port-forward reusable across sessions. Then open the printed `http://127.0.0.1:<port>/#token=…` link in your local browser.

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
| `OMP_SWARM_UI` | unset (`off`) | `1` to enable | Auto-starts the loopback web board on swarm creation in `tui`/`rpc` sessions (never in headless `print`/`json`) |
| `OMP_SWARM_UI_PORT` | `0` (ephemeral) | Integer `0..65535` | Default port on `127.0.0.1` for `/swarm-ui start` and `OMP_SWARM_UI=1` |
| `OMP_SWARM_UI_ROOTS` | unset | Colon-separated absolute paths (up to 4) | Extra canonical root directories permitted for web `/api/frame` and `/api/file` reads in addition to `<swarm_dir>` |
| `OMP_SWARM_MAX_WORKERS` | `24` | Integer `1..256` | Maximum concurrent non-killed members (excluding coordinator) |
| `OMP_SWARM_WORKER_TOOLS` | `read,bash,edit,write,glob,grep,eval,todo,web_search,lsp,ast_grep,ast_edit` | Comma-separated tool names | Built-in tool allowlist for task workers (intersected with main session's active tools; hard-excluded tools are always stripped) |
| `OMP_SWARM_GATE_MAX_REFUSALS` | `8` | Integer `1..1000` | Maximum headless stop-gate refusals without progress before declaring the run `incomplete` |
| `OMP_SWARM_GATE_WAIT_SECONDS` | `20` | Integer `1..25` | Seconds one headless `session_stop` call may wait for live workers before refusing and prompting `swarm_wait` |
| `OMP_SWARM_NO_PROGRESS_SECONDS` | `3600` | Integer `0..604800` (`0` disables) | Headless inactivity budget (seconds without worker progress while parked/gated) before declaring `incomplete` |
| `OMP_SWARM_DEADLINE_SECONDS` | `0` (disabled) | Integer `0..604800` | Headless monotonic wall-clock deadline across the entire run before declaring `incomplete` |
| `OMP_SWARM_SHARE_MAX_MB` | `200` | Integer `1..100000` | Maximum MB of untracked files copied into a `workspace: "share"` snapshot (file count cap: 20,000) |
| `OMP_SWARM_MAX_COST_USD` | `0` (disabled) | Non-negative number | Soft USD spend ceiling across all members; once reached (or if token usage arrives without a usable price, failing closed with `spend.unknown`), no new members or wakes are admitted and headless runs become `incomplete` (in-flight requests may finish). A host cost-cap refusal records a `cost` failure with no automatic retry |

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

# Channel-semantics oracle parity test vs upstream channels.mjs (500 generated boards)
AGY_SWARM_REF=/path/to/agy-swarm/plugins/swarm/sidecars/swarm_board \
  bun test test/unit/channels.test.ts

# Opt-in paid evaluation suite (spends real provider quota; default ceiling $15 / 90 min)
OMP_SWARM_PAID=1 bun run test:paid
# Optional overrides: OMP_SWARM_PAID_CEILING_USD=10 OMP_SWARM_PAID_MINUTES=45 bun test/e2e/run.ts --paid R1 R7
```

---

## Known Limits & Platform Notes

- **omp `19.0.1` target:** pinned and tested against `@oh-my-pi/pi-coding-agent` `19.0.1`; loading under another host version logs a warning on stderr.
- **Linux `/proc/self/fd` file containment:** `safeRead` (`src/ui/view-files.ts`) verifies opened regular-file descriptors via `/proc/self/fd/<fd>` after `O_NOFOLLOW` open so symlink swaps cannot escape `<swarm_dir>` or `OMP_SWARM_UI_ROOTS`. On non-Linux platforms this check fails closed (`unverifiable`), so `plan.json`, `view.json`, `view.html`, `/api/frame`, and `/api/file` reads are refused.
- **Explicit revival after restart:** after a process restart, non-killed members attach in `stopped` state. Board posts never auto-revive unattended agents; the coordinator must invoke `swarm{action:"revive"}` (exec-tier) to restart them and replay owed posts.
- **Headless native-async exclusion:** do not mix native omp background jobs or `task` subagents with a headless swarm run. The swarm stop-gate cannot coordinate with native async work and records `native_async_mix: true` in `metrics.json`.
- **Private package & vendored frontend:** `web/vendor/` holds verbatim copies of Antigravity's swarm board frontend (`NOTICE.md`). `test/unit/static.test.ts` enforces both SHA-256 integrity and `"private": true` in `package.json`.
