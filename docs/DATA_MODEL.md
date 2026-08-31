# DATA_MODEL — Tables, fields, and rules

## Storage

SQLite via `backend/schema.sql:1` with `PRAGMA journal_mode=WAL` and `foreign_keys=ON`. The database file is `/var/lib/atl/attendance.db` on the Pi, `backend/attendance.db` on Windows (`app.py:12`), defined in `backend/config.json` (`db`, `host`, `port`, `uart`, `baud`, `sensor`, `imagesDir`). Settings live in the `settings` table as JSON under key `config`; migrations in `get_settings()` (`app.py:161`) and `_migrate_db()` (`app.py:105`) add columns and indexes additively without losing history. Photos are stored as data URLs in `students.photo` plus files under `IMAGES_DIR` (`/var/lib/atl/images` on Pi, `backend/uploads` on Windows). The GT-511C3 flash store (IDs 1-199) is the second source of truth; `students.fingerId` maps to it. An alias `fingerId ↔ fid "F-<n>"` is applied in `ui_app.js:110` and in the scan bridge.

## Tables

`students(id PK, name NOTNULL, roll UNIQUE NOTNULL, grade NOTNULL, batch, section, parent, phone, address, fingerId UNIQUE, photo, active, createdAt)` — `grade` is Class (e.g. `Grade 10-A`), `batch` is Batch/Group, `section` and `parent` kept. Indexes on `fingerId` and `roll`.

`events(id PK TEXT, date TEXT, time TEXT, studentId INT, fingerId INT, result TEXT, status TEXT, source TEXT, at TEXT)` — one row per scan or system action. `source` values include `GT511C3`, `RECONCILE`, `CORRECTION`.

`daily(key PK TEXT "date|studentId", date TEXT, studentId INT, status TEXT, firstScan TEXT, lastScan TEXT)` — one row per student per date; `firstScan` is preserved on duplicates.

`settings(key PK, value TEXT JSON)`, `audit(id PK, at TEXT, action TEXT, details TEXT)`, `images(id PK, url, name, category, at)`, `notifications(id PK, studentId, createdAt, status, message, attempts)`. Indexes on `events(date, studentId)` and `daily(date, studentId)`.

## Validation

`POST /api/students`, `POST /api/enroll`, and `PATCH /api/students/:id` enforce: `name 1-80`, `roll 1-20 unique lower()` case-insensitive, `grade 1-40 required`, `batch ≤40`, `section ≤20`, `parent ≤80`, `phone ≤40` with at least 8 digits when present, `address ≤200`, `photo` via `_photo_ok()` (`PHOTO_MAX 2_800_000` in `app.py:36`, roughly 2MB file as data URL). New `grade` or `batch` values auto-create entries in `settings.classes`/`batches`. `PATCH` re-activation (`active 1`) restores a roll ending in `#d{id}` when still free. `DELETE` frees the slot as `active=0, roll=roll#d{id}, fingerId=NULL` after deleting the sensor template.

`POST /api/settings` accepts only whitelisted keys (`schoolName, address, region, academicYear, schoolOpeningDate, attendanceStartDate, presentCutoff, lateCutoff, halfDayCutoff, minPercent, classes, batches, holidays, overrides, workingDays, classSchedules, batchSchedules, schoolLogo, planetImage, heroImage, imageGallery, trajectoryLabels`). Hardware keys `sensor/uart/baud/db/host/port/imagesDir` are file-only. Holidays are `YYYY-MM-DD[..YYYY-MM-DD]:type:name` with `type holiday|vacation|exam` (`exam` is working) as parsed in `app.py:191`; overrides use `YYYY-MM-DD:0/1:note` or dict form. `presentCutoff ≤ lateCutoff` is validated.

## Statuses and scheduling

Backend statuses are uppercase: `PRESENT`, `LATE`, `ABSENT`, `DUPLICATE`, `UNKNOWN`, `NOT_SCHEDULED`, `NON_WORKING_DAY`, `NEED_STUDENT_ID`; the UI maps them via `statusUI()` (`ui_app.js:52`) to `Present/Late/Absent/Already recorded/Unknown/Not Scheduled`. `classify()` (`app.py:360`) uses `presentCutoff 08:00` and `lateCutoff 08:30`. A same-day re-scan when `daily` is already `PRESENT`/`LATE`/`DUPLICATE` writes `DUPLICATE`. Eligibility uses `is_student_scheduled()` (`app.py:309`): `override → holiday/vacation/exam → weekly`. Weekly resolution in `_get_working_days_for_student()` (`app.py:278`) is `Grade|Batch` composite → batch → class → global, each as `{workingDays:{0..6}}` or flat `{0..6}` with Sunday 0. Default `DEFAULT_WORKING_DAYS app.py:70` is Sunday off, Monday-Saturday on.
