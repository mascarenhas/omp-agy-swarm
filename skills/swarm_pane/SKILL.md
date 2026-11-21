---
name: swarm_pane
description: >-
  What the coordinator writes so the swarm's Overview (/swarm and /swarm-ui)
  shows the goal, outcome-based work threads, and a screenshot timeline. Load
  before briefing and adding the first workers to a swarm.
---

# The swarm's Overview

Both the terminal Overview (`/swarm`) and the optional web board (`/swarm-ui`)
build their Overview directly from the board and roster. Two small things from
you make it read well: a plan file, and screenshots your workers flag.

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

## Screenshots for the timeline

When the user asked for a change they can see (UI, layout, visuals), tell each
worker who captures screenshots, in its brief, to flag each meaningful step on
its own line of a board post:

```
Screenshot: <absolute path> | what changed, at most 10 words
```

- Save screenshots under `<swarm_dir>/shots/` as `.png`, `.jpg`, `.jpeg`, or
  `.webp` (≤ 8 MB each); the UI refuses paths outside `<swarm_dir>` (unless
  explicitly allowlisted in `OMP_SWARM_UI_ROOTS`).
- Keep the same screen, window size, and theme across shots so frames align;
  prefer full windows, never crops or diffs.
- `/swarm` lists recent flagged screenshots with their `#seq` and caption;
  `/swarm-ui` renders an interactive progress reel once at least two frames are
  flagged (up to 24 frames).
- Skip this for backend, infra, data, or docs work.
