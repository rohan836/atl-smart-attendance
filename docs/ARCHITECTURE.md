# ARCHITECTURE — Components and relationships

## System overview

The system is a kiosk: sensor → driver → server → database → UI shell. The GT-511C3 communicates over UART `/dev/serial0` at 9600 baud. `backend/gt511c3.py` is the fingerprint hardware driver (packet protocol: Open, Close, CMOS LED, IsPressFinger, Capture, EnrollStart/1/2/3, Identify, DeleteID). `backend/app.py` is Flask 3.x on `0.0.0.0:5000` exposing `/api/*` and serving the single-page UI. `SQLite` at `/var/lib/atl/attendance.db` on the Pi (fallback `backend/attendance.db` on Windows) is the source of truth alongside the sensor's 200-slot flash store.

UI layering:
- `ATL-Smart-Attendance-Production.html` = shell/markup/CSS — edit for visual redesign
- `backend/ui_app.js` = behavior/state/events/API — edit for behavior
- `backend/app.py` = Flask API (serves HTML with `ui_app.js` injected) + background reconciliation worker (`_reconcile_daemon`) + backup scheduler daemon (`_gdrive_backup_daemon` for Google Drive, Telegram, and USB)
- `backend/gdrive_backup.py` = Google Drive cloud backup engine (Device Flow RFC 8628, SQLite Online Backup snapshot, resumable upload, GFS retention)
- `backend/gt511c3.py` = driver (UART only)
No working-tree backup HTML is kept — current production release is `v1.2.0` (`bf575451`); Git tags `v1.1.0`, `v1.0.1` and `v1.0.0` remain historical rollback points.

```
[GT-511C3 UART] ↔ [gt511c3.py] ↔ [app.py Flask :5000 + ReconcileDaemon + BackupDaemon] ↔ [SQLite]
                                                          ↕                                    ↕
                               [gdrive_backup.py (Drive) + Telegram Bot + USB Storage]   [.pre_restore.bak]
                                                          ↕
                                   [HTML shell + spliced ui_app.js + scan bridge]
                                                          ↕
                                         [LocalStorage atl_* cache] ↔ [Admin UI]
```

## Serve-time composition

`_serve_production()` in `app.py` reads the HTML shell, replaces the inline `<script>` with the maintained source `backend/ui_app.js`, and injects `SCAN_BRIDGE_SCRIPT` before `</body>` if `window.handleRealScan` is present. No static `css/js/templates` are served. The response is `Cache-Control: no-store` for `/` and for all `/api/*` and asset routes. Unknown non-`/api`, non-`/assets` paths serve the same UI. `/backend/*` is not exposed.

## Active scan and bridge

Scanning is DB-driven. `sensorScanLoop()` posts `POST /api/scan {waitSec:2}` on the kiosk and in the background while Admin is open (suppressing full-screen identity popup); pauses exclusively during enrollment (`enrollModal`/`scanModal`) and sensor maintenance. The backend under `SENSOR_LOCK` runs `GT511C3.identify()` with a bounded wait, capture retries, and identify. Terminal errors `NO_FINGER`, `SENSOR_BUSY`, `SENSOR_DISCONNECT`/UART create no event. The injected bridge polls `GET /api/scan/last` every 2 seconds, maps integer `fingerId` to string `fid "F-<n>"`, upserts the student via `mapStudent()`, and calls `window.handleRealScan(fid, {status,time,date,seq,student})`. Unknown scans resolve as `__unknown__<seq>`. Enroll and re-enroll success call `returnToFrontPage()` which closes the modal and Admin and re-arms the loop.

## UI and state

Theme is light editorial: `bg #FCFBF7 panel #FFFFFF ink #0A0A0A ink-2 #6B6B6B ink-3 #A8A5A0 line #E9E6E0 paper #F6F4EF ok #2F5D34 danger #8A3A3A`, Inter/Newsreader/monospace. The maintained logic is `ui_app.js`; the HTML stub is replaced at serve time and not edited. Redesign: HTML/CSS in the Production.html, behavior in `ui_app.js`; do not create `css/`/`js/`/`templates/`/components unless proven need. Data load is `cacheLoad() → loadClassesHolidaysSettings() → loadStudents() → loadHistory() → loadTodayAttendance() → cacheSave()` every 15s while visible. LocalStorage omits photos; all writes via API.

## File map

`ATL-Smart-Attendance-Production.html` UI shell, markup, CSS/layout (visual redesign here; includes Unified Backup Manager). `backend/ui_app.js` UI behavior/state/events/API. `backend/app.py` Flask API and serve logic (injects `ui_app.js` into HTML) + reconciliation and multi-destination backup workers. `backend/gdrive_backup.py` Google Drive cloud backup engine (OAuth Device Authorization Grant, SQLite Online Backup snapshot, resumable upload, GFS retention). `backend/gt511c3.py` fingerprint driver. `backend/schema.sql` schema and indexes. `backend/config.example.json` template. `pi/setup.sh` and `pi/atl-attendance.service` provisioning. `tools/deploy.ps1`/`deploy.sh` and `tools/led_test.py`. No working-tree backup HTML — current production release is `v1.2.0` (`bf575451`); tags `v1.1.0`, `v1.0.1` and `v1.0.0` remain historical rollback points. See `API.md` for endpoint contracts and `DATA_MODEL.md` for tables and scheduling. See `OPERATIONS.md` for hardware, service, and deployment.
