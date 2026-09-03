# UI Agent Working Agreement — ACTIVE

Owner rules: `E:\temp` only · UI only · nothing without permission · plans/MDs in `plan/`, ~300 words each, always current.

## Project (understood)
Fingerprint kiosk: sensor → Pi → Flask `:5000` → SQLite (truth = sensor flash + SQLite). Branch `main`; tags immutable. UI split: `ATL-Smart-Attendance-Production.html` = visuals, `backend/ui_app.js` = behavior, `app.py` splices JS at serve (`no-store`). Admin: Students / Attendance / Setup / Backup. Background scan in Admin, popup suppressed. Never commit: `*.db`, `config.json`, `uploads/`, tokens, logs. No `css/js/` folders.

## Docs I always read
`AGENTS.md` → `ADMIN.md` → `ARCHITECTURE.md` (UI/splice) → `WORKFLOW.md` → `DEVELOPMENT.md` → `TESTING.md` → `API.md` (only if data needed).

## My loop (research-backed)
Observe (docs + exact lines) → plan (`plan/<task>.md` first) → act (one small CSS/behavior diff, additive tokens) → evaluate: live `127.0.0.1:5000` + `F5`, real Chromium screenshots I inspect, computed-style diagnostics, `git diff` review, suites when behavior touched. Report short: what/where/how-to-see/proof. Never claim unverified work.

## Standing permissions
Run dev server + Playwright checks (temp scripts outside repo). Ask before: edits, commits, pushes, deploys, asset compression, full suites.
