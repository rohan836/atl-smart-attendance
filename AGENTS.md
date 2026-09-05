# AGENTS.md — Main agent instructions

This file is the first source of rules for any coding agent. Read it before changing code. It points to the right doc for each task.

Production release: `v1.2.0` (`bf575451`). Current `main`: Unified Attendance workspace (Today default + historical + single-student metrics + streaming CSV + Apply action) + Unified Setup (Global/Class/Batch scheduling + Month View) + Unified Backup Manager (Google Drive, Telegram, USB) with 116 backend tests + 14 Playwright E2E tests. Historical rollback tags: `v1.1.0` (`da89bdf`), `v1.0.1` (`32e5ef7`), `v1.0.0` (`c0fe411`). For new work, start from current `main`. Never modify historical release tags. See `docs/VERSIONS.md`.

## What this project is

Fingerprint kiosk:
- `ATL-Smart-Attendance-Production.html` = UI shell, markup, and CSS/layout — change here for visual redesign
- `backend/ui_app.js` = UI JavaScript behavior, state, events, and API interaction — change here for behavior
- `backend/app.py` = Flask backend/API; serves the HTML at `/` with `ui_app.js` injected via `_serve_production()` (`Cache-Control: no-store`)
- `backend/gt511c3.py` = fingerprint hardware driver (UART packet protocol)

`GT-511C3 UART → gt511c3.py → app.py Flask :5000 → SQLite` → HTML shell spliced with `ui_app.js`. Truth is sensor flash (200 slots) + SQLite. LocalStorage `atl_*` is cache only, omits photos. See `docs/PROJECT.md` and `docs/ARCHITECTURE.md` for UI layering. Redesign rule: HTML/CSS in the Production.html, behavior in `ui_app.js`; do not create `css/`/`js/`/`templates/`/component folders unless proven need.

## Which doc to read

| Task | Read |
|------|------|
| Understand product, non-goals | `docs/PROJECT.md` |
| Trace any end-to-end flow (load, scan, enroll, reconcile) | `docs/WORKFLOW.md` |
| Change Admin tabs or admin UX | `docs/ADMIN.md` |
| Change components, request flow, serve/splice/bridge | `docs/ARCHITECTURE.md` + `API.md` |
| Change tables, fields, validation, statuses, schedules | `docs/DATA_MODEL.md` + `API.md` |
| Safely modify code, add a feature | `docs/DEVELOPMENT.md` |
| Test or verify (unit/hardware/production) | `docs/TESTING.md` |
| Provision Pi, deploy, backup/restore/recover | `docs/OPERATIONS.md` |
| Follow standard workflow | `docs/AGENT_WORKFLOW.md` |

`API.md` is the endpoint contract. `README.md` is the short human entry point. Workflow: `docs/AGENT_WORKFLOW.md`.

## Repo and source of truth

- **Working dir:** `e:\sss` — do not probe other drives.
- **UI architecture:** `ATL-Smart-Attendance-Production.html` = shell/markup/CSS/layout; `backend/ui_app.js` = behavior/state/events/API; `backend/app.py` = serves HTML with `ui_app.js` injected at `_serve_production()`; `backend/gt511c3.py` = sensor driver. No working-tree backup HTML is kept — current production release is `v1.2.0` (`bf575451`); Git tags `v1.1.0`, `v1.0.1` and `v1.0.0` remain historical rollback points (see `docs/VERSIONS.md`). Theme `bg #FCFBF7 panel #F2F3F6 ink #181A20 ink-2 #6B6B6B ink-3 #A8A5A0 line #E9E6E0 paper #F6F4EF ok #2F5D34 danger #8A3A3A` + `Inter/Newsreader/ui-monospace`. Idle `PLACE YOUR FINGER` 11px 0.22em + `Admin` bottom-middle. No `css/ js/ templates/` unless proven need; keep simple architecture.
- **Stack:** `backend/app.py` + `backend/gt511c3.py` + `backend/schema.sql` + `backend/config.json` (`sensor real`, `uart /dev/serial0`, `baud 9600`, `db /var/lib/atl/attendance.db`, `host 0.0.0.0:5000`). Windows fallback `backend/attendance.db` + `backend/uploads/`. Template `backend/config.example.json`.
- **Structure:** `ATL-Smart-Attendance-Production.html` (prod) · `AGENTS.md README.md API.md` · `docs/*.md` · `assets/images/{admin,diagrams,students,ui}` · `backend/{app.py,gt511c3.py,gdrive_backup.py,schema.sql,config.example.json,requirements.txt,ui_app.js,test_app.py,test_ui_e2e.py}` · `pi/{setup.sh,atl-attendance.service}` · `tools/{deploy.ps1,deploy.sh,led_test.py}`

## How to run, deploy, verify

- **Local:** `python backend/app.py` → `http://127.0.0.1:5000/` · **Pi:** `http://192.168.1.8:5000/` · `sudo systemctl status atl-attendance` · `journalctl -u atl-attendance -f` · DB `/var/lib/atl/attendance.db`
- **Deploy:** `powershell -File tools/deploy.ps1` or `bash tools/deploy.sh` — never copies `attendance.db`, `config.json`, or `*.backup.html`
- **SSH:** `ssh -i C:\Users\LaNcer\.ssh\id_ed25519 lancer@192.168.1.8` (user `lancer`, not `pi`)
- **Verify:** `curl http://192.168.1.8:5000/` → title `ATL Smart Attendance Terminal — Complete School System`, `pane-backup` + `#FCFBF7`, spliced `ui_app.js`, no `__SSR_DATA__` · `curl /api/health` → `db_ok: true` (`sensor offline` expected when `sensor:real` without hardware) · Routes `/` + `/assets/<path>` + `/api/*`; unknown non-API paths serve UI; dead `/legacy|/terminal|/perfect|/css|/js` stay gone
- **Tests:** `python -m unittest backend.test_app -v` (116 backend unit tests) · `python -m unittest backend.test_ui_e2e -v` (14 Playwright E2E browser tests)

## UI design baseline — locked visual language (restyle only on explicit instruction)

- **Reference:** saved frosted reference image is canonical; approved direction = Weekly Schedule / dropdown / enrollment modal treatment.
- **Surfaces:** warm ambient background stays visible through the UI; subtle translucent/frosted neutral fills; 1px translucent white hairlines for structural separation only; no unnecessary card/window containers, no borders around every element, no heavy shadows/borders, no opaque white cards, no colored badges/status chips (orange/red belong to the ambient background, never to controls).
- **Controls:** text-first clickable actions; subtle frosted contained treatment only for genuinely important primary actions.
- **Type:** `var(--sans)` for normal interface text; `var(--mono)` only for dates, times, IDs, technical/numeric data; serif/editorial only for major titles where appropriate. Weight 400 normal / 500 important-active; avoid 600/700; soft, light, restrained; no excessive letter-spacing, no forced-everything-uppercase, no text shadows. Color hierarchy: primary white → secondary translucent white → tertiary softer translucent white.
- **Screenshot tasks:** compare the request against this baseline first, then modify only the specific element asked about; never invent a new style for an individual screen/component. Baseline stands unless the user explicitly orders a theme change.
- **Understand intent before implementing:** when the user points at a working pattern elsewhere in the UI ("like the tabs", "like the reference"), rebuild on that pattern's *architecture*, not a nearby approximation. Restate their mechanism in plain words; if it doesn't fit, say so before editing.
- **Project UI skill:** `skills/atl-frosted-ui/SKILL.md` holds the full enforceable version of this language (values, components, diagnoses, workflow, intent guide). Any coding agent doing UI work must read and follow it.
- **Canonical frost values:** `docs/UI_TOKENS.md` is the single source of truth (copied from the approved dropdown treatment). Copy values exactly — never approximate.
- **UI-change risk check (mandatory before any UI edit):** assess layout-shift risk first — dynamic text lengths, font-weight changes (400↔500 alters width), flex centering dependencies, scrollbar/overflow changes, and cross-tab/pane differences. Prefer shift-proof construction (fixed slots, absolute centering, uniform weights, reserved space) so switching states never moves surrounding UI.
- **Hard-won diagnoses (check these first):** milky modal = usually the overlay veil + blur stack, not the card fill (don't chase fill toward 0); ghost/doubled select text = a global `opacity:1` rule re-showing the native `<select>` hidden by the custom-dropdown system; tab-switch jumps = dynamic title lengths re-centering flex content + active-tab weight change. Verify with evidence (read the cascade, compare screenshots) before editing.

## Constraints — must not break

- **Scan:** active loop `POST /api/scan {waitSec:2}` runs on kiosk and in background while Admin is open (suppressing full-screen identity popup); pauses during enrollment (`enrollModal`/`scanModal`) and sensor maintenance (`reenroll`, `delete`, `restore`); bridge `GET /api/scan/last` every 2s; both call `window.handleRealScan`. `NO_FINGER/SENSOR_BUSY/UART` create no event. Enrollment one Start + 3 captures with lifts; progress via `GET /api/sensor/progress`. Keep `SENSOR_LOCK` and `keep_led_on=True`; `tools/led_test.py` diagnostic only.
- **Edit:** `ATL-Smart-Attendance-Production.html` = markup/CSS/layout; `backend/ui_app.js` = behavior/state/events/API. When redesigning UI: change HTML/CSS in the Production.html, change behavior in `ui_app.js` (do not edit HTML inline script block — it is replaced at serve time). Keep light-editorial UI frameless photo+fields. Do not create `css/`/`js/`/`templates/`/component folders unless proven need; keep simple architecture.
- **Settings:** `POST /api/settings` whitelist excludes `sensor/uart/baud/db/host/port/imagesDir` and `adminPin`. Holidays `YYYY-MM-DD[..YYYY-MM-DD]:type:name` where `type holiday|vacation|exam` (`exam`=working); validated via shared holiday parser.
- **Scheduling:** precedence `override → holiday/vacation/exam → weekly`; weekly per-student `Grade|Batch → batch → class → global`; default Sunday off Mon-Sat on.
- **Wiring:** VCC **3.3V pin1** never 5V, GND pin6, RX GPIO14/pin8, TX GPIO15/pin10, `/dev/serial0` 9600, `enable_uart=1`.
- **Artifacts never commit/deploy:** `__pycache__/ *.log *.db *.pre_restore.bak uploads/ .venv/ .env backend/config.json *gdrive_token.json` — template is `backend/config.example.json`.
- **Attendance:** `PRESENT ≤08:00`, `LATE` otherwise, `DUPLICATE` on same-day re-scan, `NOT_SCHEDULED` muted never absent, `ABSENT` generated only after `lateCutoff` with today guard `BEFORE_CUTOFF` via automated background daemon (`_reconcile_daemon`) or manual `POST /api/reconcile`.
- **Auth:** Admin PIN via `X-Admin-Pin` header only (no `?pin=` query); health never exposes `adminPin`; backup/restore/export/audit/correction/reconcile require PIN when configured, empty PIN preserves open behavior.
- **One task at a time.** After code, update docs. Check `docs/*.md` against `backend/app.py`, `gt511c3.py`, `schema.sql`, `ui_app.js` before finishing.
