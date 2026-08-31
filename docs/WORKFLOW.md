# WORKFLOW — End-to-end flows

## Boot and data load

On page load `backend/ui_app.js:83` calls `cacheLoad()` from LocalStorage, then `loadAll()` fetches SQLite truth: `GET /api/settings`, `GET /api/students?active=all`, `GET /api/attendance`, `GET /api/attendance?date=today`, `GET /api/daily?date=today`, `GET /api/kpis?date=today`, and `GET /api/audit`. Results map through `mapStudent()` and `mapEvent()` and are cached via `cacheSave()` with photos stripped. The same refresh runs every 15 seconds while the tab is visible. Opening the app as `file://` is unsupported; it must be served from Flask at `/`.

## Scan cycle — terminal idle

The UI is DB-driven. When Admin and the enroll modal are closed and no result is held, `sensorScanLoop()` in `ui_app.js:481` posts `POST /api/scan {waitSec:2}`. The backend in `app.py:1612` acquires `SENSOR_LOCK`, calls `GT511C3.identify(timeout=waitSec)`, and waits for a finger via `wait_finger()` then `Capture` then `Identify`. Three outcomes create no persistence: `NO_FINGER` (400), `SENSOR_BUSY` (503), and UART errors return without writing `events` or `daily`. A parallel bridge poller `GET /api/scan/last` every 2 seconds (`app.py:426` injected `SCAN_BRIDGE_SCRIPT`) provides a fallback; both paths call `window.handleRealScan(fid, {status,time,date,seq,student})`.

On match the backend resolves `fingerId → student`, checks eligibility via `is_student_scheduled()`, classifies the timestamp via `classify()`, and writes `daily` and `events` plus `audit` and `notifications`. The response carries `{ok, status, time, date, seq, student}`. The UI upserts the student, shows the identity card, then re-arms the loop. Unknown fingerprints write an `UNKNOWN` event and resolve as `__unknown__<seq>` on the bridge. The scan loop never fabricates a student.

## Enrollment — three captures

Enrollment is form plus fingerprint. The operator fills name, roll, class and optional batch/section/parent/phone/address/photo in Students, then `Start scan`. The frontend posts `POST /api/enroll` with the form JSON. The backend validates lengths and uniqueness, allocates the next free `fingerId` in 1..199 via `next_finger_id()`, then under `SENSOR_LOCK` runs `GT511C3.enroll(fid)` — `initialize → LED ON → EnrollStart → EnrollN ×3` with `wait_press(40s)` → `capture best 8 retries` → `EnrollN` → `wait_remove(30s)`. Progress streams through `SENSOR_PROGRESS` and `GET /api/sensor/progress`. On success the student row is inserted with `fingerId` and audit `STUDENT_ENROLLED`; on failure the sensor template is cleaned and a hint is returned. The UI closes the modal and Admin via `returnToFrontPage()` and resumes scanning.

Re-enroll (`POST /api/students/:id/reenroll`) allocates a new ID, enrolls the new template, deletes the old template, and updates the row.

## Correction and reconciliation

`POST /api/correction {date, studentId, status, reason(3-300)}` updates `daily` and writes a `CORRECTION` event plus `ATTENDANCE_CORRECTED` audit. `POST /api/reconcile {date}` runs after `lateCutoff`; for each active student without a `daily` row it writes `ABSENT 23:59:59` if scheduled or `NOT_SCHEDULED 00:00:00` if not. Today is guarded with `BEFORE_CUTOFF` when now is before `lateCutoff`. Today and Reports both reflect these writes.

## Reports and export

Reports call `GET /api/reports?studentId` for per-student KPIs over `attendanceStartDate → today` counting only scheduled days, and `GET /api/export/csv` / `GET /api/attendance` for bulk tables. CSV import accepts header-insensitive `name/roll/class/batch/section/parent/phone/address`.
