# Pi Setup

For `raspberrypi123` `192.168.1.8` `lancer` Raspberry Pi 3 Model B · `Debian 13`.

Production UI: `http://192.168.1.8:5000/` (`ATL-Smart-Attendance-Production.html`, light editorial single-file). No legacy routes.

Wiring GT-511C3:
```
GT-511C3  -> Pi (GPIO)
VCC (red) -> 3.3V (pin 1)
GND (blk) -> GND (pin 6)
TX  (yel) -> RX (GPIO15, pin 10)
RX  (blu) -> TX (GPIO14, pin 8)
```
UART: `/dev/serial0` 9600 baud (config `9600` in `backend/config.json`).

Run:
```bash
sudo bash pi/setup.sh
# or from USB: sudo bash /media/*/pi/setup.sh
sudo reboot
curl http://192.168.1.8:5000/api/health
```

Logs: `sudo journalctl -u atl-attendance -f`
DB: `/var/lib/atl/attendance.db`
Images: `/var/lib/atl/images/` (synced from `assets/images/`)
