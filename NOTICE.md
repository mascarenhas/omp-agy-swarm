# NOTICE

This repository is private and for personal use (`"private": true` in `package.json`).

## Vendored Antigravity frontend files

The files under `web/vendor/` are verbatim copies of Google Antigravity's swarm board sidecar
frontend (`agy-swarm/plugins/swarm/sidecars/swarm_board/`). They are not modified; the omp adapter
code (`web/index.html`, `web/preload.js`, `web/omp-bridge.js`, `web/omp-bridge.css`) wraps them.
A unit test (`test/unit/static.test.ts`) checks the hashes below and fails the build if the package
ever loses `"private": true` while `web/vendor/` exists. A public release needs clearance or a
clean-room frontend.

| File | SHA-256 |
|---|---|
| `web/vendor/app.js` | `4be222865680ea64bb19510966b747815e75f29ebe82b199a0280d34822697be` |
| `web/vendor/hive.js` | `ae5308ed8040d8cd2fd74b73f3ab03d706bb872f170a7c38bd5984a8bd525116` |
| `web/vendor/styles.css` | `5752c74d5aecd40945552836025a6a28e7543e7c084586bfa0acfcd045f408c3` |
| `web/vendor/hive.css` | `ab7cb22e297be62a7a817a0c420cb470122c766abf44a3319b875ec754ad2f42` |
| `web/vendor/narrator_bootstrap.js` | `1a31f8c2f623a0f05eccccc588d9fabb0a6bc088ca77caf3806ce1854c41c4a7` |

`web/index.html` is an adapted copy of the upstream `index.html`: the Google Fonts links are
removed, `omp-bridge.css` and `omp-bridge.js` are added, and a notice, theme toggle and drawer
container are appended. `src/board/channels.ts` is a typed port of the upstream `channels.mjs`
(same names and semantics); an oracle test compares the two when `AGY_SWARM_REF` points at the
upstream sidecar directory.

The skill texts under `skills/` are adapted from Antigravity's `native_swarm`, `swarm_pane`,
`swarm_narrator` and `swarm_monitor` skills.
