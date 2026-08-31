# Pi

Full instructions: `PI_SETUP.md` in the repo root.

- Host: `lancer@192.168.1.8`
- UI: `http://192.168.1.8:5000/`
- DB: `/var/lib/atl/attendance.db`
- Config: `/opt/atl-attendance/backend/config.json` (never overwrite from git)
- Service: `pi/atl-attendance.service`
- First-time: `sudo bash pi/setup.sh` then reboot for UART
