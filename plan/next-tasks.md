# Next Tasks — QUEUE (1+2 DONE 2026-09-03, see `glass-confirm.md`)

What we need to build, in suggested order. Nothing started below; each needs owner approval.

## 1. Custom glass confirm (replaces OS grey boxes)
Delete-student, cloud/USB restore, disconnects use native `confirm()/alert()` — grey OS windows now the most off-vibe element left. Build one glass confirm modal (title + message + danger/safe actions, promise-based) and swap call sites. Risk: touches `ui_app.js` flows + E2E dialog handlers (`page.once("dialog")` → rewrite to click glass buttons). Medium task.

## 2. Compress `glass-bg.png` (4.9MB → ~300KB JPG)
Fine locally, slow on Pi 3 + per-load cost. Convert to quality-80 JPG, swap URL, screenshot-compare. Needs permission (binary asset change).

## 3. Setup static inputs underline-style
`setSchoolName`, timing, backup schedule inputs still boxed white. Same modal-field treatment. Small CSS-only task.

## 4. Commit + push UI work
Uncommitted: Production.html, `ui_app.js`, `glass-bg.png`, `plan/`. Decide: commit `plan/` or gitignore it? Then push `main`. Needs explicit approval per rules.

## Status
Background, dropdowns, toolbar, photo, glass confirm, asset compression: DONE (see sibling MDs). Open: Setup inputs (#3), commit+push (#4). Waiting on owner pick.
