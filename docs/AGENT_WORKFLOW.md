# AGENT_WORKFLOW — Standard workflow for coding agents

Every agent must follow this workflow. It keeps changes small, verifiable, and production-safe.

## Workflow

1. **Read `AGENTS.md` first.** Entry point that maps tasks to docs.
2. **Inspect the repository and relevant docs.** Use the `AGENTS.md` table to consult only relevant docs (`docs/PROJECT.md`, `WORKFLOW.md`, `ADMIN.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `DEVELOPMENT.md`, `TESTING.md`, `OPERATIONS.md`, or `API.md`). Read active code in `backend/app.py`, `gt511c3.py`, `gdrive_backup.py`, `schema.sql`, `ui_app.js`, or `ATL-Smart-Attendance-Production.html` as needed.
3. **Understand the task.** Clarify requirements, identify target files and line ranges, and understand system constraints before editing.
4. **Implement directly.** Make the requested changes cleanly within the existing architecture: HTML/CSS in `ATL-Smart-Attendance-Production.html`, behavior/events in `backend/ui_app.js`, backend/API in `backend/app.py`. Do not create extraneous files or component directories unless proven necessary.
5. **Add or update tests.** For bug fixes or new features, add or update covering tests in `backend/test_app.py` (unit) and/or `backend/test_ui_e2e.py` (Playwright E2E).
6. **Run the test suites.** Run `python -m unittest backend.test_app -v` and `python -m unittest backend.test_ui_e2e -v` to confirm zero regressions.
7. **Review `git diff`.** Verify that changes are minimal and focused. Ensure no secrets, machine configs, or runtime artifacts (`backend/config.json`, `*gdrive_token.json`, `*.db`, `*.pre_restore.bak`, `uploads/`, `__pycache__/`, `*.log`, `.venv/`, `.env`) are staged.
8. **Update documentation.** Keep `AGENTS.md` and `docs/*.md` synchronized whenever behavior, constraints, endpoints, or test counts change. Docs are truth after code.
9. **Commit and push.** Commit one logical concern at a time with a clear, descriptive message, then push to `origin/main`.
10. **Deploy and verify when requested.** When deployment to the Raspberry Pi is requested, deploy via `powershell -File tools/deploy.ps1` or `bash tools/deploy.sh` and verify service status, `/api/health`, and live terminal functionality on `192.168.1.8`. Never claim verification that was not actually performed.

## Definition of Done

A task is done only when:

- Requested behavior works as specified
- Tests pass (`116/116` backend + `14/14` Playwright or current suite) and new regression coverage exists
- Documentation is accurate and the relevant `docs/*.md` were updated
- No unrelated changes are in the diff
- Git diff was reviewed and no secrets or runtime data are included
- Deployment impact is understood (or deployment was verified)
- Real hardware was verified when the change touches sensor, Pi, or deployment

If any item is not met, the task is not done.
