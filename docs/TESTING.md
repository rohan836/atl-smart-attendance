# TESTING — Unit, integration, hardware, production

## Unit and API tests

Run from the repository root:

```bash
python -m unittest backend.test_app -v
```

`backend/test_app.py:20` creates a temporary directory, points `app.DB_PATH` to a temp SQLite file and `IMAGES_DIR` to a temp folder, forces `cfg.sensor=sim` and `uart=/dev/null`, and builds a fresh schema via `get_db()`. The Flask test client exercises `/api/*` without hardware. Tests reset `workingDays`, `classSchedules`, `batchSchedules`, `holidays`, and `overrides` to known states before each case.

Coverage includes health (`/api/health` returns `db_ok true` and `sensor sim`), the production page containing `__ATL_BRIDGE__`, `renderWeekly()` and `sensorScanLoop()` spliced from `ui_app.js`, settings whitelist rejection of `sensor`/`uart`, student create/list with `name/roll/grade` validation, scan `PRESENT` then `DUPLICATE` for the same student, `GET /api/scan/last` sequence monotonicity, no-event behavior for `NO_FINGER`, fingerprint-to-student mapping on real sensor fakes, audit and reconcile payloads, calendar priority with holiday ranges and overrides, `classSchedules` and `batchSchedules` `NOT_SCHEDULED` handling, KPIs and reports over scheduled days only, `POST /api/correction` with audit `ATTENDANCE_CORRECTED`, CSV import/export with `batch/section/parent`, index existence, roll case uniqueness and re-activation (`roll#d{id}` restore), and `GT511C3.is_press_finger` NACK handling. The suite is the contract — failures indicate a behavioral regression, not a test flaw.

## Integration testing

Two scan paths are exercised: the active loop `POST /api/scan {waitSec:2}` and the bridge `GET /api/scan/last`. Tests fake the sensor (`FakeSensor.identify → NO_FINGER` creates no event, `→ 42 OK` writes an event with a real `seq`). Verify that `SENSOR_LOCK` serializes enroll versus scan and that enrollment progress via `GET /api/sensor/progress` reports `state title detail timeout_sec remain_sec`.

## Hardware testing

Hardware tests are manual and isolated from unit tests. `tools/led_test.py` checks CMOS LED control. Wiring follows `PI_SETUP` / `OPERATIONS.md`: VCC 3.3V pin 1 only, GND pin 6, RX GPIO14/pin 8, TX GPIO15/pin 10, `baud 9600`, `enable_uart=1`. When `cfg.sensor=real` without a sensor, health reports `sensor offline` and scans return `SENSOR_DISCONNECT` 503 — this is expected. Keep `keep_led_on=True` so the LED stays on while the service runs (`app.py:62`).

## Production verification

After deploy, verify from the Pi:

```bash
curl -s http://127.0.0.1:5000/ | grep -o "ATL Smart Attendance Terminal"
curl -s http://127.0.0.1:5000/ | grep -c "FCFBF7"        # theme
curl -s http://127.0.0.1:5000/ | grep -c "pane-backup"   # admin tab
curl -s http://127.0.0.1:5000/api/health                # db_ok true, sensor offline expected on sim-less bench
```

Check that `Cache-Control: no-store` is present on `/` and `/api/*`, that `GET /backend/config.json` is 404, and that no `__SSR_DATA__` appears. Scan a known finger with `POST /api/scan {waitSec:2}` and confirm an event and a `seq` appear in `GET /api/scan/last` and in `GET /api/attendance?date=today`.
