# ATL Smart Attendance Terminal

Fingerprint attendance: **GT-511C3** → **Raspberry Pi 3** → **Flask + SQLite**. Front page is a biometric terminal; Admin is behind it.

Finger on sensor → identify → record `PRESENT/LATE/DUPLICATE/NOT_SCHEDULED` → show frameless photo + fields → fade to `PLACE YOUR FINGER`. Works offline; SQLite + sensor are truth.

## Hardware

GT-511C3 200 slots, UART `/dev/serial0` 9600, **VCC 3.3V pin 1 only — never 5V**. Pi 3 Model B, Debian 13, `lancer@192.168.1.8`.

Wiring: VCC→3.3V pin1, GND→pin6, RX→GPIO14/pin8, TX→GPIO15/pin10.

## Run

```bash
python backend/app.py          # http://127.0.0.1:5000/
python -m unittest backend.test_app -v       # 116 backend unit tests
python -m unittest backend.test_ui_e2e -v    # 12 Playwright E2E browser tests
```

Pi: `http://192.168.1.8:5000/` · `sudo systemctl status atl-attendance` · `journalctl -u atl-attendance -f`

Deploy: `powershell -File tools/deploy.ps1` — never copies `attendance.db` or `config.json`.

## UI architecture

`ATL-Smart-Attendance-Production.html` = shell/markup/CSS · `backend/ui_app.js` = behavior · `backend/app.py` = serves HTML with JS injected · `backend/gt511c3.py` = driver · `backend/gdrive_backup.py` = cloud backup. Redesign: HTML/CSS in the HTML file, behavior in `ui_app.js`; current production release `v1.2.0` (`bf575451`); rollback via Git tags `v1.1.0`, `v1.0.1` and `v1.0.0` (see `docs/VERSIONS.md`).

## Docs

- Agent rules: `AGENTS.md`
- Product: `docs/PROJECT.md` · Workflow: `docs/WORKFLOW.md` · Admin: `docs/ADMIN.md`
- Architecture: `docs/ARCHITECTURE.md` · Data: `docs/DATA_MODEL.md`
- Development: `docs/DEVELOPMENT.md` · Testing: `docs/TESTING.md` · Operations: `docs/OPERATIONS.md`
- API contract: `API.md`
