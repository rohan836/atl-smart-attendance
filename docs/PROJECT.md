# PROJECT — ATL Smart Attendance Terminal

## What it is

ATL Smart Attendance is a fingerprint attendance terminal for a school running on a Raspberry Pi 3. A GT-511C3 optical sensor connected over UART hands a fingerprint template to a Flask backend that identifies the student, classifies attendance, records it in SQLite, and drives a single-page UI. The system is offline-first — daily operation requires no internet.

The target hardware is `lancer@192.168.1.8` (Pi 3 Model B, Debian 13). The same codebase runs on Windows for development using a simulated sensor and a local SQLite file at `backend/attendance.db`.

## What it does

The front page is a biometric terminal, not a dashboard — markup and CSS/layout live in `ATL-Smart-Attendance-Production.html`, behavior lives in `backend/ui_app.js`. Idle shows centered `PLACE YOUR FINGER` (11px, 0.22em) and a single `Admin` trigger bottom-middle. A finger on the sensor triggers identify, classify, record, and display. On success the UI shows a frameless result — photo, name, roll, class, section/batch, student ID, status and time — for about four seconds, then fades back to idle. Unknown fingerprints show `NOT RECOGNIZED` for under three seconds.

Admin is gated behind the terminal. Six tabs — Students, Today, Reports, Calendar, Settings, Backup — manage the school day without leaving the device. Students holds roster and enrollments; Today shows today's attendance; Reports aggregates ranges; Calendar owns schedules; Settings owns school identity and classes; Backup owns export and restore.

All operational truth lives in two places: the GT-511C3 template store (200 slots, IDs 1-199) and SQLite at `/var/lib/atl/attendance.db` on the Pi. Browser LocalStorage (`atl_*`) is a display cache only — it omits photos and is refreshed from `/api/*` on load and every 15 seconds. Never treat LocalStorage as authoritative.

## Who it serves

Students scan once per scheduled day. Teachers and office staff use Today and Reports to verify counts and eligibility. The administrator owns calendars, holidays, overrides, class lists, and backups. Deployment is single-school, single Pi, single sensor, single database.

## Behavior principles

Attendance is recorded, not inferred. The first scan on a scheduled day is `PRESENT` if at or before `presentCutoff` (08:00), otherwise `LATE`. A second scan the same day is `DUPLICATE` (`Already recorded`) and preserves the first timestamp. `NOT_SCHEDULED` means the student had no class that day — shown muted, never counted as absent. `ABSENT` is written only by `POST /api/reconcile` after `lateCutoff` (08:30) has passed. Holidays of type `exam` count as working; `holiday` and `vacation` do not.

Scheduling precedence is strict: specific-date override, then holiday range, then weekly schedule. Weekly resolution is per-student: composite `Grade|Batch`, then batch, then class, then global.

## Non-goals

The terminal does not send SMS, does not sync to a cloud, does not run multiple sensors, does not fabricate scans when no finger is present, and does not mark absent before the cutoff. Reports are read-only views of `daily` and `events`; corrections are explicit operations with an audit trail.
