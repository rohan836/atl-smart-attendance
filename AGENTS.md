# AGENTS.md — Main agent instructions

This file is the first source of rules for any coding agent. Read it before changing code. It points to the right doc for each task.

## What this project is

Fingerprint kiosk: `GT-511C3 UART → backend/gt511c3.py → backend/app.py Flask :5000 → SQLite` serves `ATL-Smart-Attendance-Production.html` shell spliced with `backend/ui_app.js` at `/_serve_production()` (`Cache-Control: no-store`). Truth is sensor flash (200 slots) + SQLite. LocalStorage `atl_*` is cache only, omits photos. See `docs/PROJECT.md`.

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

`API.md` is the endpoint contract. `README.md` is the short human entry point.

## Repo and source of truth

- **Working dir:** `e:\sss` — do not probe other drives.
- **Production UI:** `ATL-Smart-Attendance-Production.html` CSS+markup shell served at `/` with no-store. **Maintained UI source is `backend/ui_app.js`** — edit that, not the HTML splice point. Theme `bg #FCFBF7 panel #FFFFFF ink #0A0A0A ink-2 #6B6B6B ink-3 #A8A5A0 line #E9E6E0 paper #F6F4EF ok #2F5D34 danger #8A3A3A` + `Inter/Newsreader/ui-monospace`. Idle `PLACE YOUR FINGER` 11px 0.22em + `Admin` bottom-middle. No `css/ js/ templates/`.
- **Stack:** `backend/app.py` + `backend/gt511c3.py` + `backend/schema.sql` + `backend/config.json` (`sensor real`, `uart /dev/serial0`, `baud 9600`, `db /var/lib/atl/attendance.db`, `host 0.0.0.0:5000`). Windows fallback `backend/attendance.db` + `backend/uploads/`. Template `backend/config.example.json`.
- **Structure:** `ATL-Smart-Attendance-Production.html` · `AGENTS.md README.md API.md` · `docs/*.md` · `assets/images/{admin,diagrams,students,ui}` · `backend/{app.py,gt511c3.py,schema.sql,config.example.json,requirements.txt,ui_app.js,test_app.py}` · `pi/{setup.sh,atl-attendance.service}` · `tools/{deploy.ps1,deploy.sh,led_test.py}`

## How to run, deploy, verify

- **Local:** `python backend/app.py` → `http://127.0.0.1:5000/` · **Pi:** `http://192.168.1.8:5000/` · `sudo systemctl status atl-attendance` · `journalctl -u atl-attendance -f` · DB `/var/lib/atl/attendance.db`
- **Deploy:** `powershell -File tools/deploy.ps1` or `bash tools/deploy.sh` — never copies `attendance.db` or `config.json`
- **SSH:** `ssh -i C:\Users\LaNcer\.ssh\id_ed25519 lancer@192.168.1.8` (user `lancer`, not `pi`)
- **Verify:** `curl http://192.168.1.8:5000/` → title `ATL Smart Attendance Terminal — Complete School System`, `pane-backup` + `#FCFBF7`, spliced `ui_app.js`, no `__SSR_DATA__` · `curl /api/health` → `db_ok: true` (`sensor offline` expected when `sensor:real` without hardware) · Routes `/` + `/assets/<path>` + `/api/*`; unknown non-API paths serve UI; dead `/legacy|/terminal|/perfect|/css|/js` stay gone
- **Tests:** `python -m unittest backend.test_app -v`

## Constraints — must not break

- **Scan:** active loop `POST /api/scan {waitSec:2}` when Admin and enroll modal are closed; bridge `GET /api/scan/last` every 2s; both call `window.handleRealScan`. `NO_FINGER/SENSOR_BUSY/UART` create no event. Enrollment one Start + 3 captures with lifts; progress via `GET /api/sensor/progress`. Keep `SENSOR_LOCK` and `keep_led_on=True`; `tools/led_test.py` diagnostic only.
- **Edit:** behavior in `backend/ui_app.js`; keep light-editorial UI frameless photo+fields; do not edit HTML inline script.
- **Settings:** `POST /api/settings` whitelist excludes `sensor/uart/baud/db/host/port/imagesDir`. Holidays `YYYY-MM-DD[..YYYY-MM-DD]:type:name` where `type holiday|vacation|exam` (`exam`=working); validated in `app.py:191`.
- **Scheduling:** precedence `override → holiday/vacation/exam → weekly` (`app.py:271,309`); weekly per-student `Grade|Batch → batch → class → global` (`app.py:278`); default Sunday off Mon-Sat on (`app.py:70`).
- **Wiring:** VCC **3.3V pin1** never 5V, GND pin6, RX GPIO14/pin8, TX GPIO15/pin10, `/dev/serial0` 9600, `enable_uart=1`.
- **Artifacts never commit/deploy:** `__pycache__/ *.log *.db *.pre_restore.bak uploads/ .venv/ .env backend/config.json` — template is `backend/config.example.json`.
- **Attendance:** `PRESENT ≤08:00`, `LATE` otherwise (`app.py:360`), `DUPLICATE` on same-day re-scan, `NOT_SCHEDULED` muted never absent, `ABSENT` only via `POST /api/reconcile` after `lateCutoff` with today guard `BEFORE_CUTOFF` (`app.py:1743`).
- **One task at a time.** After code, update docs. Check `docs/*.md` against `backend/app.py`, `gt511c3.py`, `schema.sql`, `ui_app.js` before finishing.
