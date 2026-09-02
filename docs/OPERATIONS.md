# OPERATIONS — Pi, deploy, backup, recovery

## Target machine

Pi 3 Model B Rev 1.2, Debian 13 (trixie), user `lancer` (not `pi`), host `192.168.1.8` via wlan0. SSH key is `C:\Users\LaNcer\.ssh\id_ed25519`, host key `SHA256:jmqvz4JHHhyxlTlHeTw8Y20fzyZ7RUAJhbhDg1HpYm0`. On-Pi paths are DB `/var/lib/atl/attendance.db`, images `/var/lib/atl/images`, config `/opt/atl-attendance/backend/config.json`, app `/opt/atl-attendance`, venv `/opt/atl-attendance/venv`. On Windows the fallbacks are `backend/attendance.db` and `backend/uploads` (`app.py`). The live config template is `backend/config.example.json`; the live file `backend/config.json` is gitignored and contains `sensor real`, `uart /dev/serial0`, `baud 9600`, `db /var/lib/atl/attendance.db`, `host 0.0.0.0:5000`.

## Wiring

GT-511C3 to Pi only at 3.3V. VCC to 3.3V pin 1 — never 5V — GND to pin 6, sensor RX to GPIO14 / pin 8 (Pi TX), sensor TX to GPIO15 / pin 10. Baud is 9600. The driver in `gt511c3.py` expects `/dev/serial0` with `enable_uart=1` and `serial console off`. The service keeps the CMOS LED on (`keep_led_on=True` in `app.py`); `tools/led_test.py` is diagnostics only.

## Provisioning

One-time setup on the Pi:

```bash
sudo bash pi/setup.sh
# installs python3/venv/sqlite3, sets enable_uart=1 in /boot/firmware/config.txt,
# disables serial console, adds lancer to dialout+gpio, creates /opt/atl-attendance
# and /var/lib/atl, builds venv with Flask Flask-Cors pyserial, installs service
sudo reboot   # required for UART
curl http://127.0.0.1:5000/api/health
```

The service is `pi/atl-attendance.service`: `User=lancer`, `WorkingDirectory=/opt/atl-attendance`, `ExecStart=/opt/atl-attendance/venv/bin/python /opt/atl-attendance/backend/app.py`, `Restart=always`. Enable with `sudo systemctl enable --now atl-attendance`; inspect with `sudo systemctl status atl-attendance` and `journalctl -u atl-attendance -f`. Without sudo, `pkill -f "python.*app.py"` triggers the restart and `curl` the health endpoint.

## Autonomous reconciliation

Reconciliation runs automatically in the background via `_reconcile_daemon()` in `backend/app.py` (~every 60s). It dynamically reads `lateCutoff` from `settings` (default `08:30`). Once current IST time reaches `lateCutoff`, it queries SQLite for active students without a `daily` row for `today_ist()` (`SELECT COUNT(*) FROM students WHERE active=1 AND id NOT IN (SELECT studentId FROM daily WHERE date=?)`). If unresolved students exist, it executes `run_reconciliation()` under `DB_LOCK`, marks missing scheduled students as `ABSENT`, marks unscheduled students as `NOT_SCHEDULED`, and inserts an `ABSENCE_RECONCILIATION` audit entry.

- **Reboot / missed-run resilience**: If the Pi is powered off at cutoff (e.g. 08:30) and booted later (e.g. 10:15), the daemon detects unresolved students on its initial post-boot tick and automatically reconciles today's attendance.
- **Idempotence**: Existing `daily` and `events` rows are never overwritten; repeated evaluations produce zero duplicate records.
- **Observability**: Verification is visible via `journalctl -u atl-attendance` (`[RECONCILE] Auto-reconciled YYYY-MM-DD: ...`) and the `audit` table. Manual API invocation (`POST /api/reconcile`) remains fully functional.

## Remote Admin access (Tailscale)

ATL Smart Attendance supports secure private remote access to the existing Admin panel and backend via [Tailscale](https://tailscale.com) without exposing the kiosk to the public internet or changing application behavior.

- **Local access**: `http://192.168.1.8:5000` remains active and unchanged.
- **Remote HTTPS access**: `https://atl-attendance-pii.taile0547b.ts.net/` (and port 5000 `https://atl-attendance-pii.taile0547b.ts.net:5000/`) routes directly to the Flask application with automated Tailscale Let's Encrypt TLS certificates, eliminating "Not secure" browser warnings.
- **Security**: Tailscale traffic requires authentication on the operator's private Tailscale network. Public internet Funnel is **disabled** (tailnet only). All administrative actions require the configured `adminPin` (`X-Admin-Pin` header).
- **Management**:
  ```bash
  # Check Tailscale status and IP
  bash pi/tailscale_service.sh status
  bash pi/tailscale_service.sh ip

  # Authenticate node (one-time interactive login)
  bash pi/tailscale_service.sh login

  # Expose local Flask app over HTTPS
  bash pi/tailscale_service.sh serve
  ```

## Deployment

Canonical deploys copy only code and assets:

```powershell
powershell -File tools/deploy.ps1
# or
bash tools/deploy.sh
```

They copy `ATL-Smart-Attendance-Production.html`, `backend/app.py`, `backend/gdrive_backup.py`, `gt511c3.py`, `schema.sql`, `ui_app.js`, `assets/`, and `pi/atl-attendance.service` to `lancer@192.168.1.8:/opt/atl-attendance/`, then restart the service and check `curl http://127.0.0.1:5000/` title and `curl /api/health`. They never copy `attendance.db` or `config.json`, and exclude `*.backup.html` as a defensive safeguard if present (no working-tree backup HTML is kept — use Git history and tag `v1.0.0` for rollback), plus `.git/__pycache__/*.db/uploads/venv`. `deploy.sh` does not use `rsync --delete` because that would remove the Pi venv.

## Backup, restore, recovery

Backup runs `PRAGMA wal_checkpoint(TRUNCATE)` and sends the SQLite file as `atl_backup_YYYY-MM-DD.db` via `GET /api/backup` (requires `X-Admin-Pin` header, no `?pin=` query). The file includes `students/daily/events/settings` (with `classSchedules/batchSchedules/holidays/overrides`) plus `audit` and `images` table, but **not** student image files on disk (`/var/lib/atl/images` / `backend/uploads`) and **not** GT-511C3 fingerprint templates (flash). A DB backup alone is not complete biometric recovery. Restore accepts multipart `file` or raw body, requires `SQLite format 3\x00`, validates `PRAGMA integrity_check` and required tables `students/events/daily/settings`, acquires `SENSOR_LOCK` then `DB_LOCK`, saves `.pre_restore.bak` (rotation `.bak.1`), atomically `os.replace` with Windows retry, and does not blindly delete `-wal/-shm` (locks guarantee no app writer on old inode). Audit and attendance CSV exports are available from the same Backup tab; restores and reconciliations are recorded in `audit`.

**Google Drive Cloud Backup (automated offsite layer):**
- **Architecture:** Personal Google Drive using OAuth 2.0 Device Authorization Grant (RFC 8628, client type "TVs and Limited Input devices") with the least-privilege `https://www.googleapis.com/auth/drive.file` scope (only accesses files/folders created by this application; cannot read the user's other Drive contents). The operator authorizes by navigating to `google.com/device` from any browser on phone or PC and entering the one-time device code shown in Admin → Backup; no public domain, DNS, or redirect URI required. Uses standard chunked Resumable Upload protocol (1MB chunks) with exponential backoff for network resilience. Pure Python standard library implementation (`urllib.request` + `sqlite3.backup()` + `hashlib`).
- **Configuration:** Set in `backend/config.json` under `"gdrive"`: `{"enabled": true, "clientId": "...", "clientSecret": "...", "folderName": "ATL-Attendance-Backups", "scheduleTime": "18:30"}` or via environment variables (`ATL_GDRIVE_CLIENT_ID`, `ATL_GDRIVE_CLIENT_SECRET`). Token credentials are stored with `0600` permissions at `/var/lib/atl/gdrive_token.json` (or `backend/gdrive_token.json` on Windows) and never committed or deployed to git.
- **Snapshot creation:** Uses the SQLite Online Backup API (`sqlite3.backup()`) to copy the live WAL database to a local staging file under brief `DB_LOCK`. Before upload, validates SQLite header `SQLite format 3\x00`, `PRAGMA integrity_check == 'ok'`, required tables (`students`, `events`, `daily`, `settings`), non-empty record sanity, and computes SHA-256 checksum.
- **Automated schedule worker:** Background daemon (`_gdrive_backup_daemon`) runs every minute. Evaluates the persistent schedule configured in Admin → Backup (`gdriveSchedule` in SQLite settings): `enabled` (boolean), `time` (HH:MM IST), and `frequency` (`daily`, `interval` with `intervalDays` 1..30, or `weekdays` with active days Sun..Sat). Once local time reaches the configured target time and the frequency/weekday conditions match without a prior successful backup today, it takes an online snapshot and uploads to Google Drive.
- **Grandfather-Father-Son (GFS) retention:** After every successful backup, the engine prunes historical cloud backups, retaining the last 7 daily, last 4 weekly, and last 12 monthly snapshots.
- **Operator-initiated cloud restore:** Cloud backups NEVER restore automatically. In the Backup tab, operators can view available cloud snapshots and trigger a restore. The cloud snapshot is downloaded to `.incoming`, validated against SQLite header, `PRAGMA integrity_check`, and schema tables, backed up locally to `.pre_restore.bak`, and atomically replaces the live database while holding `SENSOR_LOCK` and `DB_LOCK`. All cloud backup and restore actions are logged to `audit`.


**Sensor audit (count-based only, not ID-level):** `GET /api/sensor/audit` holds `SENSOR_LOCK`, returns `{db_count, db_ids, sensor_count, sensor_ids:[], orphans_estimate, missing_estimate}` — `sensor_ids` stays `[]` (driver has no proven ID enumeration), `orphans_estimate = max(0, sensor-db)` (sensor>db, orphan templates), `missing_estimate = max(0, db-sensor)` (db>sensor, missing after replacement). `sim` or offline returns `sim:true`. Use `led_test.py` only for diagnostics.

**Sensor replacement recovery:** GT-511C3 templates live only in sensor flash (200 slots). Replacing the sensor yields `sensor_count=0`, `db_count=N`, `missing_estimate=N`, `orphans=0`. Historical `daily`/`events` survive (no `fingerId` cascade), but attendance requires re-enrollment. Procedure: `GET /api/sensor/audit` to confirm `missing_estimate`, then for each active student `POST /api/students/:id/reenroll` (re-enroll retries `IS_ALREADY_USED` up to 10, `SENSOR_LOCK` + `DB_LOCK`, old template deleted best-effort). Offline delete `DELETE /api/students/:id` when hardware offline returns `SENSOR_OFFLINE_DB_FREED` — correctly frees `active=0, roll#d{id}, fingerId=NULL` without claiming sensor cleanup.

**Gallery images:** `POST /api/images/upload` writes once to canonical `IMAGES_DIR` (no duplicate `assets/images/students` mirror), `GET /api/images` deduplicates `images` + legacy `imageGallery` by `id`, `DELETE` removes the file from `IMAGES_DIR` (and legacy mirror if present). SQLite backup contains `students.photo` but not gallery files — gallery requires separate `tar` of `IMAGES_DIR` for complete restore.

If the clock is invalid (`year <2020 or >2035` in `validate_clock()` in `app.py`) the API returns `INVALID_CLOCK`. If `/dev/serial0` is missing or permission-denied, check `enable_uart=1` and `lancer` membership in `dialout`. If the UI does not update after deploy, hard-refresh and verify the spliced `ui_app.js` marker `__ATL_BRIDGE__` is present.
