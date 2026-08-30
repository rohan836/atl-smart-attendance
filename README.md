# ATL Smart Attendance Terminal

Local-first school attendance: **GT-511C3** fingerprint → **Raspberry Pi 3** → **Flask + SQLite**. Terminal front is biometric (not a dashboard); admin behind it.

> **Current build:** `ATL-Smart-Attendance-Production.html` — single-file light editorial (~92 KB). Only UI. Prototype/Significa builds retired. Maintained script is `backend/ui_app.js` spliced at serve; HTML shell is fallback for `file://` offline.

## Mission
Finger → identify → record → identity card. Admin manages students, fingerprints, calendar, reports without technical knowledge. **Real sensor + SQLite are truth; never fabricate.**

## Hardware & Wiring
| Component | Value |
|-----------|-------|
| Module | GT-511C3, 200 slots, UART `/dev/serial0` 9600 baud |
| Pi | Raspberry Pi 3 Model B Rev 1.2, Debian 13 |
| Power | **3.3V pin 1 only — never 5V** |

| GT-511C3 | Pi | Purpose |
|----------|----|---------|
| VCC | **3.3V pin 1** | Power |
| GND | GND pin 6 | Ground |
| Sensor RX | GPIO14/pin 8 | Pi TX |
| Sensor TX | GPIO15/pin 10 | Sensor TX |

## Main UI — `ATL-Smart-Attendance-Production.html`
Theme `bg #FCFBF7` `ink #0A0A0A` `line #E9E6E0` `paper #F6F4EF` `ok #2F5D34` `danger #8A3A3A` — Inter/Newsreader/monospace. Front: centered `PLACE YOUR FINGER TO SCAN` + `Admin` bottom-middle; no frame/scan-line/countdown/divider. Scans overlay identity card (photo/initials, name/roll/class/ID/phone, status badge, time/date) or Unknown.

**Admin 6 tabs:** Students (search, filters, CSV, detail/history, edit/reenroll/deactivate, print) · Today (stats, filter/sort, unknown, print/CSV) · Reports (school/class/student × today/week/month/academic/custom) · Calendar (weekly global + per-class/batch, holidays/vacations/exam ranges, overrides, month view) · Settings (classes, school info) · Backup (DB backup, validated restore, audit).

**Data:** DB-driven. Fetches SQLite via `/api/students /settings /attendance /audit /daily /kpis` on load +15s; LocalStorage `atl_*` is cache only. `backend/app.py` injects poller `GET /api/scan/last` → `window.handleRealScan(fid)` (`fingerId→F-<n>`).

**Attendance:** `PRESENT` if scan `≤08:00` (`presentCutoff`) else `LATE` (`≤08:30` `lateCutoff` and beyond both Late); same-day re-scan → “Already recorded”; `ABSENT` only after `lateCutoff` via `POST /api/reconcile` (today guarded `BEFORE_CUTOFF`); `NOT_SCHEDULED` when student not scheduled that day — shown muted, never counted absent. Calendar precedence: `override → holiday/vacation → weekly`, `exam` counts as working, holidays `YYYY-MM-DD..YYYY-MM-DD:type:name`. Per-class/batch weekly `Grade|Batch → batch → class → global` persisted via `classSchedules/batchSchedules` and included in DB backup.

## Backend
`backend/app.py` serves UI at `:`5000 `no-store` + `/api/*` + `/assets/`. SQLite truth (`/var/lib/atl/attendance.db` Pi, `backend/attendance.db` Windows). Driver `backend/gt511c3.py`, config `backend/config.json` (template `config.example.json`). Offline-first; API covers enroll/scan/correction/kpis/reports/CSV/images/backup. See `API.md` + `ARCHITECTURE.md`.

**Sensor workflow:** Admin closed → `POST /api/scan {waitSec:2}` short wait. Recognized → event + card; unknown → Unknown event+card; `NO_FINGER/busy/UART` → no event. Enroll: one Start → 3 lifts on sensor.

## Repository Structure
```
ATL-Smart-Attendance-Production.html   # shell served at /
AGENTS.md  API.md  PI_SETUP.md  ARCHITECTURE.md  README.md
assets/images/{admin,diagrams}         # logo.svg, planet.svg, architecture.svg
backend/{app.py, ui_app.js, gt511c3.py, schema.sql, config.json, requirements.txt}
pi/{setup.sh, atl-attendance.service}  tools/{deploy.ps1, deploy.sh}
```
Gitignored: `backend/*.db` `backend/uploads/` `__pycache__/` `*.log` `venv/` `backend/config.json`.

## Run
- **Local:** `python backend/app.py` → `http://127.0.0.1:5000/` (or `file://` HTML offline).
- **Pi:** `http://192.168.1.8:5000/` · `sudo systemctl status atl-attendance` · `journalctl -u atl-attendance -f`.
- **Deploy:** `powershell -File tools/deploy.ps1` or `bash tools/deploy.sh` (never deploys `attendance.db`/`config.json`).

## How to Test
* Today who present/late/absent/not-scheduled? → Today (stats + filters, `GET /api/kpis`).
* Grade 10-A today? → Today → Class filter.
* Student %/history? → Students → select (calendar-aware, not days elapsed).
* Holiday? → Calendar month view.
* Toggle Saturday, add Diwali `10 Oct..15 Oct:vacation`? → Calendar weekly/override/Add holiday.
* Edit/replace fingerprint? → Students → Edit / Re-enroll (history kept).
* Correct mis-record? → `POST /api/correction {date,studentId,status,reason}` (Today/Students Correct button).
* Print/CSV/Backup? → Print/Export CSV on Today/Reports/Students; Backup tab DB + audit CSV; `GET /api/export/csv?type=`.

## Notes
Implementation hidden behind interface. Docs `ARCHITECTURE.md, API.md, PI_SETUP.md, AGENTS.md` aligned with code — update after change.
