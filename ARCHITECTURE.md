# ARCHITECTURE — ATL Smart Attendance

> Current implementation source: `backend/app.py` + `backend/gt511c3.py` + `backend/ui_app.js` + SQLite. `ATL-Smart-Attendance-Production.html` is the shell served at `/` with `Cache-Control: no-store`.

## 1. Purpose
Fingerprint terminal for school daily attendance. Student finger → GT-511C3 identifies → SQLite records `PRESENT/LATE/DUPLICATE/NOT_SCHEDULED/UNKNOWN` → UI shows identity card (5s) or Unknown (4s). Admin (6 tabs) manages students, Today, Reports, Calendar, Settings, Backup offline. Rule: **real sensor + SQLite are truth; never fabricate fingerprint/student/result.**

## 2. System Overview
```
[GT-511C3 UART /dev/serial0 9600] ↔ [backend/gt511c3.py] ↔ [backend/app.py Flask :5000] ↔ [SQLite /var/lib/atl/attendance.db]
                                                        ↕
                                              [ATL-Smart-Attendance-Production.html shell]
                                                injected poller + backend/ui_app.js (source)
                                                        ↕
                                              [LocalStorage atl_* cache] ↔ [Admin UI]
```
* UI shell: `ATL-Smart-Attendance-Production.html` (inline CSS+JS fallback). At serve `_serve_production()` `backend/app.py:439` replaces first `<script>` with `backend/ui_app.js` and injects `SCAN_BRIDGE_SCRIPT` before last `</body>` — HTML file untouched.
* Active scan loop `backend/ui_app.js:334` `POST /api/scan {waitSec:2}` when Admin closed; bridge poller `backend/app.py:391` `GET /api/scan/last` 2s covers fallback/external scans. Both map `fingerId→fid "F-<n>"` → `window.handleRealScan(fid,{status,time,date,seq})`.

## 3. Repository Structure
```
ATL-Smart-Attendance-Production.html  # shell served at /  (~92 KB)
AGENTS.md  API.md  PI_SETUP.md  README.md  ARCHITECTURE.md  # docs (PROJECT.md removed, see §16)
assets/images/{admin,diagrams,students,ui}  # logo.svg planet.svg architecture.svg (photos data URLs)
backend/{app.py, gt511c3.py, schema.sql, config.json, requirements.txt, ui_app.js, test_app.py}
pi/{setup.sh, atl-attendance.service}  tools/{deploy.ps1, deploy.sh, dev-watch.ps1}
Artifacts gitignored: __pycache__/ *.db *.log uploads/ .venv/ (.pre_restore.bak, attendance.db)
```

## 4. UI Rules (approved, light editorial)
* Theme `bg #FCFBF7 panel #FFFFFF ink #0A0A0A ink-2 #6B6B6B ink-3 #A8A5A0 line #E9E6E0 paper #F6F4EF ok #2F5D34 danger #8A3A3A` + Inter/Newsreader/monospace. Terminal empty: centered `PLACE YOUR FINGER TO SCAN` 11px 0.22em + `Admin` bottom-middle. No frame/scan-line/countdown/clock/divider. Identity card overlays center.
* Admin 6 tabs: Students, Today, Reports, Calendar, Settings, Backup. No right-drawer, no dark palette, no `__SSR_DATA__`. New Enrollment is on the Students toolbar (not the terminal).
* Data model DB-driven since 2026-08-29: fetch `/api/students?active=all /settings /attendance /audit /daily /kpis` on load +15s (skipped while the tab is hidden). LocalStorage `atl_*` is cache only and omits student photos. `DUMMY_MODE/SAMPLE_STUDENTS/simulateScan` removed.
* Maintained UI source is `backend/ui_app.js`; HTML inline script is fallback stale when opened via `file://`. Do not edit HTML without approval.

## 5. Admin Requirements (current)
* **Students:** search (name/roll/class/batch/phone/fid/section/parent), class/batch/status filters, new student form (photo ≤2MB) + 3-capture `POST /api/enroll`, detail card history 60, Edit (clear photo, active toggle), Re-enroll, Deactivate (`active 0 roll#d{id} free slot`), Re-activate, Print, CSV export/import (Batch/Section/Parent/Address, rate).
* **Today:** stats (Total/Scheduled/Present/Late/Absent/Not Scheduled/Unknown/Duplicate/% `GET /api/kpis`), class/status/sort filters, unknown table, print header with school, CSV (`?class & status`).
* **Reports:** school/class/student × today/week/month/academic/custom (custom validated `from≤to`) `GET /api/reports?studentId` backend KPI, print/CSV `GET /api/export/csv?start&end`.
* **Calendar:** schedule-only. Weekly toggles global or per-class `calClassSelect` (legend Working/Holiday/Vacation/Override). Month view + Today status. Holidays global ranges, overrides global. School info in Settings, not Calendar.
* **Settings:** single source school info (name/address/late/year + attendance start), classes (Students count only).
* **Backup:** `GET /api/backup` DB `atl_backup_<date>.db` includes students/daily/events/settings (incl. classSchedules/batchSchedules/holidays/overrides) + audit; `POST /api/restore` validates `SQLite format 3\x00`; audit CSV export. Per-class/batch schedules are included (not UI-only).

## 6. Student Data Model
`schema.sql:4 students(id PK, name NOTNULL, roll UNIQUE NOTNULL, grade NOTNULL, batch, section, parent, phone, address, fingerId UNIQUE, photo, active, createdAt)`
* UI `mapStudent()` `ui_app.js:100`: `class←grade, fid←"F-"+fingerId, batch←batch/group, active bool`.
* Editable `PATCH /api/students/:id` `app.py:873`: `photo ≤8000`, `phone ≤40 digits≥8`, `address ≤200`, `name 1-80`, `roll 1-20 unique lower()`, `grade 1-40 auto-adds classes`, `batch ≤40 auto-adds batches`, `section ≤20`, `parent ≤80`, `active bool`. `POST /api/students` requires `name,roll,grade`.
* Delete frees slot `DELETE` + sensor `delete_id`; reenroll `POST /api/students/:id/reenroll` allocates new fid 1..199, deletes old.

## 7. Attendance Model & Rules
* Tables `events(id, date, time, studentId, fingerId, result, status, source)` `daily(key "date|id", date, studentId, status, firstScan, lastScan)`.
* Statuses backend uppercase `PRESENT/LATE/ABSENT/DUPLICATE/UNKNOWN/NOT_SCHEDULED/NON_WORKING_DAY/NEED_STUDENT_ID` → UI `Present/Late/...` `ui_app.js:52`.
* **Cutoffs** `backend/config.json:7-8` `presentCutoff "08:00"` `lateCutoff "08:30"` `app.py:322 classify()`: `time≤08:00 → PRESENT`, `time≤08:30 → LATE`, `else → LATE`. Same-day re-scan if `daily` exists and not `ABSENT/NOT_SCHEDULED` → `DUPLICATE` (“Already recorded”, preserves `firstScan`).
* **NOT_SCHEDULED `is_student_scheduled()` `app.py:271`:** if not scheduled (see §8) and not already `PRESENT/LATE` → write `daily NOT_SCHEDULED` + `events NOT_SCHEDULED GT511C3` → `reason NOT_SCHEDULED`. Shown muted, never counts as Absent. Global holiday branch `NON_WORKING_DAY` similar.
* **ABSENT:** only via `POST /api/reconcile` `app.py:1724` after `lateCutoff` (today guard `BEFORE_CUTOFF` `app.py:1743`). Scheduled + no daily → `ABSENT 23:59:59 RECONCILE`; not scheduled + no daily → `NOT_SCHEDULED 00:00:00 RECONCILE`.

## 8. Scheduling: Class/Batch/Weekly/Holiday/Override
* Default `DEFAULT_WORKING_DAYS {0:false,1..6:true}` Sun off, Mon-Sat on `app.py:48`.
* **Holidays** strings or dicts `app.py:191 holiday_range()`: `YYYY-MM-DD:Reason` or `YYYY-MM-DD..YYYY-MM-DD:type:name` where `type holiday|vacation|exam` (else holiday). `exam` counts as working `app.py:230`. Range validated `start≤end`.
* **Overrides** `["YYYY-MM-DD:1:note"]` or `{date,isWorking}`.
* **Precedence `is_student_scheduled()`:** `override → holiday/vacation/exam → weekly`. Weekly resolver `_get_working_days_for_student()` `app.py:240` → **batch composite `Grade|Batch` → batch → class → global**, each `{workingDays:{0..6}}` or flat `{0..6}`.
* Backend-persisted `config.json classes/batches/classSchedules/batchSchedules` `app.py:654` via `POST /api/settings` `_clean_wd()`; validated and included in backup. Not UI-only.

## 9. Data Flow
1. Load: `cacheLoad() → loadClassesHolidaysSettings() GET /api/settings, loadStudents() GET /api/students, loadHistory() GET /api/attendance, loadTodayAttendance() POST /api/reconcile + GET /api/attendance?date /daily /kpis /audit → cacheSave()` +15s.
2. Scan: `sensorScanLoop POST /api/scan {waitSec:2}` / bridge `GET /api/scan/last` → backend `SENSOR_LOCK → GT511C3.identify(timeout) → wait_finger+capture+Identify` → `NO_FINGER 400` no write / `SENSOR_DISCONNECT 503` / `UNKNOWN` event+seq / `NOT_SCHEDULED` / `DUPLICATE` / `PRESENT/LATE` (classify + daily/events).
3. Enroll: form → `POST /api/enroll` → `SENSOR_LOCK → enroll(fid)` 3× wait_press(40s)→capture→EnrollN→wait_remove(30s) → insert student on OK.

## 10. Source of Truth
* **SQLite** `DB_PATH` `/var/lib/atl/attendance.db` Pi else `backend/attendance.db` + `settings.value` JSON — students, fingerId mapping, daily/events, audit, settings (schoolName/cutoffs/holidays/overrides/workingDays/classes/batches/classSchedules/batchSchedules/images). Health `GET /api/health` `db_ok`.
* **GT-511C3 flash** 200 slots — template bytes; DB `fingerId` is map.
* **Photos** `students.photo` data URL ≤8000 + `IMAGES_DIR` files.
* **Clock** `today_ist()/now_ist()` IST `app.py:165` validated 2020-2035.
* **Config** `backend/config.json` hardware only `sensor/uart/baud/db/host/port/imagesDir` file-only, never via API whitelist.

## 11. Offline / Cache
LocalStorage `atl_*` cache only `AGENTS.md`; API `cache:no-store`; HTML `file://` runs offline from cache but scan/enroll require backend. Images Pi `/var/lib/atl/images` mirrored `assets/images/students` dev.

## 12. Fingerprint Workflow
* LED always-on `keep_led_on=True` `app.py:357` `set_led(True)` at startup `app.py:2051`; `tools/led_test.py` diagnostic.
* **Enroll** `gt511c3.py:371`: `initialize→LED ON→enroll_start→ enroll_n×3` (wait_press stable3 → capture best 8 retries → EnrollN → wait_remove stable2). Progress via `SENSOR_PROGRESS` `GET /api/sensor/progress`. Lift required.
* **Identify** `gt511c3.py:406`: `initialize→LED ON→wait_finger(timeout 1-30)→capture→Identify 5s → fid or UNKNOWN/NO_FINGER/UART_ERR` → `set_led(keep)`.

## 13. API Summary (see `API.md` for contracts)
`/ /assets/<path> /api/health /api/settings GET POST whitelist /api/students GET POST /api/students/:id GET PATCH DELETE /api/students/:id/reenroll /api/backup /api/restore /api/export/csv?type= /api/import/csv /api/correction /api/enroll /api/sensor/progress /api/scan /api/scan/last /api/reconcile /api/attendance /api/daily /api/export /api/kpis?date&class&batch /api/reports?studentId /api/images* /api/notifications /api/audit`. 404 JSON for `/api/`, fallback HTML else.

## 14. DB Schema & Migration
`schema.sql:1` WAL, FK ON, tables students/events/daily/notifications/audit/settings/images. Init `get_db()` creates schema if missing then `_migrate_db()` adds `address/batch/section/parent` plus indexes `events(date,studentId)`, `daily(date,studentId)`, `students(fingerId,roll)`. `get_settings()` migrates missing keys (classes/batches/classSchedules/batchSchedules etc). Additive only, preserves history.

## 15. Backup / CSV / Audit
* Backup `GET /api/backup` `wal_checkpoint` `send_file` `atl_backup_YYYY-MM-DD.db` mime octet; restore `POST /api/restore` header `SQLite format 3\x00` → `.pre_restore.bak` → overwrite → `SELECT 1 FROM students` verify.
* CSV `GET /api/export/csv?type=students|attendance&date&start&end&class&studentId&status` 5000 limit, `POST /api/import/csv` header-insensitive `name/roll/class/batch/section/parent/phone/address`, auto-adds class/batch, no fingerId.
* Audit `audit(id,at,action,details)` actions `SETTINGS_CHANGED/STUDENT_ENROLLED/STUDENT_UPDATED/STUDENT_DELETED/FINGER_REENROLLED/ATTENDANCE_RECORDED/DUPLICATE_SCAN/NOT_SCHEDULED_SCAN/UNKNOWN_FINGERPRINT/ABSENCE_RECONCILIATION/ATTENDANCE_CORRECTED`. `GET /api/audit` 500 DESC, `POST /api/correction {date,studentId,status,reason 3-300}` `app.py:1328`.

## 16. Pi & Hardware
Target `lancer@192.168.1.8` Pi3B Rev1.2 Debian13, user `lancer` not `pi`, key `C:\Users\LaNcer\.ssh\id_ed25519` hostkey `SHA256:jmqvz4JHHhyxlTlHeTw8Y20fzyZ7RUAJhbhDg1HpYm0`. DB `/var/lib/atl/attendance.db` images `/var/lib/atl/images` config `/opt/atl-attendance/backend/config.json` venv `/opt/atl-attendance/venv`. Wiring VCC 3.3V pin1 never 5V GND pin6 RX GPIO14 pin8 TX GPIO15 pin10 `/dev/serial0 9600 enable_uart=1`. Service `pi/atl-attendance.service` `User=lancer Restart=always`.

## 17. Dev / Deploy / Testing
* Local: `python backend/app.py` → `http://127.0.0.1:5000/` or `file://` HTML offline. Pi: `systemctl status atl-attendance` `journalctl -f`.
* Deploy canonical `tools/deploy.ps1` (scp HTML+app.py/ui_app.js/gt511c3.py/schema.sql+assets+service) or `bash tools/deploy.sh` rsync excludes `.git/__pycache__/*.db/uploads/venv/config.json`. Never scp `attendance.db/config.json`.
* Watch `tools/dev-watch.ps1` polls HTML/backend/*.py|sql/assets/pi 300ms debounce 700ms, SSE `127.0.0.1:35729/__dev_reload` injected only `?dev=1`.
* Tests `backend/test_app.py` `python -m unittest backend.test_app -v` temp DB sim sensor — health, settings whitelist (`workingDays` string `"false"`), students (`class` alias, roll unique, re-activate restores roll, photo cap), scans (present/duplicate/real wait/no-finger/sensor fid/NOT_SCHEDULED seq), scan_last, audit, reconcile, calendar, holidays, class/batch schedules, kpi/report buckets, correction, CSV, indexes, GT-511C3 `is_press_finger` NACK, cache headers. Verify `verify_pi_scan.py` live Pi.

## 18. Deployment-Sensitive / Never Commit
Artifacts never commit/deploy: `backend/__pycache__/ *.log *.db *.pre_restore.bak uploads/ .venv/ venv/ .env` `assets/images/students/*` `backend/config.json` (machine-specific). Deploy excludes them; template committed `backend/config.example.json`.

## 19. Dangerous Assumptions
LocalStorage is truth; editing HTML inline instead of `ui_app.js`; `NOT_SCHEDULED`=absent; holiday single-day only; sensor always ready; config edit auto-applies; `file://` equals served page.

## 20. Compatibility-Only
`SCAN_BRIDGE_SCRIPT` serve-time injection, `?dev=1` SSE reload, `window.handleRealScan` dual signature, `GET /api/sensor/progress` alias, `SIM` fallback for tests.

## 21. History (replaces PROJECT.md)
* 2026-08-29: DB-driven switch, bridge resolved (`fingerId→fid`), LED always-on, class/batch columns migrated, Significa dark retired, clutter scripts `tools/significa.ps1` removed.
* 2026-08-30: terminal empty `PLACE YOUR FINGER`, `ui_app.js` active `POST /api/scan` when admin closed, per-class/batch schedules backend-persisted (not UI-only), calendar schedule-only, settings single source, Today NOT_SCHEDULED muted, Reports custom validated, Backup DB+CSV.
* 2026-08-31: removed temporary PC `tools/dev-local.ps1`; sensor lift NACK `0x1012` is False; inserts use SQLite `lastrowid`; `/api/*` `no-store`; DB indexes; batched reconcile/kpis; exam days working in UI; Students New Enrollment toolbar; deploy `pkill` before start. `PROJECT.md` removed 2026-08-30 — history kept here to avoid duplication.

*Aligned 2026-08-31 with `backend/app.py` `backend/ui_app.js` `ATL-Smart-Attendance-Production.html`.*
