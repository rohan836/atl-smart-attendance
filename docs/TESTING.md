# TESTING — Unit, integration, hardware, production

## Unit and API tests

Run from the repository root:

```bash
python -m unittest backend.test_app -v
```

`backend/test_app.py` creates a temporary directory, points `app.DB_PATH` to a temp SQLite file and `IMAGES_DIR` to a temp folder, forces `cfg.sensor=sim` and `uart=/dev/null`, and builds a fresh schema via `get_db()`. The Flask test client exercises `/api/*` without hardware. Tests reset `workingDays`, `classSchedules`, `batchSchedules`, `holidays`, and `overrides` to known states before each case.

Coverage (99 tests) includes health (`db_ok` and `sensor` mode), production page `__ATL_BRIDGE__`/`renderWeekly`/`sensorScanLoop` splice, settings whitelist, student create/list and `photo` handling, scan `PRESENT` then `DUPLICATE`, `GET /api/scan/last` whitelist `source='GT511C3'` and `CORRECTION`/`RECONCILE` exclusion, no-event `NO_FINGER`, fingerprint-to-student mapping on fakes, audit and reconcile (including before-cutoff rejection, after-cutoff absence marking, unscheduled safety, durable SQLite state and daemon tick resolution, dynamic lateCutoff shifting, and exception resilience), Google Drive cloud backup (unconfigured rejection, Device Authorization Grant user-code and verification URL generation, polling status tracking, pending authorization, successful grant with token persistence and 0600 permissions, denial and cancellation handling, SQLite Online Backup snapshot creation and PRAGMA integrity_check validation, corrupt header rejection, resumable chunked upload protocol, network retry resilience, Grandfather-Father-Son retention pruning, endpoint PIN gating, atomic cloud restore flow with pre-restore backup, background daemon startup/shutdown, and versatile schedule configuration/sanitization/tick evaluation), calendar priority with holiday ranges and `toLocalISO` local-date fix, `classSchedules`/`batchSchedules` `NOT_SCHEDULED`, KPIs and windowed reports `?start&end` with `eligible` scheduled-only, `POST /api/correction` with `DB_LOCK` atomicity, `sensor_audit` `missing_estimate`/`orphans_estimate` and `reenroll` retry, CSV import/export with `batch/section/parent` and `photo` column, image single-write/dedup/delete, indexes, roll case `roll#d{id}`, `is_press_finger` NACK, `DB_LOCK`/`SENSOR_LOCK` ordering, backup/restore PIN `X-Admin-Pin` header-only and `health` `adminPin` strip, `export`/`audit` PIN gates, and `admin` bridge `adminLayer` guard. The suite is the contract — failures indicate a behavioral regression, not a test flaw.

## Browser integration tests (Playwright)

End-to-end browser tests run Playwright with headless Chromium against a live, isolated test instance of `backend/app.py` (simulated sensor mode, temporary SQLite DB, mock Google Drive token).

Prerequisites:
```bash
pip install playwright
python -m playwright install chromium
```

Run from repository root:
```bash
python -m unittest backend.test_ui_e2e -v
```

Coverage (9 scenarios) includes:
1. Kiosk idle presentation: `#terminal`, `PLACE YOUR FINGER` prompt reveal, and Admin trigger button.
2. Real-time scan display lifecycle: Simulated scan event triggers student profile card display (`#identityLayer.visible`, student name, roll, class, status), followed by automatic fade-out back to idle prompt after hold timeout.
3. Admin security gate: PIN challenge modal on click, rejection and lock on invalid PIN (`0000`), and unlock on valid PIN (`1234`).
4. Tab navigation across all 6 Admin panes (Students, Today, Reports, Calendar, Settings, Backup) verifying active panes and titles.
5. Student enrollment modal workflow: form open, empty submit validation error (`#nsErr`), field population, and safe cancellation.
6. Google Drive Device Authorization Flow pairing UI: unauthenticated state renders `#gdriveDeviceStartBtn`, clicking initiates pairing and displays user code (`#gdriveUserCodeDisplay`), and cancellation resets the UI.
7. Google Drive automatic backup schedule controls: authenticated state renders frequency selector (`daily`, `interval`, `weekdays`), weekday toggle buttons, interval input, time selector, and schedule save confirmation (`#gdriveSchedStatus`).
8. Telegram secondary backup card and interactive controls: renders `#telegramCard` with status badge, allows interactive enable/disable toggle, tests "Send backup now" with mock network interception, and tests "Clear status" action.
9. Telegram automatic backup schedule controls: renders `#telegramSchedBody` with time selector, frequency selector (`daily`, `interval`, `weekdays`), interval input, weekday buttons, and schedule save confirmation (`#telegramSchedStatus`).

## Integration testing

Two scan paths are exercised: the active loop `POST /api/scan {waitSec:2}` and the bridge `GET /api/scan/last`. Tests fake the sensor (`FakeSensor.identify → NO_FINGER` creates no event, `→ 42 OK` writes an event with a real `seq`). Verify that `SENSOR_LOCK` serializes enroll versus scan and that enrollment progress via `GET /api/sensor/progress` reports `state title detail timeout_sec remain_sec`.

## Hardware testing

Hardware tests are manual and isolated from unit tests. `tools/led_test.py` checks CMOS LED control. Wiring follows `PI_SETUP` / `OPERATIONS.md`: VCC 3.3V pin 1 only, GND pin 6, RX GPIO14/pin 8, TX GPIO15/pin 10, `baud 9600`, `enable_uart=1`. When `cfg.sensor=real` without a sensor, health reports `sensor offline` and scans return `SENSOR_DISCONNECT` 503 — this is expected. Keep `keep_led_on=True` so the LED stays on while the service runs.

## Production verification

After deploy, verify from the Pi:

```bash
curl -s http://127.0.0.1:5000/ | grep -o "ATL Smart Attendance Terminal"
curl -s http://127.0.0.1:5000/ | grep -c "FCFBF7"        # theme
curl -s http://127.0.0.1:5000/ | grep -c "pane-backup"   # admin tab
curl -s http://127.0.0.1:5000/api/health                # db_ok true, sensor offline expected on sim-less bench
```

Check that `Cache-Control: no-store` is present on `/` and `/api/*`, that `GET /backend/config.json` is 404, and that no `__SSR_DATA__` appears. Scan a known finger with `POST /api/scan {waitSec:2}` and confirm an event and a `seq` appear in `GET /api/scan/last` and in `GET /api/attendance?date=today`.
