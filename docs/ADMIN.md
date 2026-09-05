# ADMIN — Responsibilities and functions

Admin is gated behind the terminal's `Admin` trigger and is organized into four unified tabs: **Students**, **Attendance**, **Setup**, and **Backup**. It is the only place that mutates roster, schedules, and school settings. The terminal scan loop continues in the background while Admin is open (recording scans and refreshing Attendance live while suppressing the full-screen identity popup); it pauses exclusively during enrollment modals and sensor maintenance.

All four tabs share one toolbar geometry (52px single row, same pads/gaps/bottom bar/20px gap; overflow scrolls barlessly). Setup and Backup carry an empty spacer toolbar (reserved for future controls). Attendance filters are text-only like the preset pills (no underlines); custom range/academic pick via the frost popup, Custom Date keeps its single inline field, and the inline Apply button is retired (popup commits, single date auto-renders) — the bar holds one row in every preset state.

## Students

Owns the roster. Search spans name, roll, class, batch, phone, fingerprint ID, section and parent. Filters are class, batch, and status (Active only / All / Inactive only). The toolbar holds New Enrollment, Import CSV, and Export CSV. The form collects name (1-80), roll (1-20 unique lower), grade/class (1-40 required), batch/group (≤40), section (≤20), parent (≤80), phone (≤40 with 8+ digits), address (≤200), and photo as data URL (≤2MB, stored in `IMAGES_DIR` plus `students.photo`). Validation and auto-creation of classes/batches happens in `POST /api/students` and `POST /api/enroll`.

Detail cards show the last 60 events and actions: Edit (whitelisted `PATCH /api/students/:id`), Re-enroll, Deactivate (`DELETE` → `active=0, roll#d{id}, fingerId=NULL`), Re-activate (`PATCH active=1` restores roll if free), and Print. History bundles `events` 500 and `daily` 500. CSV export includes `batch/section/parent/address/attendance_rate`.

## Attendance (Unified Today & Reports Workspace)

Unifies live operations and historical reporting into a single screen:
- **Default View:** Defaults immediately to today's live attendance upon opening, with a green `LIVE TODAY` badge, working day vs. holiday status, and scheduled vs. not scheduled breakdown.
- **Unified Filter Bar:** Fast date controls (Today, Yesterday, Custom Date, Custom Date Range, Last 7 Days, This Month, Academic Year), explicit `Apply` button for custom dates, Class filter, Batch filter, Student filter/search (`All Students` or single student), Status filter (All, Present, Late, Absent, Not Scheduled, Duplicate), and Sort ordering.
- **Single Student Reporting:** Direct single student selection in Attendance toolbar, authoritative student metrics via `/api/reports?studentId`, student-specific 9 KPI cards (`Eligible days`, `Attended`, `Attendance %`), student-specific editorial Print output, and single-student CSV export.
- **9 KPI Cards:** In both live and historical modes: `Date`, `Total students`, `Present`, `Late`, `Absent`, `Not Scheduled`, `Unknown scans`, `Duplicate scans`, and `Attendance %`.
- **Dynamic Attendance Table:**
  - *Single-Day Mode:* Columns for Time, Student, Roll, Class, Status with `[Correct]` button, and Fingerprint ID.
  - *Multi-Day Mode:* Columns for Date, Time, Student, Roll, Class, Status with `[Correct]` button, and Working Day (`Scheduled` vs `Not Scheduled`).
- **Operational Data:** Live unknown scan attempts list with count, time, fingerprint slot, and note.
- **Actions:** In-place `Refresh` (re-loads sensor events and recalculates), live auto-refresh on real scans and 15-second background poller, `Print` (professional editorial report layout with header, metadata, 9 KPI cards, table, and unknown attempts), and `Export CSV` (streaming backend export for both single-day and multi-day ranges with class, batch, student, and status filtering).

## Setup (Unified School Configuration & Schedule)

Unifies school settings, classes, batches, rules, calendar, holidays, and schedule inheritance:
- **School Information & Rules:** Name, address, academic year, attendance start date, present cutoff, and late cutoff.
- **Classes & Batches (tabbed master-detail, student mirror):** Left bar (340/280/360px + 24px gutter, ends at the wall) stacks the CLASSES|BATCHES text tabs over one list of 56px frost tiles plus the matching input + text Add — one list, one add, one geometry per view, so switching never shifts widths or heights. A 1px wall divides the bar from the right detail pane (28px gutter), which carries the solid editor for the selected tile (locked-28px head + hairline + weekday toggles + Present/Late cutoffs + inherit notice + Save, one persist path); first class is default-selected. Tile click swaps the right card only (`renderCubeDetail` into `#classDetail`), same as `selectStudent`. Batch creation lives only in the left bar (BATCHES tab) via the single `submitBatchName` path. New batch names surface in the BATCHES tab until a student carries them into a class. Below: priority note, full-width Month View (legend bar with context selector + Prev/Month/Next/Today + grid + helper line), then Holidays/Overrides tables.
- **Schedule Context Selector:** Switch between Global, Class, and Batch contexts (sits on the month-view bar, middle, right of OVERRIDE — it IS the context readout, no separate pill).
- **Schedule editor (solid, single):** The right detail pane carries the schedule editor for the selected class/batch — weekday toggles, Present/Late cutoffs with inherit notice, `Save`, one persist path. Setup shows the stacks, selector, read-only month, and tables — class/batch schedule editing lives only in the pane.
- **Weekly Template, Holidays & Overrides:** Month View (headers + resolved day cells) is display-only; weekday toggles and per-context Present/Late timing live in the solid schedule editor. Holiday ranges (`holiday`, `vacation`, `exam`) and single-date overrides are created, edited, and removed through their list tables (`+ Add Holiday`, `+ Add Override`, table Edit/Remove via `#holidayModal`/`#overrideModal`). Month cells open the read-only day window; the window offers an `Add override for this date…` shortcut into the override modal (door only — tables stay the single editor).

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
