# API — Backend service layer

Base: `http://192.168.1.8:5000` (Pi) or `http://127.0.0.1:5000` (local). Server: `backend/app.py` (Flask 3.x).

> UI is DB-driven: fetches SQLite via `/api/students /settings /attendance /audit /daily /kpis` and enrolls via `/api/enroll`. At serve, `backend/app.py` splices `backend/ui_app.js` into the HTML shell and injects poller `GET /api/scan/last` → `window.handleRealScan`.

## Pages / static
| Route | Serves |
|-------|--------|
| `/` | HTML shell + spliced `ui_app.js` + scan bridge (`Cache-Control: no-store`; `/api/*` also `no-store`) |
| `/assets/<path>` | Files under `assets/` |
| Other non-`/api`, non-`/assets` | Same UI as `/` |
| `/backend/*` | Not served as static files (config/db are not public) |

## Endpoints
| Method | Path | Auth `X-Admin-Pin` | Notes |
|--------|------|-------------------|-------|
| GET | `/api/health` | open (never leaks `adminPin`) | `{ok,status,sensor,sensor_detail,clock,db,db_ok,imagesDir,sensor_mode,settings}`. `sensor:real` → `offline` until GT-511C3 answers `/dev/serial0`. UART ping cached 25s to avoid `SENSOR_LOCK` fight. |
| GET/POST | `/api/settings` | GET open, POST header only | GET omits `sensor/uart/baud/db/host/port/imagesDir/adminPin`. POST whitelist: `schoolName, address, region, academicYear, schoolOpeningDate, attendanceStartDate, presentCutoff, lateCutoff, halfDayCutoff, minPercent, classes, batches, holidays, overrides, workingDays, classSchedules, batchSchedules, schoolLogo, planetImage, heroImage, imageGallery, trajectoryLabels`. Holidays `YYYY-MM-DD[..YYYY-MM-DD]:type:name` `type holiday|vacation|exam` (exam=working). Overrides `YYYY-MM-DD:0/1:note` or dict. `workingDays {0..6 bool}` Sun=0. `classSchedules/batchSchedules {key: workingDays}` keys ≤80, ≤50 entries. Validates dates/times and `presentCutoff ≤ lateCutoff`. Header-only PIN, no `?pin=` query. |
| GET/POST | `/api/students` | GET open, POST header only | GET `?q & ?class & ?active=all` + computed `attendance_rate` from `daily`. POST create validates `name(1-80), roll(1-20 unique lower), grade(1-40 required), batch≤40, section≤20, parent≤80, phone≤40 digits≥8, address≤200`; auto-creates class/batch in settings. Header-only PIN. |
| GET | `/api/students/:id` | open | Single + `events` 500 + `daily` 500 + `stats {present,late,duplicate,unknown}`. |
| PATCH | `/api/students/:id` | header only | Whitelist `photo, phone, address, name, roll, grade, batch, section, parent, active`. Roll unique, grade auto-adds class. |
| DELETE | `/api/students/:id` | header only | Deletes sensor template `GT511C3.delete_id` (sim OK, offline DB-free if `sensor:real` no HW) then `active=0, roll=roll#d{id}, fingerId=NULL` (keeps history). |
| POST | `/api/students/:id/reenroll` | header only | Allocates new `fingerId` 1..199, `SENSOR_LOCK → GT511C3.enroll(newFid)` 3 captures (retries `IS_ALREADY_USED` up to 10), deletes old fid. |
| POST | `/api/enroll` | header only | Create + enroll: validates as `/api/students`, `SENSOR_LOCK → GT511C3.enroll(fid)` 3 lifts → insert student + audit `STUDENT_ENROLLED`. Long timeout ~180s. On `hardware_unusable` 503. Progress via `GET /api/sensor/progress`. |
| GET | `/api/sensor/progress` alias `/api/enroll/progress` | open | `{mode,step,state,title,detail,timeout_sec,remain_sec,finger,raw}` live enroll/scan wait. |
| GET | `/api/sensor/audit` | header only | Read-only diagnostics: count-based SQLite vs sensor enroll count. Holds SENSOR_LOCK briefly. Returns `{db_count, sensor_count, db_ids, sensor_ids:[], orphans_estimate, missing_estimate}`. |
| POST | `/api/scan` | open (real `sensor:real` blocks `studentId` 403) | Real identify `POST {waitSec 1-30}` (UI uses 2) or `POST {studentId}` (sim/tests). Returns `PRESENT/LATE` + `seq` on ok, or `reason DUPLICATE/NOT_SCHEDULED/NON_WORKING_DAY/UNKNOWN/NEED_STUDENT_ID/NO_FINGER/SENSOR_BUSY/SENSOR_DISCONNECT` + `seq` when event written. `NO_FINGER/SENSOR_BUSY/UART` create no event. `NOT_SCHEDULED` shown muted never absent. |
| GET | `/api/scan/last` | open | Latest `events` where `source='GT511C3'` (whitelist, excludes `RECONCILE`/`CORRECTION`): `{seq=rowid, result, status, date, time, fingerId, student|null}` for bridge poller. |
| POST | `/api/reconcile` | header only | `POST {date}` marks `daily` `ABSENT` (scheduled + no daily) or `NOT_SCHEDULED` (not scheduled) after `lateCutoff`; today guarded `BEFORE_CUTOFF` if `now < lateCutoff`. Called by UI on `loadTodayAttendance` with `_noPrompt` to avoid background PIN prompts. |
| GET | `/api/attendance` | open | `?date=YYYY-MM-DD` or all 2000 `events` (`limit`+`offset` optional). |
| GET | `/api/daily` | open | `?date` or all `daily` (`limit`+`offset` optional). |
| GET | `/api/kpis` | open | `?date=&class=&batch=` → `{total,scheduled,present,late,absent,notScheduled,date}` canonical `is_student_scheduled()` (batch `Grade|Batch` → batch → class → global). |
| GET | `/api/reports` | open | `?studentId` required + optional `&start=&end=YYYY-MM-DD` → `{present,late,absent,eligible,attended,rate,buckets[11],start,end}` over `start→end` (default `attendanceStartDate→today_ist`) scheduled only, windowed `daily` counts. |
| POST | `/api/correction` | header only | Attendance correction with audit: `POST {date, studentId, status∈PRESENT/LATE/ABSENT/NOT_SCHEDULED, reason 3-300}` → updates `daily` + `events CORRECTION` + `audit ATTENDANCE_CORRECTED`. `DB_LOCK` + `BEGIN IMMEDIATE` atomic. |
| GET | `/api/export/csv` | header only | `?type=students|attendance &date&start&end&class&studentId&status` → CSV (students includes `batch/section/parent/address/rate` + `photo` data URL; attendance limit 5000, joins class). |
| POST | `/api/import/csv` | header only | Multipart `file` or JSON `csv` text; header-insensitive `name/roll/class/batch/section/parent/phone/address`; validates, skips duplicate roll, auto-adds class/batch. `DB_LOCK` + `BEGIN IMMEDIATE` batch atomic. |
| GET | `/api/export` | header only | JSON `{settings, students, events 5000, daily 5000}` (`daily` now bounded 5000). |
| GET | `/api/backup` | header only | `PRAGMA wal_checkpoint TRUNCATE` → `send_file` DB `atl_backup_YYYY-MM-DD.db` (includes students/daily/events/settings incl. `classSchedules/batchSchedules/holidays/overrides` + audit + `images` table, but not `IMAGES_DIR` filesystem files nor GT-511C3 flash). `api(...,responseType:"blob")` sends `X-Admin-Pin` header, no `?pin=`. |
| POST | `/api/restore` | header only | `file` or raw body ≥100B must start `SQLite format 3\x00` → `.incoming` → `PRAGMA integrity_check` + required tables → `SENSOR_LOCK` then `DB_LOCK` 30s → `.pre_restore.bak` rotation → `os.replace` atomic (Windows retry). `api(...,body:FormData)` header-only, no `?pin=`. |
| GET | `/api/backup/gdrive/status` | header only | Cloud backup status `{enabled, configured, authenticated, deviceFlow, inProgress, lastBackup, lastBackupName, lastStatus, lastError}`. |
| POST/GET | `/api/backup/gdrive/device-start` | header only | Start Google Device Authorization Grant (RFC 8628): requests `user_code` and `verification_url` from Google with `drive.file` scope. |
| POST | `/api/backup/gdrive/device-poll` | header only | Poll Google token endpoint for device authorization completion: returns `{status: "pending"|"slow_down"|"success"|"error"}`. Saves tokens with 0600 permissions upon approval. |
| POST | `/api/backup/gdrive/device-cancel` | header only | Cancel active device authorization session. |
| POST | `/api/backup/gdrive/disconnect` | header only | Disconnect Google Drive integration and delete stored token file. |
| GET/POST | `/api/backup/gdrive/schedule` | header only | Get or update versatile cloud backup schedule `{enabled, time, frequency (daily|interval|weekdays), intervalDays, weekdays}`. Persisted safely in SQLite `settings` table with audit trail. |
| POST | `/api/backup/gdrive/backup` | header only | Trigger manual Google Drive backup now. Takes online SQLite snapshot under lock, checks integrity, uploads in resumable chunks, prunes retention. |
| GET | `/api/backup/gdrive/list` | header only | List available cloud backup snapshots in dedicated Drive folder. |
| POST | `/api/backup/gdrive/restore` | header only | Restore from cloud backup: `POST {fileId}`. Downloads to `.incoming`, validates integrity and tables, creates `.pre_restore.bak`, atomically replaces DB. Operator-initiated only. |
| GET/DELETE | `/api/images` | GET open (deduplicated 60), DELETE header only | List combined `images` + `settings.imageGallery` deduplicated 60 / clear all (removes FS files from canonical `IMAGES_DIR` and legacy mirror). |
| DELETE | `/api/images/:id` | header only | Delete one (DB + FS file). |
| POST | `/api/images/upload` | header only | Multipart `file ≤2MB` → single `IMAGES_DIR` file + `images` row (no duplicate `assets` mirror). |
| GET | `/api/images/file/:name` | open | Serve from `IMAGES_DIR`. |
| GET | `/api/notifications` | open | Last 50. |
| GET | `/api/audit` | header only | Last 500 `ORDER BY rowid DESC`. Safe check for Admin open via `GET /api/audit` (no sensor). |

## Status / Data Conventions
* Backend uppercase `PRESENT/LATE/ABSENT` + `DUPLICATE/UNKNOWN/NOT_SCHEDULED/NON_WORKING_DAY`. UI `Present/Late/...`. `classify()` : `time≤presentCutoff(08:00)→PRESENT`, `else LATE` (even after `lateCutoff`); `ABSENT` only via `POST /api/reconcile` after `lateCutoff`; `halfDayCutoff` reserved, not classified. Same-day re-scan not `ABSENT/NOT_SCHEDULED` → `DUPLICATE`.
* `fingerId` integer (`1..199`) ↔ UI `fid "F-<n>"`. Bridge maps `fingerId→fid`, syncs `class←grade` into `atl_students`, calls `handleRealScan(fid,{status,time,date,seq})`; unknown → `__unknown__<seq>`. SQLite truth, LocalStorage display copy. `sensor/uart/baud/db/host/port/imagesDir/adminPin` read-only via API.
* Live terminal `POST /api/scan {waitSec:2}` when Admin closed; never fabricates on `NO_FINGER`. Enrollment: one Start → 3 lifts. Scan bridge polls `GET /api/scan/last` `source='GT511C3'` whitelist every 2s but not while Admin open (`adminLayer/enrollModal` guard); `handleRealScan` seq dedup; Admin open via `GET /api/audit` header-only check (no sensor).

## Examples
```bash
curl http://192.168.1.8:5000/api/health
curl http://192.168.1.8:5000/api/students
curl -X POST http://192.168.1.8:5000/api/scan -H "Content-Type: application/json" -d "{\"studentId\":1}"
curl -X POST http://192.168.1.8:5000/api/scan -H "Content-Type: application/json" -d "{\"waitSec\":2}"
curl -X POST http://192.168.1.8:5000/api/correction -H "Content-Type: application/json" -d '{"date":"2026-08-30","studentId":1,"status":"PRESENT","reason":"verified"}'
curl -X POST http://192.168.1.8:5000/api/reconcile -H "Content-Type: application/json" -d "{}"
curl -s http://192.168.1.8:5000/ | grep -o "ATL Smart Attendance Terminal"
```

*Aligned 2026-09-02 with `backend/app.py` `backend/gdrive_backup.py` `backend/ui_app.js`.*
