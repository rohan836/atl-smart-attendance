# AGENT_WORKFLOW — Standard workflow for coding agents

Every agent must follow this workflow. It keeps changes small, verifiable, and production-safe.

## Workflow

1. **Read `AGENTS.md` first.** Entry point that maps tasks to docs.
2. **Identify the task and read only the relevant docs.** Use `AGENTS.md` table — `docs/PROJECT.md`, `WORKFLOW.md`, `ADMIN.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `DEVELOPMENT.md`, `TESTING.md`, `OPERATIONS.md`, plus `API.md` for endpoints. Do not load unrelated docs.
3. **Inspect the actual current code before assuming.** Read `backend/app.py`, `gt511c3.py`, `schema.sql`, `ui_app.js`, `ATL-Smart-Attendance-Production.html` as needed. Evidence before synthesis.
4. **Stay in Plan mode for investigation.** Explore and draft a plan without modifying files.
5. **Separate confirmed bugs from suspected issues.** Confirmed reproduces with a test or log; suspected needs verification.
6. **Give evidence, files, risks, tests, and rollback.** For each hypothesis state file/line, risk, covering test, and revert (`git tag v1.0.0`, `git revert`, or DB `.pre_restore.bak`).
7. **Wait for approval before Build.** Do not edit until plan is approved.
8. **Implement only approved scope.** One task at a time; no bundled features or refactors.
9. **Do not modify unrelated files or architecture.** Keep `ATL-Smart-Attendance-Production.html` (shell/CSS) + `backend/ui_app.js` (behavior). No `css/`/`js/`/`templates/`/components unless proven need.
10. **Add regression tests for bugs/features.** In `backend/test_app.py`; the fix should have failed before.
11. **Run the full test suite.** `python -m unittest backend.test_app -v` — all must pass.
12. **Review `git diff` and check for secrets or runtime data.** No `backend/config.json`, `*.db`, `*.pre_restore.bak`, `uploads/`, `assets/images/students/*`, `__pycache__/`, `*.log`, `.venv/`, `.env`. Confirm `git status` matches intent.
13. **Commit one logical change at a time.** Clear message, one concern per commit.
14. **Deploy only when explicitly required.** `powershell -File tools/deploy.ps1` or `bash tools/deploy.sh`; never `attendance.db` or `config.json`.
15. **Verify production after deploy.** `curl http://192.168.1.8:5000/api/health` (`db_ok:true`), `curl /` title + `__ATL_BRIDGE__`, `systemctl status atl-attendance`.
16. **Never claim hardware/browser/deployment testing not actually performed.** If Pi/sensor unreachable, say so.
17. **Update docs when behavior changes.** Keep `AGENTS.md` and `docs/*.md` consistent; docs are truth after code.
18. **Tag only after real verification.** `git tag -a vX.Y.Z -m "..."` after health and manual Pi checks pass.

## Definition of Done

A task is done only when:

- Requested behavior works as specified
- Tests pass (`38/38` or current suite) and new regression coverage exists
- Documentation is accurate and the relevant `docs/*.md` were updated
- No unrelated changes are in the diff
- Git diff was reviewed and no secrets or runtime data are included
- Deployment impact is understood (or deployment was verified)
- Real hardware was verified when the change touches sensor, Pi, or deployment

If any item is not met, the task is not done.
