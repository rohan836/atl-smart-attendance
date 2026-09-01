# DATA_MODEL — Tables, fields, and rules

## Storage

SQLite via `backend/schema.sql` with `PRAGMA journal_mode=WAL` and `foreign_keys=ON`. The database file is `/var/lib/atl/attendance.db` on the Pi, `backend/attendance.db` on Windows (`app.py`), defined in `backend/config.json` (`db`, `host`, `port`, `uart`, `baud`, `sensor`, `imagesDir`). Settings live in the `settings` table as JSON under key `config`; migrations in `get_settings()` and `_migrate_db()` add columns and indexes additively without losing history. Student photos are data URLs in `students.photo` (validated `PHOTO_MAX 2_800_000` in `app.py`, backed up in SQLite); gallery uploads are single files under canonical `IMAGES_DIR` (`/var/lib/atl/images` on Pi, `backend/uploads` on Windows, no duplicate `dev_mirror`, no-overwrite suffix, `DELETE` removes file). The GT-511C3 flash store (IDs 1-199) is the second source of truth; `students.fingerId` maps to it. An alias `fingerId ↔ fid "F-<n>"` is applied in `ui_app.js` and in the scan bridge. SQLite backup (`GET /api/backup` with `wal_checkpoint`) contains `students.photo` but not gallery filesystem files.

## Tables

`students(id PK, name NOTNULL, roll UNIQUE NOTNULL, grade NOTNULL, batch, section, parent, phone, address, fingerId UNIQUE, photo, active, createdAt)` — `grade` is Class (e.g. `Grade 10-A`), `batch` is Batch/Group, `section` and `parent` kept. Indexes on `fingerId` and `roll`.

`events(id PK TEXT, date TEXT, time TEXT, studentId INT, fingerId INT, result TEXT, status TEXT, source TEXT, at TEXT)` — one row per scan or system action. `source` values include `GT511C3`, `RECONCILE`, `CORRECTION`.

`daily(key PK TEXT "date|studentId", date TEXT, studentId INT, status TEXT, firstScan TEXT, lastScan TEXT)` — one row per student per date; `firstScan` is preserved on duplicates.

`settings(key PK, value TEXT JSON)`, `audit(id PK, at TEXT, action TEXT, details TEXT)`, `images(id PK, url, name, category, at)`, `notifications(id PK, studentId, createdAt, status, message, attempts)`. Indexes on `events(date, studentId)` and `daily(date, studentId)`.

## Validation

`POST /api/students`, `POST /api/enroll`, and `PATCH /api/students/:id` enforce: `name 1-80`, `roll 1-20 unique lower()` case-insensitive, `grade 1-40 required`, `batch ≤40`, `section ≤20`, `parent ≤80`, `phone ≤40` with at least 8 digits when present, `address ≤200`, `photo` via `_photo_ok()` (`PHOTO_MAX 2_800_000` in `app.py`, roughly 2MB file as data URL). New `grade` or `batch` values auto-create entries in `settings.classes`/`batches`. `PATCH` re-activation (`active 1`) restores a roll ending in `#d{id}` when still free. `DELETE` frees the slot as `active=0, roll=roll#d{id}, fingerId=NULL` after deleting the sensor template.

`POST /api/settings` accepts only whitelisted keys (`schoolName, address, region, academicYear, schoolOpeningDate, attendanceStartDate, presentCutoff, lateCutoff, halfDayCutoff, minPercent, classes, batches, holidays, overrides, workingDays, classSchedules, batchSchedules, schoolLogo, planetImage, heroImage, imageGallery, trajectoryLabels`). Hardware keys `sensor/uart/baud/db/host/port/imagesDir` are file-only. Holidays are `YYYY-MM-DD[..YYYY-MM-DD]:type:name` with `type holiday|vacation|exam` (`exam` is working) as parsed in `app.py`; overrides use `YYYY-MM-DD:0/1:note` or dict form. `presentCutoff ≤ lateCutoff` is validated.

## Statuses and scheduling

Backend statuses are uppercase: `PRESENT`, `LATE`, `ABSENT`, `DUPLICATE`, `UNKNOWN`, `NOT_SCHEDULED`, `NON_WORKING_DAY`, `NEED_STUDENT_ID`; the UI maps them via `statusUI()` to `Present/Late/Absent/Already recorded/Unknown/Not Scheduled`. `classify()` in `app.py` uses `presentCutoff 08:00` and `lateCutoff 08:30`. A same-day re-scan when `daily` is already `PRESENT`/`LATE`/`DUPLICATE` writes `DUPLICATE`. Eligibility uses `is_student_scheduled()`: `override → holiday/vacation/exam → weekly`. Weekly resolution in `_get_working_days_for_student()` is `Grade|Batch` composite → batch → class → global, each as `{workingDays:{0..6}}` or flat `{0..6}` with Sunday 0. Default `DEFAULT_WORKING_DAYS` is Sunday off, Monday-Saturday on. Calendar dates are `YYYY-MM-DD` in both layers: backend `today_ist()` (IST `+05:30`) and frontend `todayISO()`/`toLocalISO()` use local `getFullYear/Month/Date` (no `toISOString()`), so `renderCalendarMonth` and report `week`/`month` ranges never shift across UTC.
