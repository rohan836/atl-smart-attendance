# ARCHITECTURE — Components and relationships

## System overview

The system is a kiosk: sensor → driver → server → database → UI shell. The GT-511C3 communicates over UART `/dev/serial0` at 9600 baud. `backend/gt511c3.py` implements the packet protocol (Open, Close, CMOS LED, IsPressFinger, Capture, EnrollStart/1/2/3, Identify, DeleteID). `backend/app.py` is Flask 3.x on `0.0.0.0:5000` exposing `/api/*` and serving the single-page UI. `SQLite` at `/var/lib/atl/attendance.db` on the Pi (fallback `backend/attendance.db` on Windows) is the source of truth alongside the sensor's 200-slot flash store. The UI shell `ATL-Smart-Attendance-Production.html` holds CSS and markup; its `<script>` block is a splice point only.

```
[GT-511C3 UART] ↔ [gt511c3.py] ↔ [app.py Flask :5000] ↔ [SQLite]
                                         ↕
                        [HTML shell + spliced ui_app.js + scan bridge]
                                         ↕
                              [LocalStorage atl_* cache] ↔ [Admin UI]
```

## Serve-time composition

`_serve_production()` in `app.py:477` reads the HTML shell, replaces the inline `<script>` with the maintained source `backend/ui_app.js`, and injects `SCAN_BRIDGE_SCRIPT` (`app.py:426`) before `</body>` if `window.handleRealScan` is present. No static `css/js/templates` are served. The response is `Cache-Control: no-store` for `/` and for all `/api/*` and asset routes (`app.py:26`). Unknown non-`/api`, non-`/assets` paths serve the same UI. `/backend/*` is not exposed.

## Active scan and bridge

Scanning is DB-driven. `sensorScanLoop()` (`ui_app.js:481`) posts `POST /api/scan {waitSec:2}` when Admin and the enroll modal are closed; the backend under `SENSOR_LOCK` (`app.py:62`) runs `GT511C3.identify()` with a bounded wait, capture retries, and identify. Terminal errors `NO_FINGER`, `SENSOR_BUSY`, `SENSOR_DISCONNECT`/UART create no event. The injected bridge polls `GET /api/scan/last` every 2 seconds, maps integer `fingerId` to string `fid "F-<n>"`, upserts the student via `mapStudent()` (`ui_app.js:110`), and calls `window.handleRealScan(fid, {status,time,date,seq,student})`. Unknown scans resolve as `__unknown__<seq>`. Enroll and re-enroll success call `returnToFrontPage()` (`ui_app.js:474`) which closes the modal and Admin and re-arms the loop.

## UI and state

The theme is light editorial: `bg #FCFBF7 panel #FFFFFF ink #0A0A0A ink-2 #6B6B6B ink-3 #A8A5A0 line #E9E6E0 paper #F6F4EF ok #2F5D34 danger #8A3A3A`, fonts Inter / Newsreader / ui-monospace. The maintained logic is `ui_app.js`; editing the HTML splice stub is unsupported. Data load is `cacheLoad() → loadClassesHolidaysSettings() → loadStudents() → loadHistory() → loadTodayAttendance() → cacheSave()` and repeats every 15 seconds while visible. LocalStorage is photos-stripped; all writes go through the API.

## File map

`ATL-Smart-Attendance-Production.html` UI shell. `backend/app.py` API and serve logic. `backend/gt511c3.py` sensor driver. `backend/schema.sql` schema and indexes. `backend/ui_app.js` UI application. `backend/config.example.json` template. `pi/setup.sh` and `pi/atl-attendance.service` provisioning. `tools/deploy.ps1`/`deploy.sh` and `tools/led_test.py`. See `API.md` for endpoint contracts and `DATA_MODEL.md` for tables and scheduling. See `OPERATIONS.md` for hardware, service, and deployment.
