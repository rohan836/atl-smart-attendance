# ATL Smart Attendance Terminal

School fingerprint attendance: **GT-511C3** → **Raspberry Pi 3** → **Flask + SQLite**.

The front page is a biometric terminal. Admin is behind it.

## What it does
Finger on the sensor → identify → record attendance → show the student (photo, name, roll, class, section/batch, id, status, time) → fade back to `PLACE YOUR FINGER`.

Admin (6 tabs): Students, Today, Reports, Calendar, Settings, Backup.

**Truth:** the GT-511C3 template store + SQLite. The browser cache is not the database.

## Hardware
| | |
|---|---|
| Module | GT-511C3, 200 slots, UART `/dev/serial0` 9600 |
| Pi | Raspberry Pi 3 Model B, Debian 13 |
| Power | **3.3V pin 1 only — never 5V** |

| GT-511C3 | Pi |
|----------|-----|
| VCC | 3.3V pin 1 |
| GND | GND pin 6 |
| Sensor RX | GPIO14 / pin 8 (Pi TX) |
| Sensor TX | GPIO15 / pin 10 |

## Attendance rules
- First scan of the day: `PRESENT` if time ≤ `presentCutoff` (08:00), else `LATE`.
- Same student again that day: `DUPLICATE` (“Already recorded”).
- Not on the student’s schedule that day: `NOT_SCHEDULED` (muted, never Absent).
- `ABSENT` only after `lateCutoff` via `POST /api/reconcile`.
- Schedule: override → holiday/vacation/exam → weekly. `exam` counts as working. Per-class/batch weekly: `Grade|Batch` → batch → class → global.

## Repository
```
ATL-Smart-Attendance-Production.html   UI shell (CSS + markup)
backend/ui_app.js                      UI logic (spliced at serve)
backend/app.py                         Flask API + HTML serve
backend/gt511c3.py                     GT-511C3 driver
backend/schema.sql                     SQLite schema
backend/config.example.json            Config template (live config is gitignored)
pi/setup.sh  pi/atl-attendance.service  Pi install
tools/deploy.ps1  tools/deploy.sh       Deploy (never db/config)
```

## Run
```bash
python backend/app.py          # http://127.0.0.1:5000/
python -m unittest backend.test_app -v
```

Pi: `http://192.168.1.8:5000/` · `sudo systemctl status atl-attendance`

Deploy: `powershell -File tools/deploy.ps1` — never copies `attendance.db` or `config.json`.

## Docs
`API.md` · `ARCHITECTURE.md` · `PI_SETUP.md` · `AGENTS.md`
