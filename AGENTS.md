# AGENTS.md

## Repo State
- **Working dir:** `e:\sss` — do not probe other drives.
- **Production UI:** `ATL-Smart-Attendance-Production.html` — single-file light editorial terminal (~92 KB, inline CSS+JS) served at `/` by `backend/app.py: _serve_production()` with `Cache-Control: no-store` → `http://192.168.1.8:5000/` (Pi) or `http://127.0.0.1:5000/` (local). No `css/`, `js/`, `templates/`. Do not edit this HTML without explicit user approval.
- **Maintained UI source:** `backend/ui_app.js` (1421 lines) is spliced into the HTML at serve time (`app.py:454`). The HTML inline script is a fallback for `file://` offline use and is stale (`atl_batches`, `ClassSchedules` missing). Edit `ui_app.js`, not the HTML inline script.
- **Theme (light editorial — Significa dark RETIRED):** `bg #FCFBF7 / panel #FFFFFF / ink #0A0A0A / ink-2 #6B6B6B / ink-3 #A8A5A0 / line #E9E6E0 / paper #F6F4EF / ok #2F5D34 / danger #8A3A3A` + `Inter / Newsreader / ui-monospace`. Terminal empty `PLACE YOUR FINGER TO SCAN` (11px 0.22em) + `Admin` bottom-middle; no frame/scan-line/countdown/clock/divider. Admin 6 tabs: Students, Today, Reports, Calendar, Settings, Backup.
- **Data model (DB-driven since 2026-08-29):** UI fetches SQLite via `/api/students /settings /attendance /audit /daily /kpis` on load +15s. LocalStorage `atl_students, atl_attendance, atl_holidays, atl_overrides, atl_settings, atl_classes, atl_audit, atl_batches, atl_class_schedules, atl_batch_schedules` is cache only. `DUMMY_MODE/SAMPLE_STUDENTS/simulateScan` removed. Enroll = form + 3-capture `POST /api/enroll`.
- **Bridge:** `backend/app.py:391` injects poller at serve (HTML untouched): `GET /api/scan/last` 2s → `fingerId→fid "F-<n>"` sync `atl_students` (`class←grade`) → `window.handleRealScan(fid,{status,time,date,seq})`; unknown → `__unknown__<seq>`. Active loop `backend/ui_app.js:334` `POST /api/scan {waitSec:2}` when Admin closed is primary path. SQLite is truth.
- **Stack:** `backend/app.py` + `backend/gt511c3.py` + `backend/config.json` (`sensor real`, `uart /dev/serial0`, `baud 9600`, `db /var/lib/atl/attendance.db`, `host 0.0.0.0:5000`, `schoolName ATL Model School`, cutoffs `08:00/08:30`, classes `Grade 10-A/10-B/9-A/12-C`). Windows fallback `backend/attendance.db` + `backend/uploads/`.
- **Current behavior (2026-08-30):** terminal empty; served page uses `backend/ui_app.js` and actively `POST /api/scan` when Admin closed. Enrollment one Start + 3 lifts.
- **Admin UX (2026-08-30):** Calendar schedule-only (global weekly + **backend-persisted** per-class/batch overrides via `classSchedules/batchSchedules` + holidays/overrides global, month view); Settings single source school info + classes; Students Batch/Status filters + re-activate + clear photo + full CSV; Today `Not Scheduled` muted never Absent; Reports custom validated; Backup DB + audit CSV; Esc + backdrop close.

## Decisions
- `class = Grade 10-A`, optional `Batch/Group`; holidays/overrides global; per-class/batch weekly expected; Section+Parent kept; re-activate yes.
- **Per-class/batch schedules are backend-persisted** `backend/app.py:654 POST /api/settings classSchedules/batchSchedules` and included in DB backup via `settings` JSON — not UI-only (previous `UI-only preview` claim retired 2026-08-30). See `ARCHITECTURE.md:8`.

## Structure (actual)
```
ATL-Smart-Attendance-Production.html   # shell served at /
AGENTS.md  README.md  API.md  PI_SETUP.md  ARCHITECTURE.md  # docs (PROJECT.md removed → ARCHITECTURE.md:21)
assets/images/{admin,diagrams}         # logo.svg, planet.svg, architecture.svg (+ README.md)
backend/{app.py, gt511c3.py, schema.sql, config.json, config.example.json, requirements.txt, ui_app.js, test_app.py}
backend/ artifacts gitignored: attendance.db, *.db, *.log, __pycache__/, uploads/, .venv/
pi/{setup.sh, atl-attendance.service}  tools/{deploy.ps1, deploy.sh}
```
Removed 2026-08-29 (do not recreate): `tools/significa.ps1`, `tools/entrance.ps1`, `tools/fix-sidebar.ps1` (`D:\ssh\ATL-FINAL-PERFECT.html`).

## Run / Deploy
- **Local:** `python backend/app.py` → `http://127.0.0.1:5000/` (or `file://` HTML offline via cache).
- **Pi:** `http://192.168.1.8:5000/` · `sudo systemctl status atl-attendance` · `journalctl -u atl-attendance -f` · DB `/var/lib/atl/attendance.db`.
- **Deploy:** `powershell -File tools/deploy.ps1` or `bash tools/deploy.sh` (excludes `.git/__pycache__/*.db/uploads/venv/config.json`). **Never** scp `attendance.db` or `config.json`.
- **SSH:** `ssh -i C:\Users\LaNcer\.ssh\id_ed25519 lancer@192.168.1.8` user `lancer` not `pi`, hostkey `SHA256:jmqvz4JHHhyxlTlHeTw8Y20fzyZ7RUAJhbhDg1HpYm0`, wlan0 `192.168.1.8`.

## Verify
- `curl http://192.168.1.8:5000/` → `<title>ATL Smart Attendance Terminal — Complete School System</title>`, `pane-backup` + `#FCFBF7`, no `__SSR_DATA__`.
- `curl http://192.168.1.8:5000/api/health` → `db_ok: true` (`sensor offline` expected when `sensor:real` without hardware).
- Routes: `/` + `/assets/<path>` + `/api/*` + fallback HTML only. Dead `/legacy|/terminal|/perfect|/css|/js` removed.
- Grep 0 hits for: `ATL-FINAL-PERFECT`, `ATL-TERMINAL`, `Significa`, `templates/index.html`, `final-project`, `D:\ssh`.

## Constraints
- **Scan workflow:** `POST /api/scan {waitSec:2}` when Admin closed; `NO_FINGER/SENSOR_BUSY/UART` create no event. Enrollment one Start + 3 captures.
- **Do not edit** `ATL-Smart-Attendance-Production.html` without approval — source is `backend/ui_app.js`.
- **Artifacts never commit/deploy:** `__pycache__/ *.log *.db uploads/ .venv/ .env backend/config.json`.
- **Whitelists:** `POST /api/settings` excludes `sensor/uart/baud/db/host/port/imagesDir`; holidays `YYYY-MM-DD[..YYYY-MM-DD]:type:name` `type holiday|vacation|exam` (exam=working); classes sync from settings.
- **Wiring:** VCC **3.3V pin1** never 5V, GND pin6, RX GPIO14/pin8, TX GPIO15/pin10, `/dev/serial0` 9600, `enable_uart=1`.
- **LED always-on** `keep_led_on=True` + `set_led()`; `tools/led_test.py` diagnostic.
- **Docs truth after code:** `README.md, API.md, PI_SETUP.md, ARCHITECTURE.md` + this file — update after change + verify greps.
- One task at a time; ask before touching outside scope. For architecture/attendance rules see `ARCHITECTURE.md`.
