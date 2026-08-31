# AGENTS.md

## Repo State
- **Working dir:** `e:\sss` — do not probe other drives.
- **Production UI:** `ATL-Smart-Attendance-Production.html` — CSS + markup shell served at `/` by `backend/app.py` `_serve_production()` with `Cache-Control: no-store` → `http://192.168.1.8:5000/` (Pi) or `http://127.0.0.1:5000/` (local). No `css/`, `js/`, `templates/`.
- **Maintained UI source:** `backend/ui_app.js` is spliced into the HTML at serve time. Edit `ui_app.js` for behavior. The HTML `<script>` block is a splice point only.
- **Theme (light editorial):** `bg #FCFBF7 / panel #FFFFFF / ink #0A0A0A / ink-2 #6B6B6B / ink-3 #A8A5A0 / line #E9E6E0 / paper #F6F4EF / ok #2F5D34 / danger #8A3A3A` + `Inter / Newsreader / ui-monospace`. Terminal idle `PLACE YOUR FINGER` (11px 0.22em) + `Admin` bottom-middle. Scan result is frameless photo + fields. Admin 6 tabs: Students, Today, Reports, Calendar, Settings, Backup.
- **Data model:** UI fetches SQLite via `/api/students /settings /attendance /audit /daily /kpis` on load +15s. LocalStorage `atl_*` is cache only and omits photos. Enroll = form + 3-capture `POST /api/enroll`.
- **Scan:** Active loop `POST /api/scan {waitSec:2}` when Admin and enroll modal are closed. Bridge `GET /api/scan/last` every 2s as fallback. Both call `window.handleRealScan`. Enroll/re-enroll success `returnToFrontPage()` closes modal + Admin and re-arms the loop. SQLite is truth.
- **Stack:** `backend/app.py` + `backend/gt511c3.py` + `backend/config.json` (`sensor real`, `uart /dev/serial0`, `baud 9600`, `db /var/lib/atl/attendance.db`, `host 0.0.0.0:5000`). Windows fallback `backend/attendance.db` + `backend/uploads/`. Template `backend/config.example.json`.
- **Admin UX:** Calendar schedule-only (global weekly + backend-persisted per-class/batch `classSchedules/batchSchedules` + holidays/overrides). Settings = school info + classes. Students toolbar New Enrollment, Batch/Status filters, re-activate, CSV. Today `Not Scheduled` muted, never Absent. Backup DB + audit CSV.

## Decisions
- `class = Grade 10-A`, optional `Batch/Group`; holidays/overrides global; per-class/batch weekly expected; Section+Parent kept; re-activate yes.
- Per-class/batch schedules are backend-persisted (`POST /api/settings`) and included in DB backup.

## Structure
```
ATL-Smart-Attendance-Production.html   # UI shell (CSS + markup)
AGENTS.md  README.md  API.md  PI_SETUP.md  ARCHITECTURE.md
assets/images/{admin,diagrams,students,ui}
backend/{app.py, gt511c3.py, schema.sql, config.example.json, requirements.txt, ui_app.js, test_app.py}
pi/{setup.sh, atl-attendance.service, README.md}
tools/{deploy.ps1, deploy.sh, led_test.py}
```
Gitignored (never commit/deploy): `backend/config.json`, `*.db`, `uploads/`, `__pycache__/`, `*.log`, `.venv/`, `.env`.

## Run / Deploy
- **Local:** `python backend/app.py` → `http://127.0.0.1:5000/`
- **Pi:** `http://192.168.1.8:5000/` · `sudo systemctl status atl-attendance` · `journalctl -u atl-attendance -f` · DB `/var/lib/atl/attendance.db`
- **Deploy:** `powershell -File tools/deploy.ps1` or `bash tools/deploy.sh`. **Never** deploy `attendance.db` or `config.json`.
- **SSH:** `ssh -i C:\Users\LaNcer\.ssh\id_ed25519 lancer@192.168.1.8` (user `lancer`, not `pi`)

## Verify
- `curl http://192.168.1.8:5000/` → title `ATL Smart Attendance Terminal — Complete School System`, `pane-backup` + `#FCFBF7`, spliced `ui_app.js`, no `__SSR_DATA__`.
- `curl http://192.168.1.8:5000/api/health` → `db_ok: true` (`sensor offline` expected when `sensor:real` without hardware).
- Routes: `/` + `/assets/<path>` + `/api/*`. Unknown non-API paths serve the UI. Dead `/legacy|/terminal|/perfect|/css|/js` must stay gone.
- Tests: `python -m unittest backend.test_app -v`

## Constraints
- Scan: `POST /api/scan {waitSec:2}` when Admin closed; `NO_FINGER/SENSOR_BUSY/UART` create no event. Enrollment one Start + 3 captures.
- Edit `ui_app.js` for app behavior; keep the current light-editorial UI.
- Artifacts never commit/deploy: `__pycache__/ *.log *.db uploads/ .venv/ .env backend/config.json`.
- `POST /api/settings` excludes `sensor/uart/baud/db/host/port/imagesDir`. Holidays `YYYY-MM-DD[..YYYY-MM-DD]:type:name` (`holiday|vacation|exam`; exam = working).
- Wiring: VCC **3.3V pin1** never 5V, GND pin6, RX GPIO14/pin8, TX GPIO15/pin10, `/dev/serial0` 9600, `enable_uart=1`.
- LED always-on `keep_led_on=True`. `tools/led_test.py` diagnostic only.
- Docs truth after code: `README.md, API.md, PI_SETUP.md, ARCHITECTURE.md` + this file.
- One task at a time. Attendance rules: `ARCHITECTURE.md`.
