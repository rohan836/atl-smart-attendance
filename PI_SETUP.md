# Pi Setup — lancer@192.168.1.8

**Target:** `lancer@192.168.1.8` · Raspberry Pi 3 Model B Rev 1.2 · Debian 13 trixie · wlan0 `192.168.1.8`
**UI:** `http://192.168.1.8:5000/` serves the HTML shell with `backend/ui_app.js` spliced in (`Cache-Control: no-store`).
**User:** `lancer` (uid 1001) — use `lancer`, `pi` fails. Key `C:\Users\LaNcer\.ssh\id_ed25519` · hostkey `SHA256:jmqvz4JHHhyxlTlHeTw8Y20fzyZ7RUAJhbhDg1HpYm0`. `sudo` may be restricted; deploy works without, restart via `pkill -f "python.*app.py"` (`Restart=always`).

**Stack:** Python 3.13 venv · Flask 3.x · Flask-Cors · pyserial · `backend/config.json` (`sensor real`, `uart /dev/serial0`, `baud 9600`, `host 0.0.0.0:5000`, `db /var/lib/atl/attendance.db`, template `backend/config.example.json`). Never scp `attendance.db` or `config.json` over Pi copies.

## Wiring GT-511C3 → Pi (UART) — 3.3V only
```
GT-511C3         Pi GPIO
VCC        ->    3.3V   (pin 1)   <- NEVER 5V
GND        ->    GND    (pin 6)
Sensor RX  ->    GPIO14 / TXD0 (pin 8)   Pi transmits
Sensor TX  ->    GPIO15 / RXD0 (pin 10)  Sensor transmits  /dev/serial0
```
Baud `9600` (`backend/config.json:baud`). Diagram `assets/images/diagrams/architecture.svg`.

## OS provisioning (one-time)
```bash
sudo bash pi/setup.sh
# apt python3/venv/sqlite3, enable_uart=1 in /boot/firmware/config.txt,
# serial console off, lancer into dialout+gpio, /opt/atl-attendance + /var/lib/atl,
# venv + pip Flask Flask-Cors pyserial, systemd service install
sudo reboot   # required for UART
curl http://127.0.0.1:5000/api/health
```

## Service
`pi/atl-attendance.service`: `User=lancer` · `WorkingDirectory=/opt/atl-attendance` · `ExecStart=/opt/atl-attendance/venv/bin/python /opt/atl-attendance/backend/app.py` · `Restart=always`.

Enable: `sudo systemctl enable --now atl-attendance` · logs: `journalctl -u atl-attendance -f`.
Without sudo: `pkill -f "python.*app.py"` (auto-restart ~5s), then `curl -s http://127.0.0.1:5000/api/health`.

Paths on Pi: DB `/var/lib/atl/attendance.db` · images `/var/lib/atl/images/` · config `/opt/atl-attendance/backend/config.json` · UI `/opt/atl-attendance/ATL-Smart-Attendance-Production.html` · venv `/opt/atl-attendance/venv/`.

## Deploy — canonical
```powershell
powershell -File tools/deploy.ps1
# scp ATL-Smart-Attendance-Production.html + backend/app.py|gt511c3.py|schema.sql|ui_app.js
#      + assets/ + pi/atl-attendance.service → lancer@192.168.1.8:/opt/atl-attendance/
# then service restart + health + HTML title check. Never attendance.db / config.json.
# Or: bash tools/deploy.sh  (rsync excludes .git/__pycache__/*.db/uploads/venv/config.json)
```

## Verify
```bash
curl -s http://192.168.1.8:5000/ | grep -o "ATL Smart Attendance Terminal — Complete School System"
curl -s http://192.168.1.8:5000/ | grep -c "FCFBF7"        # light editorial theme
curl -s http://192.168.1.8:5000/ | grep -c "pane-backup"   # admin Backup tab
curl http://192.168.1.8:5000/api/health                     # db_ok true; sensor offline until GT-511C3 connected (sensor:real)
```

## SSH (from Windows)
```powershell
ssh -i C:\Users\LaNcer\.ssh\id_ed25519 lancer@192.168.1.8 "whoami; hostname"
ssh -i C:\Users\LaNcer\.ssh\id_ed25519 lancer@192.168.1.8 "curl -s http://127.0.0.1:5000/api/health"
```

Flask listens on port 5000. No reverse proxy is required.

## Troubleshooting
- `serial0` not found → `ls /dev/serial*`; check `enable_uart=1` in `/boot/firmware/config.txt`, then `sudo reboot`.
- Permission denied on `/dev/serial0` → `sudo usermod -aG dialout lancer` + re-login.
- DB empty → check `/var/lib/atl/attendance.db` exists and `schema.sql` ran (`journalctl -u atl-attendance -f`).
- UI not updating after deploy → `Ctrl+F5`; confirm `curl -s http://127.0.0.1:5000/ | grep -o "ATL Smart Attendance Terminal"`.
- Health `sensor: offline` → expected while `sensor:real` and GT-511C3 not connected/answering; check wiring + `journalctl`.

*Aligned 2026-08-31 with the production HTML shell + `backend/app.py` + `backend/ui_app.js`.*
