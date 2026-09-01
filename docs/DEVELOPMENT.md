# DEVELOPMENT — How to change the project safely

## Source of truth

Behavior lives in `backend/app.py` (Flask + scheduling + validation; serves HTML with `ui_app.js` injected), `backend/gt511c3.py` (fingerprint UART driver), `backend/schema.sql` (tables), and `backend/ui_app.js` (UI behavior/state/events/API). `ATL-Smart-Attendance-Production.html` is the UI shell — markup and CSS/layout; its `<script>` block is replaced at serve time by `_serve_production()` in `app.py` and is not edited directly. No working-tree backup HTML is kept — use Git history and tag `v1.0.0` for rollback. When redesigning: HTML/CSS → `ATL-Smart-Attendance-Production.html`, behavior → `backend/ui_app.js`. The GT-511C3 template store plus SQLite are truth; LocalStorage `atl_*` is a photos-omitted cache. Do not create separate `css/`/`js/`/`templates/` or component folders unless proven need; keep simple architecture.

## What not to touch

Never commit or deploy `backend/config.json`, any `*.db`, `*.pre_restore.bak`, `backend/uploads/`, `__pycache__/`, `*.log`, `.venv/` or `.env` — they are gitignored or excluded from deploy and contain machine-specific or derived data. No backup HTML is kept in the working tree — Git history and tag `v1.0.0` are the restore point; do not create `*.backup.html` copies. Never deploy the development database to the Pi. Keep dead routes `/legacy|/terminal|/perfect|/css|/js` removed. Never store `sensor/uart/baud/db/host/port/imagesDir` through `POST /api/settings` — they are file-only and excluded by the whitelist in `app.py`. Never power the sensor from 5V; VCC is 3.3V pin 1 only. Keep `keep_led_on=True` in `app.py` — the LED stays on while the service runs.

## Making changes

One task at a time. Before coding, read the doc that owns the area: workflow changes need `WORKFLOW.md` and `ARCHITECTURE.md`; schedule or status changes need `DATA_MODEL.md`; Admin layout needs `ADMIN.md`. Keep each concern in its file — do not duplicate schedule logic in Admin and data-model docs. Preserve validation limits exactly (`name 1-80`, `roll 1-20 unique lower()`, `grade 1-40`, `batch 40`, `section 20`, `parent 80`, `phone 40 digits≥8`, `address 200`, `photo` capped by `PHOTO_MAX 2_800_000`) and the holiday string format `YYYY-MM-DD[..YYYY-MM-DD]:type:name` parsed in `app.py`.

Scan and enroll are concurrency-sensitive. Guard any sensor access with `SENSOR_LOCK` and never create `events` for `NO_FINGER`, `SENSOR_BUSY`, or UART errors (`app.py`). Enrollment is one Start plus three lifts with 40s/30s waits; `SENSOR_PROGRESS` must be updated and exposed via `GET /api/sensor/progress`. Keep `is_student_scheduled()` precedence as `override → holiday → weekly` and weekly resolution `Grade|Batch → batch → class → global` in `app.py`.

## Adding a feature

Add UI in `ui_app.js` mapping through `mapStudent()`/`mapEvent()` and rendering via `renderAll()`. Add persistence in `app.py` with an additive migration in `_migrate_db()` or `get_settings()` so `DB_PATH` preserves history. Expose any new state through `/api/settings` only if it is in the whitelist; otherwise keep it file-backed. Keep `Cache-Control: no-store` for HTML and API.

## Verification

Run `python -m unittest backend.test_app -v` from the repo root — it uses a temp SQLite file and a simulated sensor, so it never touches hardware. Check that `curl http://127.0.0.1:5000/` still contains the title `ATL Smart Attendance Terminal — Complete School System` and that `curl /api/health` returns `db_ok true`. Confirm `/backend/config.json` is not served and no `__SSR_DATA__` appears in the HTML.
