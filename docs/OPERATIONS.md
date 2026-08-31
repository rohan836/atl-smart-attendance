# OPERATIONS — Pi, deploy, backup, recovery

## Target machine

Pi 3 Model B Rev 1.2, Debian 13 (trixie), user `lancer` (not `pi`), host `192.168.1.8` via wlan0. SSH key is `C:\Users\LaNcer\.ssh\id_ed25519`, host key `SHA256:jmqvz4JHHhyxlTlHeTw8Y20fzyZ7RUAJhbhDg1HpYm0`. On-Pi paths are DB `/var/lib/atl/attendance.db`, images `/var/lib/atl/images`, config `/opt/atl-attendance/backend/config.json`, app `/opt/atl-attendance`, venv `/opt/atl-attendance/venv`. On Windows the fallbacks are `backend/attendance.db` and `backend/uploads` (`app.py:12`). The live config template is `backend/config.example.json`; the live file `backend/config.json` is gitignored and contains `sensor real`, `uart /dev/serial0`, `baud 9600`, `db /var/lib/atl/attendance.db`, `host 0.0.0.0:5000`.

## Wiring

GT-511C3 to Pi only at 3.3V. VCC to 3.3V pin 1 — never 5V — GND to pin 6, sensor RX to GPIO14 / pin 8 (Pi TX), sensor TX to GPIO15 / pin 10. Baud is 9600. The driver in `gt511c3.py` expects `/dev/serial0` with `enable_uart=1` and `serial console off`. The service keeps the CMOS LED on (`keep_led_on=True` in `app.py:62`); `tools/led_test.py` is diagnostics only.

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

## Deployment

Canonical deploys copy only code and assets:

```powershell
powershell -File tools/deploy.ps1
# or
bash tools/deploy.sh
```

They copy `ATL-Smart-Attendance-Production.html`, `backend/app.py`, `gt511c3.py`, `schema.sql`, `ui_app.js`, `assets/`, and `pi/atl-attendance.service` to `lancer@192.168.1.8:/opt/atl-attendance/`, then restart the service and check `curl http://127.0.0.1:5000/` title and `curl /api/health`. They never copy `attendance.db`, `config.json`, or `*.backup.html` (`ATL-Smart-Attendance-Production.backup.html` stays local as a snapshot, never used at runtime or deployed), and they exclude `.git/__pycache__/*.db/uploads/venv`. `deploy.sh` does not use `rsync --delete` because that would remove the Pi venv.

## Backup, restore, recovery

Backup (`app.py:1113`) runs `PRAGMA wal_checkpoint(TRUNCATE)` and sends the SQLite file as `atl_backup_YYYY-MM-DD.db` via `GET /api/backup`. The file includes `students/daily/events/settings` (with `classSchedules/batchSchedules/holidays/overrides`) plus `audit`. Restore (`app.py:1130`) accepts multipart `file` or raw body, requires at least 100 bytes starting with `SQLite format 3\x00`, saves the current DB as `.pre_restore.bak`, overwrites `DB_PATH`, and verifies `SELECT 1 FROM students`. Audit and attendance CSV exports are available from the same Backup tab; restores and reconciliations are recorded in `audit`.

If the clock is invalid (`year <2020 or >2035` in `validate_clock() app.py:211`) the API returns `INVALID_CLOCK`. If `/dev/serial0` is missing or permission-denied, check `enable_uart=1` and `lancer` membership in `dialout`. If the UI does not update after deploy, hard-refresh and verify the spliced `ui_app.js` marker `__ATL_BRIDGE__` is present.
