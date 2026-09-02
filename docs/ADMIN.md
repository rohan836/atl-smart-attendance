# ADMIN — Responsibilities and functions

Admin is gated behind the terminal's `Admin` trigger and is organized into six tabs. It is the only place that mutates roster, schedules, and school settings. The terminal scan loop pauses while Admin or the enroll modal is open and resumes on close.

## Students

Owns the roster. Search spans name, roll, class, batch, phone, fingerprint ID, section and parent. Filters are class, batch, and status (Active only / All / Inactive only). The toolbar holds New Enrollment, Import CSV, and Export CSV. The form collects name (1-80), roll (1-20 unique lower), grade/class (1-40 required), batch/group (≤40), section (≤20), parent (≤80), phone (≤40 with 8+ digits), address (≤200), and photo as data URL (≤2MB, stored in `IMAGES_DIR` plus `students.photo`). Validation and auto-creation of classes/batches happens in `POST /api/students` and `POST /api/enroll`.

Detail cards show the last 60 events and actions: Edit (whitelisted `PATCH /api/students/:id`), Re-enroll, Deactivate (`DELETE` → `active=0, roll#d{id}, fingerId=NULL`), Re-activate (`PATCH active=1` restores roll if free), and Print. History bundles `events` 500 and `daily` 500. CSV export includes `batch/section/parent/address/attendance_rate`.

## Today

Current-day view. Stats from `GET /api/kpis?date=today` (via `is_student_scheduled`): Total, Scheduled, Present, Late, Absent, Not Scheduled, Unknown, Duplicate, percent. Filters are class, status, and sort (time/name/roll/class). Main table lists today's `events`; second table lists unknown attempts. `Not Scheduled` is muted, never absent. Print uses school header; CSV uses `?class&status`. Loads via `POST /api/reconcile` first.

## Reports

Aggregates over scopes: entire school, one class, or one student, and over time windows: today, week, month, academic year, or custom `from ≤ to` (validated). Student scope calls `GET /api/reports?studentId` which returns `present/late/absent/eligible/attended/rate/buckets[11]` counting only scheduled days from `attendanceStartDate` to today. Print and CSV use `GET /api/export/csv?type=attendance&start&end&class&studentId&status` (limit 5000).

## Calendar

Schedule only — not events. Weekly toggles control global working days (Sunday=0). Per-class selection via `calClassSelect` shows the effective weekly map for that class; batch composites `Grade|Batch` are also persisted. Holidays are global ranges `YYYY-MM-DD[..YYYY-MM-DD]:type:name` where `type` is `holiday|vacation|exam`; `exam` counts as working. Overrides are global single-date entries `YYYY-MM-DD:0/1:note` or dict form. Both holidays and overrides are backend-persisted in `POST /api/settings` (`classSchedules`/`batchSchedules`) and included in the database backup — they are not UI-only. Month view and Today status reflect the resolved schedule.

## Settings

Single source for school identity: name, address, late threshold, academic year, and attendance start date. Classes are listed with student counts; adding a class here also makes it available during enrollment. Validation enforces `presentCutoff ≤ lateCutoff` and ISO dates.

## Backup

Backup supports two independent recovery layers:
1. **Local-file:** `GET /api/backup` checkpoints WAL and sends `atl_backup_YYYY-MM-DD.db` containing students, daily, events, settings (including `classSchedules/batchSchedules/holidays/overrides`), and audit. Restore via `POST /api/restore` validates the SQLite header `SQLite format 3\x00`, saves `.pre_restore.bak`, overwrites the DB file, and verifies `SELECT 1 FROM students`.
2. **Google Drive Cloud Backup:** Automated offsite backups to personal Google Drive using OAuth 2.0 Device Authorization Grant (RFC 8628) with least-privilege `drive.file` scope. The administrator connects directly via Google Device Flow (navigating to `google.com/device` and entering the code displayed in the UI), triggers immediate cloud backups, views historical snapshots in `ATL-Attendance-Backups`, and restores from cloud backups (never automatic, operator-initiated only). Daily backups run automatically via background worker with Grandfather-Father-Son retention (7 daily, 4 weekly, 12 monthly).

Audit history exports as CSV from the same tab. Calendar and schedule data travels with the backup.
