---
name: swarm_pane
description: >-
  What the coordinator writes so the swarm's Overview (/swarm and /swarm-ui)
  shows the goal, outcome-based work threads, Markdown progress updates, and
  screenshots. Load before briefing and adding the first workers to a swarm.
---

# The swarm's Overview

Both the terminal Overview (`/swarm`) and the optional web board (`/swarm-ui`)
build their Overview directly from the board and roster. Two small things from
you make it read well: a plan file, and concise progress updates (text/Markdown
and, for visual work, screenshots) posted to the board.

Do not add a narrator; this Overview is the default and replaces it. Add
`role:"narrator"` only when the user asks for a narrated or custom Overview.

## Write the plan

Once the workers are added, write `<swarm_dir>/plan.json` (`swarm_dir` is
returned in every `swarm{action:"add"}` and `swarm{action:"status"}` result):

```json
{
  "goal": {
    "title": "Fix Hub split pane layouts",
    "line": "Audit, fix, then verify in both themes."
  },
  "tasks": {
    "auditor": "Audit split panes across states",
    "fixer": "Put split panes in one card"
  },
  "threads": [
    {
      "id": "t-split",
      "title": "Split pane cards",
      "goal": "Panes share one card with clean headers.",
      "tasks": ["auditor", "fixer"]
    }
  ]
}
```

- `goal.title` is 4 to 8 words and `goal.line` is at most 12 words.
- `tasks` maps each worker's roster name to its piece in a few words.
- `threads` are 1 to 6 groups organized by the outcome they deliver, never by
  agent, and every task worker sits in one (`tasks` lists worker roster names).
- Keep `plan.json` under 64 KB. Write atomically (`plan.json.tmp` then rename
  over `plan.json`) when possible; the UI keeps the last valid parse if it
  reads invalid JSON.
- Rewrite the file only when you add workers, move work, or the goal changes.
  Status, blockers, and asks come from the board, so never put them here.

## Progress updates (Markdown)

Post concise Markdown status updates to the board's Progress carousel at key
milestones (initial kickoff, phase completions, test/verification results,
resolved blockers, and final summary). Both the **coordinator** and **task
workers** can post progress updates, and they work for every kind of swarm
(backend, infra, data, docs, or UI).

Start a line with `Progress:` (either as its own post with no `@mentions`, so
it updates the Overview without waking mention-mode workers, or at the end of a
board post):

```markdown
Progress: Phase 1 complete — parser and lexer green
- **lexer**: 18/18 unit tests passing (#4)
- **parser**: 24/24 unit tests passing (#6)
- Next: verifier auditing both diffs
```

A single-line update works too:

```markdown
Progress: Verification green — all 42 tests and typecheck pass (#9)
```

- Put the short headline (≤ 90 chars) on the `Progress:` line and optional
  Markdown details (lists, bold/italic, inline or fenced code, tables) below
  it; keep each update concise (≤ 2,000 characters).
- Omit `@` before member names in standalone status updates (board addressing
  scans raw text, including inline code; note that a narrator or member parked
  with `mentions_only: false` still sees every post).
- Do not put a literal `Progress:` or `Screenshot:` example outside a fenced
  code block inside a worker's initial `add` brief.
- Both `/swarm` and `/swarm-ui` show updates immediately from the first entry
  (`/swarm` lists the latest 8; `/swarm-ui` keeps up to 24 in the interactive
  Progress carousel, interleaved chronologically with screenshots).

## Screenshots for the timeline

When the user asked for a change they can see (UI, layout, visuals), flag
screenshots (from workers or the coordinator) on their own line of a board post:

```
Screenshot: <absolute path> | what changed, at most 10 words
```

- Save screenshots under `<swarm_dir>/shots/` as `.png`, `.jpg`, `.jpeg`, or
  `.webp` (≤ 8 MB each); the UI refuses paths outside `<swarm_dir>` (unless
  explicitly allowlisted in `OMP_SWARM_UI_ROOTS`).
- Keep the same screen, window size, and theme across shots so frames align;
  prefer full windows, never crops or diffs.
- `/swarm` lists the latest 8 progress updates and flagged screenshots with
  their `#seq`, author, and summary; `/swarm-ui` renders up to 24 in the
  interactive Progress carousel.
- Skip screenshots for backend, infra, data, or docs work — use Markdown
  `Progress:` updates instead.
