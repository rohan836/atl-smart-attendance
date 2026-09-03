# ADMIN — Responsibilities and functions

Admin is gated behind the terminal's `Admin` trigger and is organized into four unified tabs: **Students**, **Attendance**, **Setup**, and **Backup**. It is the only place that mutates roster, schedules, and school settings. The terminal scan loop pauses while Admin or the enroll modal is open and resumes on close.

## Students

Owns the roster. Search spans name, roll, class, batch, phone, fingerprint ID, section and parent. Filters are class, batch, and status (Active only / All / Inactive only). The toolbar holds New Enrollment, Import CSV, and Export CSV. The form collects name (1-80), roll (1-20 unique lower), grade/class (1-40 required), batch/group (≤40), section (≤20), parent (≤80), phone (≤40 with 8+ digits), address (≤200), and photo as data URL (≤2MB, stored in `IMAGES_DIR` plus `students.photo`). Validation and auto-creation of classes/batches happens in `POST /api/students` and `POST /api/enroll`.

Detail cards show the last 60 events and actions: Edit (whitelisted `PATCH /api/students/:id`), Re-enroll, Deactivate (`DELETE` → `active=0, roll#d{id}, fingerId=NULL`), Re-activate (`PATCH active=1` restores roll if free), and Print. History bundles `events` 500 and `daily` 500. CSV export includes `batch/section/parent/address/attendance_rate`.

## Attendance (Unified Today & Reports Workspace)

Unifies live operations and historical reporting into a single screen:
- **Default View:** Defaults immediately to today's live attendance upon opening, with a green `LIVE TODAY` badge, working day vs. holiday status, and scheduled vs. not scheduled breakdown.
- **Unified Filter Bar:** Fast date controls (Today, Yesterday, Custom Date, Custom Date Range, Last 7 Days, This Month, Academic Year), Class filter, Batch filter, Status filter (All, Present, Late, Absent, Not Scheduled, Duplicate), and Sort ordering.
- **9 KPI Cards:** In both live and historical modes: `Date`, `Total students`, `Present`, `Late`, `Absent`, `Not Scheduled`, `Unknown scans`, `Duplicate scans`, and `Attendance %`.
- **Dynamic Attendance Table:**
  - *Single-Day Mode:* Columns for Time, Student, Roll, Class, Status with `[Correct]` button, and Fingerprint ID.
  - *Multi-Day Mode:* Columns for Date, Time, Student, Roll, Class, Status with `[Correct]` button, and Working Day (`Scheduled` vs `Not Scheduled`).
- **Operational Data:** Live unknown scan attempts list with count, time, fingerprint slot, and note.
- **Actions:** In-place `Refresh` (re-loads sensor events and recalculates), `Print` (professional editorial report layout with header, metadata, 9 KPI cards, table, and unknown attempts), and `Export CSV` (backend export for single day, frontend export for multi-day ranges).

## Setup (Unified School Configuration & Schedule)

Unifies school settings, classes, batches, rules, calendar, holidays, and schedule inheritance:
- **School Information & Rules:** Name, address, academic year, attendance start date, present cutoff, and late cutoff.
- **Classes & Batches:** Manage classes and section batches with student counts and quick schedule jumps.
- **Schedule Context Selector:** Switch between Global, Class, and Batch contexts with visual inheritance notices and timing controls (`Set Custom Timing`, `Revert to Inherited`).
- **Weekly Schedule & Holidays:** Weekly working day toggles, holiday range definitions (`holiday`, `vacation`, `exam`), single-date overrides, and live interactive Month View calendar.

## Backup

The Admin Backup tab presents a **Unified Backup Manager** (`#backupManagerCard`) consolidating offsite destinations, scheduled automation, and local database tools into a clean, compact interface:

1. **Unified Destinations:** Google Drive, Telegram, and USB are presented in a unified destinations list with live status indicators (`Ready`, `Connected`, `Not connected`, `Disabled`, or `Offline`). Each destination has an independent toggle checkbox (`#destCheckGdrive`, `#destCheckTelegram`, `#destCheckUsb`), and a "Select all" button (`#backupSelectAllBtn`) allows toggling all destinations simultaneously.
2. **Unified Automatic Backup Scheduler:** One shared scheduler (`#backupSchedBody`) configures backup time (`#backupSchedTime`), frequency (`#backupSchedFreq`: Daily, Every N days, Specific weekdays), and active weekdays. Clicking "Save Schedule" synchronizes the schedule across all three destination engines via `/api/backup/{gdrive,telegram,usb}/schedule`.
3. **Unified Execution and Live Refresh:**
   - **Back Up Now (`#backupNowBtn`):** Executes on-demand backups in parallel exclusively for the destinations currently checked, displaying granular status (e.g. `Google Drive: OK; Telegram: OK`) without blocking UI responsiveness.
   - **Refresh (`#backupRefreshBtn`):** Queries live status from all three engines asynchronously and updates status pills and the last backup timestamp without a full page reload (detecting USB plug/unplug events dynamically).
4. **Google Drive Integration Drawer:** Inline expandable drawer (`#gdriveAuthBox`) provides Device Authorization Flow controls (`Connect Google Drive`, user-code prompt, cancellation, and disconnection) and operator-initiated cloud snapshot listing/restores.
5. **Local SQLite Database Tools:**
   - **Download DB Backup:** `GET /api/backup` checkpoints WAL and sends `atl_backup_YYYY-MM-DD.db` containing students, daily, events, settings (including `classSchedules/batchSchedules/holidays/overrides`), and audit.
   - **Restore Database:** `POST /api/restore` validates the SQLite header `SQLite format 3\x00`, saves `.pre_restore.bak`, overwrites the DB file, and verifies `SELECT 1 FROM students`.
   - **Export Audit History:** Exports system audit history as CSV. Calendar and schedule data travels with the database backup.
