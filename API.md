# API — Backend service layer

Base: `http://192.168.1.8:5000` (Pi) or `http://127.0.0.1:5000` (local). Server: `backend/app.py` (Flask 3.x).

> UI is DB-driven: fetches SQLite via `/api/students /settings /attendance /audit /daily /kpis` and enrolls via `/api/enroll`. At serve, `backend/app.py:439` splices `backend/ui_app.js` into `ATL-Smart-Attendance-Production.html` (HTML file untouched) and injects poller `GET /api/scan/last` → `window.handleRealScan(fid,{status,time,date,seq})`.

## Pages / static
| Route | Serves |
|-------|--------|
| `/` | `ATL-Smart-Attendance-Production.html` (with injected `ui_app.js` + bridge) `Cache-Control: no-store` |
| `/assets/<path>` | Files under `assets/` |
| Other non-`/api`, non-`/assets` | Main UI (404 fallback) |

## Endpoints
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/health` | `{ok,status,sensor,sensor_detail,clock,db,db_ok,imagesDir,sensor_mode,settings}`. `sensor:real` → `offline` until GT-511C3 answers `/dev/serial0`. UART ping cached 25s to avoid `SENSOR_LOCK` fight. |
| GET/POST | `/api/settings` | GET omits `sensor/uart/baud/db/host/port/imagesDir`. POST whitelist: `schoolName, address, region, academicYear, schoolOpeningDate, attendanceStartDate, presentCutoff, lateCutoff, halfDayCutoff, minPercent, classes, batches, holidays, overrides, workingDays, classSchedules, batchSchedules, schoolLogo, planetImage, heroImage, imageGallery, trajectoryLabels`. Holidays `YYYY-MM-DD[..YYYY-MM-DD]:type:name` `type holiday|vacation|exam` (exam=working). Overrides `YYYY-MM-DD:0/1:note` or dict. `workingDays {0..6 bool}` Sun=0. `classSchedules/batchSchedules {key: workingDays}` keys ≤80, ≤50 entries. Validates dates/times and `presentCutoff ≤ lateCutoff`. |
| GET/POST | `/api/students` | GET `?q & ?class & ?active=all` + computed `attendance_rate` from `daily`. POST create validates `name(1-80), roll(1-20 unique lower), grade(1-40 required), batch≤40, section≤20, parent≤80, phone≤40 digits≥8, address≤200`; auto-creates class/batch in settings. |
| GET | `/api/students/:id` | Single + `events` 500 + `daily` 500 + `stats {present,late,duplicate,unknown}`. |
| PATCH | `/api/students/:id` | Whitelist `photo≤8000, phone, address, name, roll, grade, batch, section, parent, active`. Roll unique, grade auto-adds class. |
| DELETE | `/api/studies/:id` | Deletes sensor template `GT511C3.delete_id` (sim OK, offline DB-free if `sensor:real` no HW) then `active=0, roll=roll#d{id}, fingerId=NULL` (keeps history). |
| POST | `/api/students/:id/reenroll` | Allocates new `fingerId` 1..199, `SENSOR_LOCK → GT511C3.enroll(newFid)` 3 captures, deletes old fid. |
| POST | `/api/enroll` | Create + enroll: validates as `/api/students`, `SENSOR_LOCK → GT511C3.enroll(fid)` 3 lifts → insert student + audit `STUDENT_ENROLLED`. Long timeout ~180s. On `hardware_unusable` 503. Progress via `GET /api/sensor/progress`. |
| GET | `/api/sensor/progress` alias `/api/enroll/progress` | `{mode,step,state,title,detail,timeout_sec,remain_sec,finger,raw}` live enroll/scan wait. |
| POST | `/api/scan` | Real identify `POST {waitSec 1-30}` (UI uses 2) or legacy `POST {studentId}` sim. Returns `PRESENT/LATE` + `seq` on ok, or `reason DUPLICATE/NOT_SCHEDULED/NON_WORKING_DAY/UNKNOWN/NEED_STUDENT_ID/NO_FINGER/SENSOR_BUSY/SENSOR_DISCONNECT` + `seq` when event written. `NO_FINGER/SENSOR_BUSY/UART` create no event. `NOT_SCHEDULED` shown muted never absent. |
| GET | `/api/scan/last` | Latest `events` excluding `RECONCILE`: `{seq=rowid, result, status, date, time, fingerId, student|null}` for bridge poller. |
| POST | `/api/reconcile` | `POST {date}` marks `daily` `ABSENT` (scheduled + no daily) or `NOT_SCHEDULED` (not scheduled) after `lateCutoff`; today guarded `BEFORE_CUTOFF` if `now < lateCutoff`. Called by UI on `loadTodayAttendance`. |
| GET | `/api/attendance` | `?date=YYYY-MM-DD` or all 2000 `events`. |
| GET | `/api/daily` | `?date` or all `daily`. |
| GET | `/api/kpis` | `?date=&class=&batch=` → `{total,scheduled,present,late,absent,notScheduled,date}` canonical `is_student_scheduled()` (batch `Grade|Batch` → batch → class → global). |
| GET | `/api/reports` | `?studentId` required → `{present,late,absent,eligible,attended,rate,buckets[11]}` over `attendanceStartDate→today` scheduled only. |
| POST | `/api/correction` | Attendance correction with audit: `POST {date, studentId, status∈PRESENT/LATE/ABSENT/NOT_SCHEDULED, reason 3-300}` → updates `daily` + `events CORRECTION` + `audit ATTENDANCE_CORRECTED`. |
| GET | `/api/export/csv` | `?type=students|attendance &date&start&end&class&studentId&status` → CSV (students includes `batch/section/parent/address/rate`; attendance limit 5000, joins class). |
| POST | `/api/import/csv` | Multipart `file` or JSON `csv` text; header-insensitive `name/roll/class/batch/section/parent/phone/address`; validates, skips duplicate roll, auto-adds class/batch. |
| GET | `/api/export` | JSON `{settings, students, events 5000, daily}`. |
| GET | `/api/backup` | `PRAGMA wal_checkpoint TRUNCATE` → `send_file` DB `atl_backup_YYYY-MM-DD.db` (includes students/daily/events/settings incl. `classSchedules/batchSchedules/holidays/overrides` + audit). |
| POST | `/api/restore` | `file` or raw body ≥100B must start `SQLite format 3\x00` → `.pre_restore.bak` → overwrite DB → verify `SELECT 1 FROM students`. |
| GET/DELETE | `/api/images` | List combined `images` + `settings.imageGallery` 60 / clear all. |
| DELETE | `/api/images/:id` | Delete one. |
| POST | `/api/images/upload` | Multipart `file ≤2MB` → `IMAGES_DIR` + `images` row. |
| GET | `/api/images/file/:name` | Serve from `IMAGES_DIR`. |
| GET | `/api/notifications` | Last 50. |
| GET | `/api/audit` | Last 500 `ORDER BY rowid DESC`. |

## Status / Data Conventions
* Backend uppercase `PRESENT/LATE/ABSENT` + `DUPLICATE/UNKNOWN/NOT_SCHEDULED/NON_WORKING_DAY`. UI `Present/Late/...`. `classify()` `app.py:322`: `time≤presentCutoff(08:00)→PRESENT`, `time≤lateCutoff(08:30)→LATE`, `else LATE`; same-day re-scan not `ABSENT/NOT_SCHEDULED` → `DUPLICATE`.
* `fingerId` integer (`1..199`) ↔ UI `fid "F-<n>"`. Bridge maps `fingerId→fid`, syncs `class←grade` into `atl_students`, calls `handleRealScan(fid,{status,time,date,seq})`; unknown → `__unknown__<seq>`. SQLite truth, LocalStorage display copy. `sensor/uart/baud/db/host/port/imagesDir` read-only via API.
* Live terminal `POST /api/scan {waitSec:2}` when Admin closed; never fabricates on `NO_FINGER`. Enrollment: one Start → 3 lifts.

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

*Aligned 2026-08-30 with `backend/app.py:2056` `backend/ui_app.js:1421`.*
