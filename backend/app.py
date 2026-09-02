#!/usr/bin/env python3
"""ATL Smart Attendance — Flask backend (GT-511C3 UART + SQLite). Offline-first."""
import os, json, sqlite3, time, uuid, pathlib, datetime, re, threading, base64, secrets, urllib.request, urllib.error, shutil
# pyrefly: ignore [missing-import]
from flask import Flask, request, jsonify, send_from_directory, g, Response, has_app_context, redirect
from flask_cors import CORS

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = pathlib.Path(__file__).with_name("config.json")
SCHEMA_PATH = pathlib.Path(__file__).with_name("schema.sql")

cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
DB_PATH = os.path.expanduser(cfg.get("db") or str(ROOT / "backend" / "attendance.db"))
if os.name == "nt" and DB_PATH.startswith("/var"):
    DB_PATH = str(ROOT / "backend" / "attendance.db")
IMAGES_DIR = cfg.get("imagesDir") or str(ROOT / "assets" / "images" / "students")
if os.name == "nt" and IMAGES_DIR.startswith("/var"):
    IMAGES_DIR = str(ROOT / "backend" / "uploads")

PORT = int(cfg.get("port", 5000))
HOST = cfg.get("host", "0.0.0.0")

app = Flask(__name__, static_folder=None)
CORS(app, resources={r"/api/*": {"origins": []}})
# --- Auto cache-bust: never cache HTML/CSS/JS so deploys show instantly ---
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
@app.after_request
def _no_cache(resp):
    # HTML/CSS/JS and all API JSON must not be cached so deploys and Admin stay live
    p = request.path
    if p == "/" or p.endswith((".html", ".css", ".js")) or p.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp

PHOTO_MAX = 2_800_000  # ~2MB file as a data URL

def _clean_wd(wd, defaults=None):
    """Normalize a workingDays map to {'0'..'6': bool}. String 'false' stays False."""
    if not isinstance(wd, dict):
        raise ValueError("workingDays must be object")
    base = defaults if isinstance(defaults, dict) else {str(i): False for i in range(7)}
    clean = {}
    for i in range(7):
        v = wd.get(str(i))
        if v is None:
            v = wd.get(i)
        if v is None:
            v = base.get(str(i), base.get(i, False))
        if isinstance(v, str):
            clean[str(i)] = v.strip().lower() in ("1", "true", "yes", "on")
        else:
            clean[str(i)] = bool(v)
    return clean

def _photo_ok(photo):
    photo = str(photo or "")
    if not photo:
        return True, ""
    if len(photo) > PHOTO_MAX:
        return False, "photo too large (max 2MB)"
    allowed = ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/jpg;base64,", "data:image/webp;base64,")
    if not photo.startswith(allowed):
        return False, "photo must be data:image/*;base64,"
    try:
        b64 = photo.split(",", 1)[1] if "," in photo else ""
        if not b64:
            return False, "photo must be data:image/*;base64,"
        decoded = base64.b64decode(b64, validate=True)
        if len(decoded) > 2 * 1024 * 1024:
            return False, "photo too large (max 2MB)"
    except Exception:
        return False, "photo must be data:image/*;base64,"
    return True, photo

SENSOR_LOCK = threading.Lock()
DB_LOCK = threading.RLock()
_UART_PING = {"t": 0.0, "ok": True, "msg": "ready", "name": "ready"}

def _admin_pin():
    # opt-in: empty means open (zero regression for existing Pi)
    pin = cfg.get("adminPin")
    if pin is None:
        pin = os.environ.get("ATL_ADMIN_PIN", "")
    return str(pin or "").strip()

def require_admin(fn):
    from functools import wraps
    @wraps(fn)
    def _wrapped(*a, **kw):
        pin = _admin_pin()
        if not pin:
            return fn(*a, **kw)
        got = (request.headers.get("X-Admin-Pin") or "").strip()
        if got != pin:
            return jsonify({"error": "admin pin required"}), 401
        return fn(*a, **kw)
    return _wrapped
SENSOR_PROGRESS = {
    "mode": "idle", "step": 0, "steps_total": 3, "state": "idle",
    "title": "", "detail": "", "timeout_sec": 0, "deadline": 0,
    "remain_sec": 0, "finger": None, "raw": "", "text": "",
}

DEFAULT_WORKING_DAYS = {"0": False, "1": True, "2": True, "3": True,
                       "4": True, "5": True, "6": True}
_INDEXES_READY = False

def set_sensor_progress(ev=None, **kw):
    if isinstance(ev, str):
        kw.setdefault("title", ev)
        kw.setdefault("detail", ev)
        kw.setdefault("raw", ev)
        kw.setdefault("text", ev)
    elif isinstance(ev, dict):
        kw = {**ev, **kw}
    for k, v in kw.items():
        if k in SENSOR_PROGRESS or k in ("title", "detail", "state", "mode", "step", "steps_total", "timeout_sec", "deadline", "remain_sec", "finger", "raw", "text"):
            SENSOR_PROGRESS[k] = v
    if SENSOR_PROGRESS.get("title") and not SENSOR_PROGRESS.get("text"):
        SENSOR_PROGRESS["text"] = SENSOR_PROGRESS["title"]
    if "timeout_sec" in kw and not kw.get("timeout_sec"):
        SENSOR_PROGRESS["deadline"] = 0
    elif kw.get("timeout_sec") and not kw.get("deadline"):
        SENSOR_PROGRESS["deadline"] = time.time() + float(kw["timeout_sec"])

def sensor_progress_view():
    d = dict(SENSOR_PROGRESS)
    dl = float(d.get("deadline") or 0)
    if dl:
        d["remain_sec"] = max(0, int(dl - time.time()))
    else:
        d["remain_sec"] = 0
    return d

def set_enroll_progress(text, pct=None, raw=""):
    set_sensor_progress(title=text, detail=text, raw=raw or text, text=text, mode="enroll")

# --- DB ---
def _migrate_db(db):
    # Preserve historical data: add columns if missing (safe, additive only)
    try:
        cols = [r[1] for r in db.execute("PRAGMA table_info(students)").fetchall()]
        for col in ("address", "batch", "section", "parent"):
            if col not in cols:
                try:
                    db.execute(f"ALTER TABLE students ADD COLUMN {col} TEXT")
                except Exception as e:
                    app.logger.warning("DB migration: add column %s failed: %s", col, e)
        global _INDEXES_READY
        if not _INDEXES_READY:
            for sql in (
                "CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)",
                "CREATE INDEX IF NOT EXISTS idx_events_student ON events(studentId)",
                "CREATE INDEX IF NOT EXISTS idx_events_date_student ON events(date, studentId)",
                "CREATE INDEX IF NOT EXISTS idx_daily_date ON daily(date)",
                "CREATE INDEX IF NOT EXISTS idx_daily_student ON daily(studentId)",
                "CREATE INDEX IF NOT EXISTS idx_students_finger ON students(fingerId)",
                "CREATE INDEX IF NOT EXISTS idx_students_roll ON students(roll)",
            ):
                try:
                    db.execute(sql)
                except Exception as e:
                    app.logger.warning("DB migration: create index failed (%s): %s", sql, e)
            _INDEXES_READY = True
        db.commit()
    except Exception as e:
        app.logger.error("DB migration failed: %s", e, exc_info=True)
        raise

def get_db():
    if "db" not in g:
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        need_init = not os.path.exists(DB_PATH)
        try:
            g.db = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False, isolation_level=None)
        except sqlite3.Error as e:
            raise RuntimeError(f"DB open failed {DB_PATH}: {e}")
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL;")
        g.db.execute("PRAGMA synchronous=NORMAL;")
        g.db.execute("PRAGMA foreign_keys=ON;")
        if need_init:
            g.db.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            g.db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)", ("config", json.dumps(cfg)))
            g.db.commit()
        _migrate_db(g.db)
    return g.db

@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db:
        try: db.close()
        except: pass

def get_settings():
    if not has_app_context():
        with app.app_context():
            return get_settings()
    try:
        db = get_db()
        row = db.execute("SELECT value FROM settings WHERE key='config'").fetchone()
        if row:
            try:
                j = json.loads(row["value"])
            except Exception as e:
                app.logger.error("Failed to parse persisted settings JSON: %s", e, exc_info=True)
                try:
                    g.settings_load_error = str(e)
                except: pass
                return cfg
            # migrations - keep additive, preserve existing data
            if "trajectoryLabels" not in j: j["trajectoryLabels"] = cfg.get("trajectoryLabels", "Jun,Jul,Aug,Sep,Oct,Nov,Dec,Jan,Feb,Mar,Apr")
            if "classes" not in j: j["classes"] = cfg.get("classes", [])
            if "batches" not in j: j["batches"] = cfg.get("batches", [])
            if "classSchedules" not in j: j["classSchedules"] = cfg.get("classSchedules", {})
            if "batchSchedules" not in j: j["batchSchedules"] = cfg.get("batchSchedules", {})
            if "schoolLogo" not in j: j["schoolLogo"] = cfg.get("schoolLogo", "assets/images/admin/logo.svg")
            if "planetImage" not in j: j["planetImage"] = cfg.get("planetImage", "assets/images/admin/planet.svg")
            if "heroImage" not in j: j["heroImage"] = cfg.get("heroImage", "")
            if "imageGallery" not in j: j["imageGallery"] = []
            if "holidays" not in j: j["holidays"] = []
            if "halfDayCutoff" not in j: j["halfDayCutoff"] = "10:00"
            if "workingDays" not in j: j["workingDays"] = dict(DEFAULT_WORKING_DAYS)
            if "overrides" not in j: j["overrides"] = []
            # ensure classSchedules values are dicts
            if not isinstance(j.get("classSchedules"), dict): j["classSchedules"] = {}
            if not isinstance(j.get("batchSchedules"), dict): j["batchSchedules"] = {}
            if not isinstance(j.get("batches"), list): j["batches"] = []
            return j
        app.logger.warning("Settings row missing in DB, falling back to config.json defaults")
        return cfg
    except Exception as e:
        app.logger.error("Failed to load persisted settings from SQLite: %s", e, exc_info=True)
        try:
            g.settings_load_error = str(e)
        except: pass
        return cfg

def save_settings(new_cfg):
    with DB_LOCK:
        db = get_db()
        started = not db.in_transaction
        if started:
            db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)", ("config", json.dumps(new_cfg)))
            if started:
                db.commit()
        except:
            if started:
                try: db.rollback()
                except: pass
            raise

def public_settings():
    """Return UI-safe settings without deployment/hardware connection fields."""
    s = dict(get_settings())
    for k in ("sensor", "uart", "baud", "db", "host", "port", "imagesDir", "adminPin", "telegram", "telegramBotToken", "botToken"):
        s.pop(k, None)
    return s

# --- Clock & validation ---
def today_ist():
    tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    return datetime.datetime.now(tz).date().isoformat()

def now_ist():
    tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    return datetime.datetime.now(tz).strftime("%d/%m/%Y, %H:%M:%S")

def validate_clock():
    # Edge: invalid clock (system time absurd)
    try:
        iso = today_ist()
        d = datetime.date.fromisoformat(iso)
        if d.year < 2020 or d.year > 2035:
            return False, f"INVALID_CLOCK {iso}"
        return True, "OK"
    except Exception as e:
        return False, f"CLOCK_ERR {e}"

def _parse_holiday(value):
    """Shared holiday parser: returns (start, end, kind) where kind in holiday/vacation/exam."""
    if isinstance(value, dict):
        start = value.get("start") or value.get("date")
        end = value.get("end") or start
        kind = str(value.get("type") or "holiday").lower()
        return start, end, kind if kind in ("holiday", "vacation", "exam") else "holiday"
    raw = str(value or "").strip()
    if not raw:
        return None, None, "holiday"
    head = raw.split(":", 1)[0].strip()
    if ".." in head:
        start, end = [x.strip() for x in head.split("..", 1)]
    else:
        start = end = head
    rest = raw[len(head):].lstrip(":")
    parts = rest.split(":", 1)
    kind = parts[0].strip().lower() if len(parts) == 2 else "holiday"
    return start, end, kind if kind in ("holiday", "vacation", "exam") else "holiday"

def _holiday_contains(day, start, end):
    try:
        return datetime.date.fromisoformat(start) <= day <= datetime.date.fromisoformat(end)
    except (TypeError, ValueError):
        return False

def _override_result(date_iso, s):
    for override in (s.get("overrides") or []):
        if isinstance(override, dict):
            raw_date = override.get("date")
            value = override.get("isWorking", override.get("working", False))
        else:
            parts = str(override).split(":", 2)
            raw_date = parts[0].strip() if parts else ""
            value = len(parts) > 1 and parts[1].strip().lower() in ("1", "true", "yes", "on")
        if raw_date == str(date_iso):
            return bool(value)
    return None

def _holiday_result(day, s):
    for holiday in (s.get("holidays") or []):
        start, end, kind = _parse_holiday(holiday)
        if _holiday_contains(day, start, end):
            return kind == "exam"
    return None

def is_working_day(date_iso, s):
    """Apply override -> holiday/vacation -> weekly calendar precedence."""
    try:
        day = datetime.date.fromisoformat(str(date_iso))
    except (TypeError, ValueError):
        return False
    ov = _override_result(date_iso, s)
    if ov is not None:
        return ov
    hol = _holiday_result(day, s)
    if hol is not None:
        return hol
    weekly = s.get("workingDays") or DEFAULT_WORKING_DAYS
    weekday_key = (day.weekday() + 1) % 7
    value = weekly.get(str(weekday_key), weekly.get(weekday_key, False))
    if isinstance(value, str):
        value = value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)

def _get_working_days_for_student(student, s):
    """Return weekly workingDays dict for a student with precedence: batch composite → batch → class → global."""
    if student:
        grade = (student.get("grade") or student.get("class") or "").strip()
        batch = (student.get("batch") or student.get("group") or "").strip()
        batch_schedules = s.get("batchSchedules") or {}
        class_schedules = s.get("classSchedules") or {}
        # batch composite key: "Grade|Batch"
        if grade and batch:
            key = f"{grade}|{batch}"
            if key in batch_schedules:
                v = batch_schedules[key]
                # allow {workingDays:{...}} or directly {0:..}
                if isinstance(v, dict) and "workingDays" in v:
                    return v["workingDays"]
                if isinstance(v, dict):
                    return v
        if batch and batch in batch_schedules:
            v = batch_schedules[batch]
            if isinstance(v, dict) and "workingDays" in v:
                return v["workingDays"]
            if isinstance(v, dict):
                return v
        if grade and grade in class_schedules:
            v = class_schedules[grade]
            if isinstance(v, dict) and "workingDays" in v:
                return v["workingDays"]
            if isinstance(v, dict):
                return v
    return s.get("workingDays") or DEFAULT_WORKING_DAYS

def is_student_scheduled(date_iso, student, s):
    """Canonical: Is this student scheduled/eligible on this date? Precedence: override → holiday/vacation/exam → class/batch → global."""
    try:
        day = datetime.date.fromisoformat(str(date_iso))
    except (TypeError, ValueError):
        return False
    ov = _override_result(date_iso, s)
    if ov is not None:
        return ov
    hol = _holiday_result(day, s)
    if hol is not None:
        return hol
    weekly = _get_working_days_for_student(student, s)
    weekday_key = (day.weekday() + 1) % 7
    value = weekly.get(str(weekday_key), weekly.get(weekday_key, False))
    if isinstance(value, str):
        value = value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)

def classify(time_str, s):
    """Classify scan time. Never returns ABSENT/HALF_DAY — those are reconcile-derived.
    PRESENT if time <= presentCutoff, else LATE (even after lateCutoff).
    ABSENT is written only by POST /api/reconcile after lateCutoff has passed.
    halfDayCutoff is reserved and currently not classified."""
    try:
        datetime.datetime.strptime(time_str, "%H:%M:%S")
    except:
        return "LATE"
    p = s.get("presentCutoff","08:00")
    l = s.get("lateCutoff","08:30")
    def norm(t):
        if len(t)==5: t+=":00"
        return t
    p = norm(p); l = norm(l)
    if time_str <= p: return "PRESENT"
    if time_str <= l: return "LATE"
    return "LATE"

def ensure_daily(date, student_id, db):
    key = f"{date}|{student_id}"
    row = db.execute("SELECT * FROM daily WHERE key=?", (key,)).fetchone()
    if row: return dict(row)
    rec = {"key": key, "date": date, "studentId": student_id, "status": None, "firstScan": None, "lastScan": None}
    db.execute("INSERT INTO daily VALUES (?,?,?,?,?,?)", (key, date, student_id, None, None, None))
    return rec

# --- Sensor helper (real) ---
def get_sensor():
    from gt511c3 import GT511C3
    # cfg sensor: "sim" forces sim, "real" forces hardware, else auto
    mode = cfg.get("sensor","sim")
    if mode == "sim":
        return GT511C3(sim=True)
    if mode == "real":
        try:
            s = GT511C3(uart=cfg.get("uart","/dev/serial0"), baud=int(cfg.get("baud",9600)), sim=False)
            s.keep_led_on = True  # sensor light stays on while the Pi runs
            return s
        except Exception as e:
            # Do not silently enroll/scan in sim when config demands hardware.
            s = GT511C3(sim=True)
            s.last_error = f"REAL_FORCED_FAIL {e}"
            s.hw_failed = True
            return s
    # auto: try hardware, fallback sim
    try:
        s = GT511C3(uart=cfg.get("uart","/dev/serial0"), baud=int(cfg.get("baud",9600)), sim=None)
        s.keep_led_on = True
        return s
    except Exception as e:
        s = GT511C3(sim=True)
        s.last_error = str(e)
        return s

# --- Static ---
def next_finger_id(db):
    used = {r[0] for r in db.execute("SELECT fingerId FROM students WHERE active=1 AND fingerId IS NOT NULL")}
    for i in range(1, 200):
        if i not in used:
            return i
    return None

def hardware_unusable(sensor):
    return cfg.get("sensor") == "real" and (getattr(sensor, "hw_failed", False) or sensor.sim)

PROD_HTML = "ATL-Smart-Attendance-Production.html"

# Injected into the served page (serve-time only — HTML file on disk is untouched).
# Polls /api/scan/last and maps backend scans (SQLite, integer fingerId, PRESENT/LATE)
# onto the UI's window.handleRealScan(fid) (localStorage, string fid "F-<n>", Present/Late).
SCAN_BRIDGE_SCRIPT = """<script>
/* ATL scan bridge - injected by backend; drives the UI's handleRealScan from real sensor scans */
(function(){
  if (window.__ATL_BRIDGE__) return; window.__ATL_BRIDGE__ = true;
  var last = -1;
  function ensureStudent(stu, fid){
    try{
      if (typeof Students === 'undefined') return;
      var s = Students.find(function(x){ return x.fid === fid; });
      if (s) return;
      s = { id: stu.id, name: stu.name, roll: stu.roll, class: stu.grade || '', section: '',
            parent: '', phone: stu.phone || '', address: stu.address || '', photo: stu.photo || '',
            fid: fid, active: 1, enroll: stu.createdAt || '' };
      Students.push(s);
      try { saveStorage(); } catch(e){}
      try { renderClassFilters(); renderStudentList(); renderClasses(); } catch(e){}
    }catch(e){}
  }
  function poll(){
    var admin = document.getElementById("adminLayer");
    var enroll = document.getElementById("enrollModal");
    var adminOpen = admin && admin.classList.contains("open");
    var enrollOpen = enroll && enroll.classList.contains("open");
    if(adminOpen || enrollOpen){
      fetch('/api/scan/last', {cache:'no-store'}).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
        if (!d || typeof d.seq !== 'number') return;
        if (last === -1){ last = d.seq; return; }
        if (d.seq > last) last = d.seq;
      }).catch(function(){});
      return;
    }
    fetch('/api/scan/last', {cache:'no-store'}).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if (!d || typeof d.seq !== 'number') return;
      if (last === -1){ last = d.seq; return; }
      if (d.seq <= last) return;
      last = d.seq;
      if (typeof window.handleRealScan !== 'function') return;
      if (d.student && d.fingerId !== null && d.fingerId !== undefined){
        var fid = 'F-' + d.fingerId;
        ensureStudent(d.student, fid);
        // pass scan info so the UI shows the real status (PRESENT/LATE/DUPLICATE) + time - include student for immediate cache
        window.handleRealScan(fid, { status: d.status, result: d.result, time: d.time, date: d.date, seq: d.seq, student: d.student });
      } else if (d.status === 'UNKNOWN' || d.result === 'UNKNOWN'){
        window.handleRealScan('__unknown__' + d.seq, { seq: d.seq });
      }
    }).catch(function(){});
  }
  setInterval(poll, 2000);
  poll();
})();
</script>"""

@app.route("/")
def index():
    return _serve_production()

@app.route("/assets/<path:path>")
def assets(path):
    return send_from_directory(str(ROOT / "assets"), path)

def _serve_production():
    """Serve the single-file production UI: ATL-Smart-Attendance-Production.html.

    Injects the scan-bridge script (before </body>) that polls /api/scan/last and
    drives the UI's window.handleRealScan(fid) from real GT-511C3 scans.
    The HTML file on disk is never modified — injection happens at serve time only.
    """
    try:
        html = (ROOT / PROD_HTML).read_text(encoding="utf-8")
        # The HTML shell is intentionally kept immutable.  Replace its inline
        # application script at serve time with the maintained source so the
        # deployed page cannot drift from backend/ui_app.js.
        ui_source = ROOT / "backend" / "ui_app.js"
        if ui_source.exists():
            start = html.find("<script>")
            end = html.rfind("</script>")
            if start != -1 and end > start:
                source = ui_source.read_text(encoding="utf-8")
                html = html[:start] + "<script>\n" + source + "\n</script>" + html[end + len("</script>"):]
        if "window.handleRealScan" in html and "__ATL_BRIDGE__" not in html:
            idx = html.rfind("</body>")
            if idx != -1:
                html = html[:idx] + SCAN_BRIDGE_SCRIPT + html[idx:]
        return Response(html, mimetype="text/html", headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        })
    except Exception:
        return send_from_directory(str(ROOT), PROD_HTML)


# --- Health with edge checks ---
@app.route("/api/health")
def health():
    clk_ok, clk_msg = validate_clock()
    db_ok = True
    db_msg = DB_PATH
    try:
        get_db().execute("SELECT 1")
    except Exception as e:
        db_ok = False
        db_msg = f"DB_FAIL {e}"
    uart_ok = True
    uart_msg = "sim"
    ready = True
    sensor_name = "sim"
    if not SENSOR_LOCK.acquire(blocking=False):
        uart_msg = "busy enroll/scan"
        sensor_name = "busy"
        status = "ok" if (clk_ok and db_ok) else "degraded"
        # surface settings load fallback if any
        try:
            _settings = public_settings()
            _settings_error = getattr(g, "settings_load_error", None)
        except:
            _settings = public_settings()
            _settings_error = None
        try:
            _db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
        except: _db_size = 0
        payload = {
            "ok": status == "ok",
            "status": status,
            "sensor": sensor_name,
            "sensor_detail": uart_msg,
            "clock": clk_msg,
            "db": db_msg,
            "db_ok": db_ok,
            "db_size": _db_size,
            "imagesDir": IMAGES_DIR,
            "sensor_mode": cfg.get("sensor", "sim"),
            "settings": _settings,
        }
        if _settings_error:
            payload["settings_error"] = str(_settings_error)
        return jsonify(payload)
    try:
        if cfg.get("sensor") == "sim":
            sensor_name = "sim"
            uart_msg = "sim"
        elif (time.time() - _UART_PING["t"]) < 25:
            # Reuse last ping — opening UART / LED / Close here fights the scan loop.
            uart_ok = _UART_PING["ok"]
            uart_msg = _UART_PING["msg"]
            sensor_name = _UART_PING["name"]
            ready = uart_ok
        else:
            sensor = get_sensor()
            ready = sensor.is_ready()
            if hardware_unusable(sensor):
                ready = False
                uart_ok = False
                uart_msg = f"offline {getattr(sensor,'last_error','') or 'hardware not ready'}"
            else:
                uart_ok = ready
                uart_msg = "ready" if ready else f"offline {getattr(sensor,'last_error','')}"
            sensor_name = "ready" if uart_ok else "offline"
            sensor.close()
            _UART_PING.update({"t": time.time(), "ok": uart_ok, "msg": uart_msg, "name": sensor_name})
    finally:
        SENSOR_LOCK.release()
    status = "ok" if (clk_ok and db_ok and (cfg.get("sensor")=="sim" or uart_ok)) else "degraded"
    try:
        _settings = public_settings()
        _settings_error = getattr(g, "settings_load_error", None)
    except:
        _settings = public_settings()
        _settings_error = None
    try:
        _db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
    except: _db_size = 0
    payload = {
        "ok": status=="ok",
        "status": status,
        "sensor": sensor_name,
        "sensor_detail": uart_msg,
        "clock": clk_msg,
        "db": db_msg,
        "db_ok": db_ok,
        "db_size": _db_size,
        "imagesDir": IMAGES_DIR,
        "sensor_mode": cfg.get("sensor", "sim"),
        "settings": _settings,
    }
    if _settings_error:
        payload["settings_error"] = str(_settings_error)
    return jsonify(payload)

# --- Settings ---
@app.route("/api/settings", methods=["GET","POST"])
def settings():
    if request.method == "GET":
        return jsonify(public_settings())
    # admin PIN gate for writes (opt-in, empty pin = open)
    pin = _admin_pin()
    if pin:
        got = (request.headers.get("X-Admin-Pin") or "").strip()
        if got != pin:
            return jsonify({"error": "admin pin required"}), 401
    try:
        j = request.get_json(force=True)
    except Exception:
        return jsonify({"error":"invalid JSON"}), 400
    cur = get_settings()
    # whitelist (never accept sensor/uart/db/host from the UI)
    for k in ["schoolName","address","region","academicYear","schoolOpeningDate","attendanceStartDate","presentCutoff","lateCutoff","halfDayCutoff","trajectoryLabels","schoolLogo","planetImage","heroImage"]:
        if k in j:
            cur[k] = j[k]
    if "workingDays" in j:
        wd = j["workingDays"]
        if isinstance(wd, dict):
            try:
                cur["workingDays"] = _clean_wd(wd, DEFAULT_WORKING_DAYS)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
        else:
            return jsonify({"error": "workingDays must be an object"}), 400
    if "overrides" in j:
        ov = j["overrides"]
        if isinstance(ov, str):
            ov = [x.strip() for x in ov.splitlines() if x.strip()]
        elif not isinstance(ov, list):
            return jsonify({"error": "overrides must be a list"}), 400
        clean_ov = []
        for o in ov[:100]:
            raw = str(o).strip()
            if not raw:
                continue
            date_part = raw.split(":")[0].strip()
            try:
                datetime.date.fromisoformat(date_part)
            except Exception:
                return jsonify({"error": f"bad override {raw}"}), 400
            clean_ov.append(raw[:120])
        cur["overrides"] = clean_ov
    if "minPercent" in j:
        try: cur["minPercent"] = int(j["minPercent"])
        except: return jsonify({"error":"minPercent must be an integer"}), 400
        if cur["minPercent"] < 0 or cur["minPercent"] > 100:
            return jsonify({"error":"minPercent must be 0-100"}), 400
    if "holidays" in j:
        hol = j["holidays"]
        if isinstance(hol, str):
            hol = [x.strip() for x in hol.splitlines() if x.strip()]
        elif not isinstance(hol, list):
            return jsonify({"error":"holidays must be a list"}), 400
        cleaned_h = []
        for h in hol[:80]:
            raw = str(h).strip()
            if not raw:
                continue
            day = raw.split(":", 1)[0].strip()
            try:
                if ".." in day:
                    start, end = [x.strip() for x in day.split("..", 1)]
                    datetime.date.fromisoformat(start)
                    datetime.date.fromisoformat(end)
                    if start > end:
                        raise ValueError("range is reversed")
                else:
                    datetime.date.fromisoformat(day)
            except Exception:
                return jsonify({"error":f"bad holiday {raw}"}), 400
            cleaned_h.append(raw[:80])
        cur["holidays"] = cleaned_h
    if "classes" in j:
        if isinstance(j["classes"], str):
            cur["classes"] = [x.strip() for x in j["classes"].split(",") if x.strip()]
        elif isinstance(j["classes"], list):
            cur["classes"] = [str(x).strip() for x in j["classes"] if str(x).strip()]
        else:
            return jsonify({"error":"classes must be a list"}), 400
    if "batches" in j:
        if isinstance(j["batches"], str):
            cur["batches"] = [x.strip() for x in j["batches"].split(",") if x.strip()][:50]
        elif isinstance(j["batches"], list):
            cur["batches"] = [str(x).strip() for x in j["batches"] if str(x).strip()][:50]
        else:
            return jsonify({"error":"batches must be a list"}), 400
    if "classSchedules" in j:
        raw = j["classSchedules"]
        if not isinstance(raw, dict):
            return jsonify({"error":"classSchedules must be an object"}), 400
        cleaned_cs = {}
        for k, v in raw.items():
            key = str(k).strip()
            if not key:
                continue
            if len(key) > 80:
                return jsonify({"error":f"classSchedules key too long {key}"}), 400
            if isinstance(v, dict) and "workingDays" in v:
                try:
                    cleaned_cs[key] = {"workingDays": _clean_wd(v["workingDays"])}
                except Exception as e:
                    return jsonify({"error":f"bad classSchedules for {key}: {e}"}), 400
            elif isinstance(v, dict):
                try:
                    cleaned_cs[key] = _clean_wd(v)
                except Exception as e:
                    return jsonify({"error":f"bad classSchedules for {key}: {e}"}), 400
            else:
                return jsonify({"error":f"bad classSchedules for {key}"}), 400
            if len(cleaned_cs) >= 50:
                break
        cur["classSchedules"] = cleaned_cs
    if "batchSchedules" in j:
        raw = j["batchSchedules"]
        if not isinstance(raw, dict):
            return jsonify({"error":"batchSchedules must be an object"}), 400
        cleaned_bs = {}
        for k, v in raw.items():
            key = str(k).strip()
            if not key:
                continue
            if len(key) > 80:
                return jsonify({"error":f"batchSchedules key too long {key}"}), 400
            if isinstance(v, dict) and "workingDays" in v:
                try:
                    cleaned_bs[key] = {"workingDays": _clean_wd(v["workingDays"])}
                except Exception as e:
                    return jsonify({"error":f"bad batchSchedules for {key}: {e}"}), 400
            elif isinstance(v, dict):
                try:
                    cleaned_bs[key] = _clean_wd(v)
                except Exception as e:
                    return jsonify({"error":f"bad batchSchedules for {key}: {e}"}), 400
            else:
                return jsonify({"error":f"bad batchSchedules for {key}"}), 400
            if len(cleaned_bs) >= 50:
                break
        cur["batchSchedules"] = cleaned_bs
    if "imageGallery" in j:
        gal = j["imageGallery"]
        if not isinstance(gal, list):
            return jsonify({"error":"imageGallery must be a list"}), 400
        cleaned = []
        for item in gal[:60]:
            if not isinstance(item, dict):
                continue
            cleaned.append({
                "id": str(item.get("id") or uuid.uuid4())[:80],
                "url": str(item.get("url") or "")[:4000],
                "name": str(item.get("name") or "image")[:120],
                "category": str(item.get("category") or "gallery")[:40],
                "at": str(item.get("at") or today_ist())[:32],
            })
        cur["imageGallery"] = [x for x in cleaned if x["url"]]
    # validate dates
    for dk in ["schoolOpeningDate","attendanceStartDate"]:
        if dk in cur:
            try: datetime.date.fromisoformat(cur[dk])
            except: return jsonify({"error":f"bad date {dk}"}), 400
    # validate cutoffs
    for ck in ["presentCutoff","lateCutoff","halfDayCutoff"]:
        if ck in cur and cur[ck]:
            try: datetime.datetime.strptime(cur[ck], "%H:%M")
            except:
                try: datetime.datetime.strptime(cur[ck], "%H:%M:%S")
                except: return jsonify({"error":f"bad time {ck}"}), 400
    def _mins(t):
        p = str(t).split(":")
        return int(p[0]) * 60 + int(p[1])
    try:
        if cur.get("presentCutoff") and cur.get("lateCutoff") and _mins(cur["presentCutoff"]) > _mins(cur["lateCutoff"]):
            return jsonify({"error":"presentCutoff must be before lateCutoff"}), 400
    except Exception:
        return jsonify({"error":"bad time cutoff"}), 400
    save_settings(cur)
    try:
        with DB_LOCK:
            db = get_db()
            db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "SETTINGS_CHANGED", json.dumps({k: cur[k] for k in cur if k not in ("sensor","uart","baud","db","host","port","imagesDir")})[:500]))
            db.commit()
    except: pass
    return jsonify(public_settings())

# --- Students ---
@app.route("/api/students", methods=["GET","POST"])
def list_students():
    try:
        db = get_db()
        if request.method == "GET":
            # support search query ?q=, ?class=, ?active=all
            q = (request.args.get("q") or "").strip().lower()
            cls = (request.args.get("class") or "").strip()
            active_filter = request.args.get("active") or "1"
            sql = "SELECT * FROM students WHERE 1=1"
            params = []
            if active_filter != "all":
                sql += " AND active=1"
            if cls:
                sql += " AND lower(grade)=lower(?)"
                params.append(cls)
            sql += " ORDER BY id"
            rows = db.execute(sql, params).fetchall()
            # post-filter for q (name/roll/class/phone/address)
            if q:
                filtered = []
                for r in rows:
                    d = dict(r)
                    hay = " ".join([
                        str(d.get("name","")), str(d.get("roll","")), str(d.get("grade","")),
                        str(d.get("batch","")), str(d.get("section","")), str(d.get("parent","")),
                        str(d.get("phone","")), str(d.get("address","")),
                        ("" if d.get("fingerId") is None else f"F-{d.get('fingerId')}")
                    ]).lower()
                    if q in hay:
                        filtered.append(r)
                rows = filtered
            rates = {}
            for r in db.execute("SELECT studentId, status, COUNT(*) AS c FROM daily GROUP BY studentId, status"):
                sid = r["studentId"]
                rec = rates.setdefault(sid, {"ok": 0, "all": 0})
                if r["status"] in ("PRESENT", "LATE", "ABSENT"):
                    rec["all"] += r["c"]
                    if r["status"] in ("PRESENT", "LATE"):
                        rec["ok"] += r["c"]
            out = []
            for row in rows:
                d = dict(row)
                st = rates.get(d["id"], {"ok": 0, "all": 0})
                d["attendance_rate"] = round(st["ok"] / st["all"] * 100) if st["all"] else 0
                # ensure address field present
                if "address" not in d:
                    d["address"] = ""
                out.append(d)
            return jsonify(out)
        # Admin PIN gate for POST only (GET remains open for roster load)
        pin = _admin_pin()
        if pin:
            got = (request.headers.get("X-Admin-Pin") or "").strip()
            if got != pin:
                return jsonify({"error":"admin pin required"}), 401
        try:
            j = request.get_json(force=True)
        except Exception:
            return jsonify({"error":"invalid JSON"}), 400
        name = (j.get("name") or "").strip()
        roll = (j.get("roll") or "").strip()
        grade = (j.get("grade") or j.get("class") or "").strip()
        batch = (j.get("batch") or j.get("group") or "").strip()
        section = (j.get("section") or "").strip()
        parent = (j.get("parent") or j.get("parent_name") or "").strip()
        phone = (j.get("phone") or "").strip()
        address = (j.get("address") or "").strip()
        ok_photo, photo = _photo_ok(j.get("photo") or "")
        if not ok_photo:
            return jsonify({"error": photo}), 400
        if not name or not roll:
            return jsonify({"error":"name and roll required"}), 400
        if len(roll) > 20 or len(name) > 80:
            return jsonify({"error":"name/roll too long"}), 400
        if not grade:
            return jsonify({"error":"grade required"}), 400
        if grade and len(grade) > 40:
            return jsonify({"error":"grade too long"}), 400
        if len(batch) > 40:
            return jsonify({"error":"batch too long"}), 400
        if len(section) > 20:
            return jsonify({"error":"section too long"}), 400
        if len(parent) > 80:
            return jsonify({"error":"parent too long"}), 400
        if len(phone) > 40:
            return jsonify({"error":"phone too long"}), 400
        if len(address) > 200:
            return jsonify({"error":"address too long"}), 400
        digits = "".join(c for c in phone if c.isdigit())
        if phone and len(digits) < 8:
            return jsonify({"error":"phone too short"}), 400
        if db.execute("SELECT 1 FROM students WHERE active=1 AND lower(roll)=lower(?)", (roll,)).fetchone():
            return jsonify({"error":"roll exists"}), 409
        s = get_settings()
        if grade and grade.lower() not in [c.lower() for c in s.get("classes",[])]:
            s["classes"] = s.get("classes",[])+[grade]
            save_settings(s)
        if batch and batch.lower() not in [b.lower() for b in s.get("batches",[])]:
            s["batches"] = s.get("batches",[])+[batch]
            save_settings(s)
        with DB_LOCK:
            cur = db.execute(
                "INSERT INTO students (name, roll, grade, batch, section, parent, phone, address, fingerId, photo, active, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (name, roll, grade, batch, section, parent, phone, address, None, photo, 1, today_ist()),
            )
            nid = int(cur.lastrowid)
            db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "STUDENT_IMPORTED", f"{name} -> {grade} (no sensor)"))
            db.commit()
        return jsonify({"id": nid, "fingerId": None, "grade": grade, "sensor": False}), 201
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/students/<int:sid>", methods=["GET"])
def get_student(sid):
    try:
        db = get_db()
        row = db.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
        if not row:
            return jsonify({"error":"not found"}), 404
        d = dict(row)
        # attendance history
        events = [dict(r) for r in db.execute("SELECT * FROM events WHERE studentId=? ORDER BY date DESC, time DESC LIMIT 500", (sid,)).fetchall()]
        daily = [dict(r) for r in db.execute("SELECT * FROM daily WHERE studentId=? ORDER BY date DESC LIMIT 500", (sid,)).fetchall()]
        # also include unknown/duplicate attempts if fingerId matches?
        d["events"] = events
        d["daily"] = daily
        # stats
        present = db.execute("SELECT COUNT(*) FROM daily WHERE studentId=? AND status='PRESENT'", (sid,)).fetchone()[0]
        late = db.execute("SELECT COUNT(*) FROM daily WHERE studentId=? AND status='LATE'", (sid,)).fetchone()[0]
        dup = db.execute("SELECT COUNT(*) FROM events WHERE studentId=? AND status='DUPLICATE'", (sid,)).fetchone()[0]
        unknown = 0
        if d.get("fingerId") is not None:
            unknown = db.execute("SELECT COUNT(*) FROM events WHERE fingerId=? AND status='UNKNOWN'", (d["fingerId"],)).fetchone()[0]
        d["stats"] = {"present": present, "late": late, "duplicate": dup, "unknown": unknown}
        return jsonify(d)
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/students/<int:sid>", methods=["PATCH"])
@require_admin
def patch_student(sid):
    try:
        j = request.get_json(force=True) or {}
    except Exception:
        return jsonify({"error":"invalid JSON"}), 400
    try:
        db = get_db()
        row = db.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
        if not row:
            return jsonify({"error":"not found"}), 404
        updates = []
        params = []
        # photo
        if "photo" in j:
            ok_photo, photo = _photo_ok(j.get("photo") or "")
            if not ok_photo:
                return jsonify({"error": photo}), 400
            updates.append("photo=?")
            params.append(photo)
        # phone
        if "phone" in j:
            phone = str(j.get("phone") or "").strip()
            if len(phone) > 40:
                return jsonify({"error":"phone too long"}), 400
            digits = "".join(c for c in phone if c.isdigit())
            if phone and len(digits) < 8:
                return jsonify({"error":"phone too short"}), 400
            updates.append("phone=?")
            params.append(phone)
        # address
        if "address" in j:
            address = str(j.get("address") or "").strip()
            if len(address) > 200:
                return jsonify({"error":"address too long"}), 400
            updates.append("address=?")
            params.append(address)
        # name
        if "name" in j:
            name = str(j.get("name") or "").strip()
            if not name or len(name) > 80:
                return jsonify({"error":"invalid name"}), 400
            updates.append("name=?")
            params.append(name)
        # roll
        if "roll" in j:
            roll = str(j.get("roll") or "").strip()
            if not roll or len(roll) > 20:
                return jsonify({"error":"invalid roll"}), 400
            # check duplicate
            existing = db.execute("SELECT id FROM students WHERE active=1 AND lower(roll)=lower(?) AND id!=?", (roll, sid)).fetchone()
            if existing:
                return jsonify({"error":"roll exists"}), 409
            updates.append("roll=?")
            params.append(roll)
        # grade / class
        if "grade" in j or "class" in j:
            grade = str(j.get("grade") or j.get("class") or "").strip()
            if not grade or len(grade) > 40:
                return jsonify({"error":"invalid grade"}), 400
            updates.append("grade=?")
            params.append(grade)
            # auto-add class to settings
            s = get_settings()
            if grade.lower() not in [c.lower() for c in s.get("classes",[])]:
                s["classes"] = s.get("classes",[])+[grade]
                save_settings(s)
        # batch / group
        if "batch" in j or "group" in j:
            raw_batch = j.get("batch") if "batch" in j else j.get("group")
            batch = str(raw_batch or "").strip()
            if len(batch) > 40:
                return jsonify({"error":"batch too long"}), 400
            updates.append("batch=?")
            params.append(batch)
            if batch:
                s = get_settings()
                if batch.lower() not in [b.lower() for b in s.get("batches",[])]:
                    s["batches"] = s.get("batches",[])+[batch]
                    save_settings(s)
        # section
        if "section" in j:
            section = str(j.get("section") or "").strip()
            if len(section) > 20:
                return jsonify({"error":"section too long"}), 400
            updates.append("section=?")
            params.append(section)
        # parent / parent_name / guardian
        if "parent" in j or "parent_name" in j or "guardian" in j:
            raw_parent = j.get("parent") if "parent" in j else (j.get("parent_name") if "parent_name" in j else j.get("guardian"))
            parent = str(raw_parent or "").strip()
            if len(parent) > 80:
                return jsonify({"error":"parent too long"}), 400
            updates.append("parent=?")
            params.append(parent)
        # active (inactive rows are allowed so Re-activate works)
        if "active" in j:
            active = 1 if j.get("active") else 0
            updates.append("active=?")
            params.append(active)
            if active == 1:
                roll_now = str(row["roll"] or "")
                suffix = f"#d{sid}"
                if roll_now.endswith(suffix):
                    restored = roll_now[: -len(suffix)]
                    if restored and not db.execute(
                        "SELECT 1 FROM students WHERE active=1 AND lower(roll)=lower(?) AND id!=?",
                        (restored, sid),
                    ).fetchone():
                        updates.append("roll=?")
                        params.append(restored)
        if not updates:
            return jsonify({"error":"no fields to update"}), 400
        params.append(sid)
        with DB_LOCK:
            db.execute(f"UPDATE students SET {', '.join(updates)} WHERE id=?", params)
            db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "STUDENT_UPDATED", f"id {sid} {list(j.keys())}"))
            db.commit()
            out = db.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
        return jsonify(dict(out))
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/students/<int:sid>", methods=["DELETE"])
@require_admin
def delete_student(sid):
    try:
        db = get_db()
        row = db.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
        if not row:
            return jsonify({"error":"not found"}), 404
        fid = row["fingerId"]
        sensor_msg = "NO_SLOT"
        sensor_ok = True
        # Only need sensor if there is a fingerprint to free
        if fid is not None:
            if not SENSOR_LOCK.acquire(timeout=5):
                return jsonify({"error":"sensor busy"}), 503
            try:
                sensor = get_sensor()
                if hardware_unusable(sensor):
                    try: sensor.close()
                    except: pass
                    sensor_ok = True
                    sensor_msg = "SENSOR_OFFLINE_DB_FREED"
                else:
                    try:
                        ok, msg = sensor.delete_id(int(fid))
                    except Exception as e:
                        ok, msg = False, f"EXC {e}"
                    finally:
                        try: sensor.close()
                        except: pass
                    sensor_ok = ok
                    sensor_msg = msg
                    if not ok:
                        return jsonify({"error":f"sensor delete failed: {msg}", "sensor":"offline" if not sensor.is_ready() else "error"}), 500
            finally:
                try: SENSOR_LOCK.release()
                except: pass
        # Free unique roll/slot so a later enroll can reuse them. Keep the row for history.
        with DB_LOCK:
            db.execute("UPDATE students SET active=0, roll=?, fingerId=? WHERE id=?", (f"{row['roll']}#d{sid}", None, sid))
            db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "STUDENT_DELETED", f"{row['name']} fid {fid} {sensor_msg}"))
            db.commit()
        return jsonify({"ok":True, "id":sid, "fingerId":fid, "sensor": sensor_msg})
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/students/<int:sid>/reenroll", methods=["POST"])
@require_admin
def reenroll_student(sid):
    try:
        db = get_db()
        row = db.execute("SELECT * FROM students WHERE id=? AND active=1", (sid,)).fetchone()
        if not row:
            return jsonify({"error":"not found"}), 404
        old_fid = row["fingerId"]
        # allocate new fingerId (keep old until success, then delete old)
        new_fid = next_finger_id(db)
        if new_fid is None:
            return jsonify({"error":"fingerprint DB full (200 slots)"}), 507
        if not SENSOR_LOCK.acquire(timeout=5):
            return jsonify({"error":"sensor busy"}), 503
        set_sensor_progress(mode="enroll", step=1, steps_total=3, state="place", title="Place your finger",
                            detail="Re-enroll: place the finger.", timeout_sec=40, finger=False)
        attempted_fids = []
        fid_candidate = new_fid
        ok, msg = False, "NOT_STARTED"
        try:
            for attempt in range(10):
                if fid_candidate is None:
                    used = {r[0] for r in db.execute("SELECT fingerId FROM students WHERE active=1 AND fingerId IS NOT NULL")}
                    used.update(attempted_fids)
                    fid_candidate = None
                    for i in range(1, 200):
                        if i not in used:
                            fid_candidate = i
                            break
                    if fid_candidate is None:
                        ok, msg = False, "DB_IS_FULL"
                        break
                attempted_fids.append(fid_candidate)
                sensor = get_sensor()
                if hardware_unusable(sensor):
                    try: sensor.close()
                    except: pass
                    ok, msg = False, f"sensor offline {getattr(sensor, 'last_error','') or 'hardware not ready'}"
                    break
                try:
                    ok, msg = sensor.enroll(int(fid_candidate), log=set_sensor_progress)
                except Exception as e:
                    ok, msg = False, f"EXC {e}"
                finally:
                    try: sensor.close()
                    except: pass
                if ok:
                    new_fid = fid_candidate
                    break
                if "IS_ALREADY_USED" in str(msg):
                    fid_candidate = None
                    continue
                else:
                    break
        finally:
            SENSOR_LOCK.release()
        if not ok:
            hint = enroll_hint(msg)
            set_sensor_progress(state="fail", title="Try again", detail=hint, raw=str(msg), timeout_sec=0, deadline=0)
            return jsonify({"error": f"reenroll failed: {msg}", "hint": hint}), 500
        # success: delete old finger if exists and different
        if old_fid is not None and int(old_fid) != int(new_fid):
            try:
                if SENSOR_LOCK.acquire(timeout=3):
                    try:
                        s2 = get_sensor()
                        if not hardware_unusable(s2):
                            s2.delete_id(int(old_fid))
                            s2.close()
                    finally:
                        SENSOR_LOCK.release()
            except:
                pass
        with DB_LOCK:
            db.execute("UPDATE students SET fingerId=? WHERE id=?", (new_fid, sid))
            db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "FINGER_REENROLLED", f"id {sid} {old_fid}->{new_fid}"))
            db.commit()
        set_sensor_progress(mode="enroll", step=3, steps_total=3, state="success", title="Fingerprint re-enrolled", detail="Updated", timeout_sec=0, deadline=0)
        return jsonify({"id": sid, "fingerId": new_fid, "oldFingerId": old_fid})
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/backup", methods=["GET"])
@require_admin
def backup_db():
    try:
        db = get_db()
        # checkpoint WAL
        try:
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except:
            pass
        # pyrefly: ignore [missing-import]
        from flask import send_file
        # Ensure file exists
        if not os.path.exists(DB_PATH):
            return jsonify({"error":"no DB"}), 404
        return send_file(DB_PATH, as_attachment=True, download_name=f"atl_backup_{today_ist()}.db", mimetype="application/octet-stream")
    except Exception as e:
        return jsonify({"error": f"FAIL {e}"}), 500

@app.route("/api/restore", methods=["POST"])
@require_admin
def restore_db():
    try:
        if "file" not in request.files:
            # also accept raw body
            data = request.get_data()
            if not data or len(data) < 100:
                return jsonify({"error":"no file"}), 400
            tmp = data
        else:
            f = request.files["file"]
            tmp = f.read()
            if len(tmp) < 100:
                return jsonify({"error":"invalid backup"}), 400
        # validate sqlite header
        if not tmp.startswith(b"SQLite format 3\x00"):
            return jsonify({"error":"invalid SQLite file"}), 400
        # write to temp incoming for validation before replacing live DB
        incoming = DB_PATH + ".incoming"
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        try:
            with open(incoming, "wb") as out:
                out.write(tmp)
        except Exception as e:
            return jsonify({"error": f"write failed {e}"}), 500
        # verify incoming is valid SQLite with required schema (allow triggers) — outside locks for fast fail
        try:
            test = sqlite3.connect(incoming)
            row = test.execute("PRAGMA integrity_check").fetchone()
            if not row or row[0] != "ok":
                test.close()
                try: os.remove(incoming)
                except: pass
                return jsonify({"error": "invalid SQLite file (integrity check failed)"}), 400
            names = {r[0] for r in test.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            required = {"students", "events", "daily", "settings"}
            if not required.issubset(names):
                test.close()
                try: os.remove(incoming)
                except: pass
                return jsonify({"error": "invalid backup: missing required tables"}), 400
            # also verify basic queries
            test.execute("SELECT 1 FROM students LIMIT 1")
            test.execute("SELECT 1 FROM settings LIMIT 1")
            # events/daily may be empty but must be queryable
            test.execute("SELECT 1 FROM events LIMIT 1")
            test.execute("SELECT 1 FROM daily LIMIT 1")
            test.close()
        except Exception as e:
            try:
                test.close()
            except: pass
            try: os.remove(incoming)
            except: pass
            return jsonify({"error": f"restore verify failed {e}"}), 400
        # Acquire locks to serialize against all application DB writers and sensor ops
        # Order: SENSOR_LOCK then DB_LOCK — same order as writers (sensor before DB) to avoid deadlock
        if not SENSOR_LOCK.acquire(timeout=30):
            try: os.remove(incoming)
            except: pass
            return jsonify({"error": "sensor busy, try again"}), 503
        if not DB_LOCK.acquire(timeout=30):
            SENSOR_LOCK.release()
            try: os.remove(incoming)
            except: pass
            return jsonify({"error": "database busy, try again"}), 503
        try:
            # close this request's DB connection (other threads' g.db will close at teardown; DB_LOCK ensures no writer is active)
            try:
                db = g.pop("db", None)
                if db:
                    try: db.close()
                    except: pass
            except:
                pass
            # backup current with rotation .bak -> .bak.1
            try:
                import shutil
                if os.path.exists(DB_PATH):
                    if os.path.exists(DB_PATH + ".pre_restore.bak"):
                        try: shutil.copy2(DB_PATH + ".pre_restore.bak", DB_PATH + ".pre_restore.bak.1")
                        except: pass
                    shutil.copy2(DB_PATH, DB_PATH + ".pre_restore.bak")
            except:
                pass
            # replace live DB atomically — DB_LOCK guarantees no app writer can commit to old inode after this
            # On Windows, file may still be held open; retry then fallback to copy
            try:
                os.replace(incoming, DB_PATH)
            except PermissionError as e:
                import gc, time, shutil
                try:
                    gc.collect()
                    time.sleep(0.08)
                    try:
                        tmp_c = sqlite3.connect(DB_PATH, timeout=1)
                        try:
                            tmp_c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                        except:
                            pass
                        tmp_c.close()
                    except:
                        pass
                except:
                    pass
                try:
                    time.sleep(0.05)
                    os.replace(incoming, DB_PATH)
                except PermissionError:
                    try:
                        shutil.copy2(incoming, DB_PATH)
                        try:
                            os.remove(incoming)
                        except:
                            pass
                    except Exception as e2:
                        return jsonify({"error": f"restore replace failed {e2} (original {e})"}), 500
            except Exception as e:
                return jsonify({"error": f"restore replace failed {e}"}), 500
            # Do not blindly delete -wal/-shm as primary safety; locks already ensure no app writer references old DB.
            # Stale sidecars for the old inode will be reclaimed when old fds close; new DB starts clean (backup was checkpointed TRUNCATE).
            return jsonify({"ok": True, "restored": len(tmp)})
        finally:
            try: DB_LOCK.release()
            except: pass
            try: SENSOR_LOCK.release()
            except: pass
    except Exception as e:
        return jsonify({"error": f"FAIL {e}"}), 500

# ---------------------------------------------------------------------------
# Google Drive Backup Integration (OAuth 2.0 Resumable Backup)
# ---------------------------------------------------------------------------
try:
    import backend.gdrive_backup as gb
except ImportError:
    import gdrive_backup as gb

def _gdrive_config():
    g_cfg = cfg.get("gdrive") if isinstance(cfg.get("gdrive"), dict) else {}
    client_id = os.environ.get("ATL_GDRIVE_CLIENT_ID") or g_cfg.get("clientId", "")
    client_secret = os.environ.get("ATL_GDRIVE_CLIENT_SECRET") or g_cfg.get("clientSecret", "")
    token_file = os.environ.get("ATL_GDRIVE_TOKEN_FILE") or g_cfg.get("tokenFile", "")
    if not token_file:
        if os.name == "nt":
            token_file = str(ROOT / "backend" / "gdrive_token.json")
        else:
            token_file = "/var/lib/atl/gdrive_token.json"
    folder_name = g_cfg.get("folderName") or "ATL-Attendance-Backups"
    schedule_time = g_cfg.get("scheduleTime") or "18:30"
    enabled = g_cfg.get("enabled", True) if "enabled" in g_cfg else True
    return {
        "enabled": bool(enabled),
        "client_id": str(client_id).strip(),
        "client_secret": str(client_secret).strip(),
        "token_file": token_file,
        "folder_name": folder_name,
        "schedule_time": schedule_time,
    }

def _clean_gdrive_schedule(raw: dict) -> dict:
    """Validate and sanitize gdriveSchedule dict."""
    if not isinstance(raw, dict):
        raw = {}
    enabled = bool(raw.get("enabled", True))
    raw_time = str(raw.get("time") or "18:30").strip()
    try:
        datetime.datetime.strptime(raw_time[:5], "%H:%M")
        sched_time = raw_time[:5]
    except Exception:
        sched_time = "18:30"
    
    freq = str(raw.get("frequency") or "daily").strip().lower()
    if freq not in ("daily", "interval", "weekdays"):
        freq = "daily"
        
    try:
        interval_days = int(raw.get("intervalDays", 1))
        if interval_days < 1: interval_days = 1
        elif interval_days > 30: interval_days = 30
    except Exception:
        interval_days = 1
        
    raw_weekdays = raw.get("weekdays")
    if isinstance(raw_weekdays, list):
        cleaned_wd = []
        for d in raw_weekdays:
            try:
                di = int(d)
                if 0 <= di <= 6 and di not in cleaned_wd:
                    cleaned_wd.append(di)
            except Exception: pass
        if not cleaned_wd:
            cleaned_wd = [0, 1, 2, 3, 4, 5, 6]
    else:
        cleaned_wd = [0, 1, 2, 3, 4, 5, 6]
        
    return {
        "enabled": enabled,
        "time": sched_time,
        "frequency": freq,
        "intervalDays": interval_days,
        "weekdays": sorted(cleaned_wd)
    }

def _get_gdrive_schedule() -> dict:
    """Retrieve effective gdriveSchedule from SQLite settings or defaults."""
    s = get_settings()
    raw = s.get("gdriveSchedule")
    return _clean_gdrive_schedule(raw)

_GDRIVE_STATE = {
    "last_backup_time": None,
    "last_backup_name": None,
    "last_status": "IDLE",
    "last_error": None,
    "in_progress": False,
}
_GDRIVE_DEVICE_FLOW = {
    "device_code": None,
    "user_code": None,
    "verification_url": None,
    "verification_url_complete": None,
    "expires_at": 0,
    "interval": 5,
    "lock": threading.Lock()
}
_gdrive_stop_event = threading.Event()
_gdrive_thread = None

def run_gdrive_backup(trigger="AUTO"):
    gc = _gdrive_config()
    if not gc["enabled"]:
        return {"ok": False, "error": "Google Drive backup is disabled in configuration"}
    if not gc["client_id"] or not gc["client_secret"]:
        return {"ok": False, "error": "Google Drive OAuth Client ID / Secret not configured"}

    client = gb.GDriveClient(gc, gc["token_file"])
    if not client.is_authenticated():
        _GDRIVE_STATE["last_status"] = "AUTH_REQUIRED"
        _GDRIVE_STATE["last_error"] = "Account authorization required"
        return {"ok": False, "error": "Google Drive not authorized. Please authenticate."}

    if _GDRIVE_STATE["in_progress"]:
        return {"ok": False, "error": "Backup already in progress"}

    _GDRIVE_STATE["in_progress"] = True
    _GDRIVE_STATE["last_status"] = "IN_PROGRESS"

    staging_dir = "/tmp" if os.name != "nt" else os.environ.get("TEMP", str(ROOT / "backend"))
    ts_safe = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).strftime("%Y%m%d_%H%M%S")
    staging_name = f"atl_backup_{ts_safe}.db"
    staging_path = os.path.join(staging_dir, staging_name)

    try:
        snap_info = gb.create_online_snapshot(DB_PATH, staging_path, db_lock=DB_LOCK)
        storage = gb.GDriveStorage(client, folder_name=gc["folder_name"])
        upload_res = storage.upload_snapshot_resumable(snap_info)
        pruned = storage.prune_retention()

        now_str = now_ist()
        _GDRIVE_STATE["last_backup_time"] = f"{today_ist()} {now_str}"
        _GDRIVE_STATE["last_backup_name"] = upload_res.get("name")
        _GDRIVE_STATE["last_status"] = "SUCCESS"
        _GDRIVE_STATE["last_error"] = None

        try:
            db = get_db()
            with DB_LOCK:
                db.execute(
                    "INSERT INTO audit (id, at, action, details) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), f"{today_ist()} {now_str}", "GDRIVE_BACKUP",
                     f"Uploaded {upload_res.get('name')} ({upload_res.get('size')} bytes, sha256:{upload_res.get('sha256')[:12]}..., trigger:{trigger})")
                )
                db.commit()
        except Exception:
            pass

        # Secondary Telegram backup (if enabled) - non-blocking failure mode
        try:
            tc = _telegram_config()
            if tc.get("enabled"):
                run_telegram_backup(staging_path=snap_info["path"], trigger=trigger)
        except Exception as tg_ex:
            _TELEGRAM_STATE["last_status"] = "ERROR"
            _TELEGRAM_STATE["last_error"] = _sanitize_telegram_error(str(tg_ex))

        return {
            "ok": True,
            "fileId": upload_res.get("fileId"),
            "name": upload_res.get("name"),
            "size": upload_res.get("size"),
            "sha256": upload_res.get("sha256"),
            "pruned": pruned
        }
    except gb.GDriveAuthError as e:
        _GDRIVE_STATE["last_status"] = "AUTH_REQUIRED"
        _GDRIVE_STATE["last_error"] = str(e)
        return {"ok": False, "error": f"AUTH_ERROR: {e}"}
    except gb.GDriveNetworkError as e:
        _GDRIVE_STATE["last_status"] = "NETWORK_ERROR"
        _GDRIVE_STATE["last_error"] = str(e)
        return {"ok": False, "error": f"NETWORK_ERROR: {e}"}
    except Exception as e:
        _GDRIVE_STATE["last_status"] = "ERROR"
        _GDRIVE_STATE["last_error"] = str(e)
        return {"ok": False, "error": f"FAIL: {e}"}
    finally:
        _GDRIVE_STATE["in_progress"] = False
        if os.path.exists(staging_path):
            try: os.remove(staging_path)
            except Exception: pass

# ---------------------------------------------------------------------------
# Telegram Secondary Cloud Backup Engine (Bot API sendDocument)
# ---------------------------------------------------------------------------

_TELEGRAM_STATE = {
    "last_backup_time": None,
    "last_backup_name": None,
    "last_status": "IDLE",
    "last_error": None,
    "in_progress": False,
}

def _telegram_config() -> dict:
    """Retrieve effective Telegram backup configuration."""
    t_cfg = cfg.get("telegram") if isinstance(cfg.get("telegram"), dict) else {}
    env_enabled = os.environ.get("ATL_TELEGRAM_ENABLED")
    if env_enabled is not None:
        enabled = env_enabled.lower() in ("1", "true", "yes")
    else:
        try:
            s = get_settings()
            if "telegramEnabled" in s:
                enabled = bool(s.get("telegramEnabled"))
            else:
                enabled = bool(t_cfg.get("enabled", False))
        except Exception:
            enabled = bool(t_cfg.get("enabled", False))

    bot_token = os.environ.get("ATL_TELEGRAM_BOT_TOKEN") or t_cfg.get("botToken", "")
    chat_id = os.environ.get("ATL_TELEGRAM_CHAT_ID") or t_cfg.get("chatId", "")
    return {
        "enabled": enabled,
        "bot_token": str(bot_token).strip(),
        "chat_id": str(chat_id).strip()
    }

def _clean_telegram_schedule(raw: dict) -> dict:
    """Validate and sanitize telegramSchedule dict."""
    if not isinstance(raw, dict):
        raw = {}
    enabled = bool(raw.get("enabled", True))
    raw_time = str(raw.get("time") or "18:30").strip()
    try:
        datetime.datetime.strptime(raw_time[:5], "%H:%M")
        sched_time = raw_time[:5]
    except Exception:
        sched_time = "18:30"
    
    freq = str(raw.get("frequency") or "daily").strip().lower()
    if freq not in ("daily", "interval", "weekdays"):
        freq = "daily"
        
    try:
        interval_days = int(raw.get("intervalDays", 1))
        if interval_days < 1: interval_days = 1
        elif interval_days > 30: interval_days = 30
    except Exception:
        interval_days = 1
        
    raw_weekdays = raw.get("weekdays")
    if isinstance(raw_weekdays, list):
        cleaned_wd = []
        for d in raw_weekdays:
            try:
                di = int(d)
                if 0 <= di <= 6 and di not in cleaned_wd:
                    cleaned_wd.append(di)
            except Exception: pass
        if not cleaned_wd:
            cleaned_wd = [0, 1, 2, 3, 4, 5, 6]
    else:
        cleaned_wd = [0, 1, 2, 3, 4, 5, 6]
        
    return {
        "enabled": enabled,
        "time": sched_time,
        "frequency": freq,
        "intervalDays": interval_days,
        "weekdays": sorted(cleaned_wd)
    }

def _get_telegram_schedule() -> dict:
    """Retrieve effective telegramSchedule from SQLite settings or defaults."""
    s = get_settings()
    raw = s.get("telegramSchedule")
    return _clean_telegram_schedule(raw)

def _sanitize_telegram_error(err_str: str, bot_token: str = None) -> str:
    """Ensure bot token never leaks into error logs or API responses."""
    if not err_str:
        return ""
    sanitized = str(err_str)
    if bot_token and bot_token in sanitized:
        sanitized = sanitized.replace(bot_token, "[REDACTED_TOKEN]")
    sanitized = re.sub(r"bot\d+:[a-zA-Z0-9_-]+", "bot[REDACTED]", sanitized)
    sanitized = re.sub(r"\d{8,12}:[a-zA-Z0-9_-]{30,50}", "[REDACTED_TOKEN]", sanitized)
    return sanitized

def _send_telegram_document(bot_token: str, chat_id: str, file_path: str, caption: str = "") -> dict:
    """
    Sends a file to Telegram using the official sendDocument Bot API.
    Uses pure Python standard library (urllib.request) with multipart/form-data.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Backup file not found: {file_path}")

    filename = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        file_bytes = f.read()

    boundary = f"----WebKitFormBoundary{uuid.uuid4().hex}"
    parts = []

    # chat_id
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n".encode("utf-8"))

    # caption (optional)
    if caption:
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption}\r\n".encode("utf-8"))

    # document file
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{filename}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n".encode("utf-8")
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))

    payload = b"".join(parts)
    url = f"https://api.telegram.org/bot{bot_token}/sendDocument"

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "ATL-Smart-Attendance/1.1.0"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode("utf-8")
            res_json = json.loads(data)
            if not res_json.get("ok"):
                desc = res_json.get("description", "Unknown Telegram API error")
                raise RuntimeError(f"Telegram API error: {desc}")
            return res_json.get("result", {})
    except urllib.error.HTTPError as he:
        body = ""
        try:
            body = he.read().decode("utf-8")
            err_obj = json.loads(body)
            desc = err_obj.get("description", str(he))
        except Exception:
            desc = str(he)
        raise RuntimeError(_sanitize_telegram_error(f"HTTP {he.code}: {desc}", bot_token))
    except Exception as ex:
        raise RuntimeError(_sanitize_telegram_error(f"Network error: {ex}", bot_token))

def run_telegram_backup(staging_path: str = None, trigger: str = "MANUAL") -> dict:
    """
    Executes Telegram secondary backup upload.
    Sends the verified SQLite backup snapshot as a document.
    """
    tc = _telegram_config()
    if not tc["enabled"]:
        return {"ok": False, "skipped": True, "error": "Telegram backup is disabled"}
    if not tc["bot_token"] or not tc["chat_id"]:
        _TELEGRAM_STATE["last_status"] = "CONFIG_ERROR"
        _TELEGRAM_STATE["last_error"] = "Telegram bot token or chat ID not configured"
        return {"ok": False, "error": "Telegram bot token or chat ID not configured"}

    if _TELEGRAM_STATE["in_progress"]:
        return {"ok": False, "error": "Telegram backup already in progress"}

    _TELEGRAM_STATE["in_progress"] = True
    _TELEGRAM_STATE["last_status"] = "IN_PROGRESS"

    created_staging = False
    active_path = staging_path

    try:
        if not active_path or not os.path.exists(active_path):
            staging_dir = "/tmp" if os.name != "nt" else os.environ.get("TEMP", str(ROOT / "backend"))
            ts_safe = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).strftime("%Y%m%d_%H%M%S")
            active_path = os.path.join(staging_dir, f"atl_backup_{ts_safe}.db")
            gb.create_online_snapshot(DB_PATH, active_path, db_lock=DB_LOCK)
            created_staging = True

        filename = os.path.basename(active_path)
        size = os.path.getsize(active_path)
        caption = f"ATL Smart Attendance Backup\nDate: {today_ist()} {now_ist()}\nFile: {filename}\nSize: {size:,} bytes\nTrigger: {trigger}"

        result = _send_telegram_document(tc["bot_token"], tc["chat_id"], active_path, caption)
        msg_id = result.get("message_id") if isinstance(result, dict) else None

        now_str = now_ist()
        _TELEGRAM_STATE["last_backup_time"] = f"{today_ist()} {now_str}"
        _TELEGRAM_STATE["last_backup_name"] = filename
        _TELEGRAM_STATE["last_status"] = "SUCCESS"
        _TELEGRAM_STATE["last_error"] = None

        try:
            db = get_db()
            with DB_LOCK:
                db.execute(
                    "INSERT INTO audit (id, at, action, details) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), f"{today_ist()} {now_str}", "TELEGRAM_BACKUP",
                     f"Uploaded {filename} ({size} bytes, chat: {tc['chat_id']}, msg_id: {msg_id}, trigger: {trigger})")
                )
                db.commit()
        except Exception:
            pass

        return {
            "ok": True,
            "messageId": msg_id,
            "name": filename,
            "size": size,
            "chatId": tc["chat_id"]
        }
    except Exception as e:
        err_msg = _sanitize_telegram_error(str(e), tc["bot_token"])
        _TELEGRAM_STATE["last_status"] = "ERROR"
        _TELEGRAM_STATE["last_error"] = err_msg
        return {"ok": False, "error": err_msg}
    finally:
        _TELEGRAM_STATE["in_progress"] = False
        if created_staging and active_path and os.path.exists(active_path):
            try: os.remove(active_path)
            except Exception: pass

# --- USB Storage Backup Helpers & State ---
_USB_STATE = {
    "last_backup_time": None,
    "last_backup_name": None,
    "last_status": "IDLE",
    "last_error": None,
    "in_progress": False,
}

def detect_usb_mount() -> dict:
    """Detects connected and writable USB storage device on Linux (Raspberry Pi) or Windows/mock environment."""
    # 1. Environment variable override (for tests and custom setups)
    env_path = os.environ.get("ATL_USB_MOUNT_PATH")
    if env_path and os.path.isdir(env_path) and os.access(env_path, os.W_OK):
        try:
            free_b = shutil.disk_usage(env_path).free
        except Exception:
            free_b = 0
        return {
            "connected": True,
            "mountPath": os.path.abspath(env_path),
            "label": os.path.basename(os.path.abspath(env_path)) or "USB",
            "freeBytes": free_b
        }

    # 2. Config static mountPath
    cfg_path = cfg.get("usb", {}).get("mountPath")
    if cfg_path and os.path.isdir(cfg_path) and os.access(cfg_path, os.W_OK):
        try:
            free_b = shutil.disk_usage(cfg_path).free
        except Exception:
            free_b = 0
        return {
            "connected": True,
            "mountPath": os.path.abspath(cfg_path),
            "label": os.path.basename(os.path.abspath(cfg_path)) or "USB",
            "freeBytes": free_b
        }

    # 3. Linux mount inspections (/proc/mounts, /media/*, /mnt/*)
    if os.path.exists("/proc/mounts"):
        try:
            with open("/proc/mounts", "r") as f:
                for line in f:
                    parts = line.strip().split()
                    if len(parts) >= 2:
                        dev, mountpoint = parts[0], parts[1]
                        # SCSI/USB drives appear as /dev/sd* on Linux (mmcblk0 is SD card)
                        if dev.startswith("/dev/sd") or mountpoint.startswith("/media/") or (mountpoint.startswith("/mnt/") and mountpoint not in ("/mnt", "/mnt/")):
                            if os.path.isdir(mountpoint) and os.access(mountpoint, os.W_OK) and os.path.abspath(mountpoint) not in ("/", "/boot", "/boot/firmware"):
                                try:
                                    free_b = shutil.disk_usage(mountpoint).free
                                except Exception:
                                    free_b = 0
                                return {
                                    "connected": True,
                                    "mountPath": mountpoint,
                                    "label": os.path.basename(mountpoint) or "USB",
                                    "freeBytes": free_b
                                }
        except Exception:
            pass

    # Also check standard /media user directories on Pi (even if autofs/user mount)
    for base_media in ("/media/lancer", "/media/pi", "/media"):
        if os.path.isdir(base_media):
            try:
                for entry in os.scandir(base_media):
                    if entry.is_dir() and os.access(entry.path, os.W_OK):
                        try:
                            free_b = shutil.disk_usage(entry.path).free
                        except Exception:
                            free_b = 0
                        return {
                            "connected": True,
                            "mountPath": entry.path,
                            "label": entry.name,
                            "freeBytes": free_b
                        }
            except Exception:
                pass

    # 4. Windows removable drive detection fallback (if running on Windows)
    if os.name == "nt":
        try:
            import ctypes
            bitmask = ctypes.windll.kernel32.GetLogicalDrives()
            for letter in range(2, 26):  # C: to Z:
                if bitmask & (1 << letter):
                    drive = f"{chr(65 + letter)}:\\"
                    # DRIVE_REMOVABLE = 2
                    if ctypes.windll.kernel32.GetDriveTypeW(drive) == 2:
                        if os.path.isdir(drive) and os.access(drive, os.W_OK):
                            try:
                                free_b = shutil.disk_usage(drive).free
                            except Exception:
                                free_b = 0
                            return {
                                "connected": True,
                                "mountPath": drive,
                                "label": f"USB Drive ({drive[:2]})",
                                "freeBytes": free_b
                            }
        except Exception:
            pass

    return {
        "connected": False,
        "mountPath": None,
        "label": None,
        "freeBytes": 0
    }

def _clean_usb_schedule(raw: dict) -> dict:
    """Validate and sanitize usbSchedule dict."""
    if not isinstance(raw, dict):
        raw = {}
    enabled = bool(raw.get("enabled", True))
    raw_time = str(raw.get("time") or "18:30").strip()
    try:
        datetime.datetime.strptime(raw_time[:5], "%H:%M")
        sched_time = raw_time[:5]
    except Exception:
        sched_time = "18:30"
    
    freq = str(raw.get("frequency") or "daily").strip().lower()
    if freq not in ("daily", "interval", "weekdays"):
        freq = "daily"
        
    try:
        interval_days = int(raw.get("intervalDays", 1))
        if interval_days < 1: interval_days = 1
        elif interval_days > 30: interval_days = 30
    except Exception:
        interval_days = 1
        
    raw_weekdays = raw.get("weekdays")
    if isinstance(raw_weekdays, list):
        cleaned_wd = []
        for d in raw_weekdays:
            try:
                di = int(d)
                if 0 <= di <= 6 and di not in cleaned_wd:
                    cleaned_wd.append(di)
            except Exception: pass
        if not cleaned_wd:
            cleaned_wd = [0, 1, 2, 3, 4, 5, 6]
    else:
        cleaned_wd = [0, 1, 2, 3, 4, 5, 6]
        
    return {
        "enabled": enabled,
        "time": sched_time,
        "frequency": freq,
        "intervalDays": interval_days,
        "weekdays": sorted(cleaned_wd)
    }

def _get_usb_schedule() -> dict:
    """Retrieve effective usbSchedule from SQLite settings or defaults."""
    s = get_settings()
    raw = s.get("usbSchedule")
    return _clean_usb_schedule(raw)

def run_usb_backup(trigger: str = "MANUAL") -> dict:
    """
    Executes verified backup snapshot write to attached USB storage drive.
    Validates SQLite integrity before writing to the USB storage directory.
    """
    s = get_settings()
    usb_enabled = s.get("usbEnabled", True)
    if not usb_enabled:
        return {"ok": False, "skipped": True, "error": "USB backup is disabled in settings"}

    usb_info = detect_usb_mount()
    if not usb_info["connected"] or not usb_info["mountPath"]:
        _USB_STATE["last_status"] = "USB_NOT_FOUND"
        _USB_STATE["last_error"] = "No USB storage device detected. Please connect a USB drive."
        return {"ok": False, "error": "No USB storage device detected. Please connect a USB drive."}

    if _USB_STATE["in_progress"]:
        return {"ok": False, "error": "USB backup already in progress"}

    _USB_STATE["in_progress"] = True
    _USB_STATE["last_status"] = "IN_PROGRESS"

    staging_dir = "/tmp" if os.name != "nt" else os.environ.get("TEMP", str(ROOT / "backend"))
    ts_safe = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).strftime("%Y%m%d_%H%M%S")
    filename = f"atl_backup_{ts_safe}.db"
    staging_path = os.path.join(staging_dir, filename)

    try:
        # 1. Create online snapshot under DB_LOCK
        snap_info = gb.create_online_snapshot(DB_PATH, staging_path, db_lock=DB_LOCK)

        # 2. Verify SQLite integrity before moving to USB
        test_conn = sqlite3.connect(staging_path)
        chk = test_conn.execute("PRAGMA integrity_check").fetchone()
        if not chk or chk[0] != "ok":
            test_conn.close()
            raise RuntimeError(f"Integrity check failed on staging snapshot: {chk}")

        tbls = {r[0] for r in test_conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        required = {"students", "events", "daily", "settings"}
        if not required.issubset(tbls):
            test_conn.close()
            raise RuntimeError(f"Staging snapshot missing required tables: {required - tbls}")
        test_conn.close()

        # 3. Create target directory on USB drive
        usb_target_dir = os.path.join(usb_info["mountPath"], "ATL-Attendance-Backups")
        os.makedirs(usb_target_dir, exist_ok=True)
        dest_path = os.path.join(usb_target_dir, filename)

        # 4. Copy snapshot to USB drive with buffer copy and sync
        import shutil
        shutil.copy2(staging_path, dest_path)
        if hasattr(os, "sync"):
            try: os.sync()
            except Exception: pass

        # 5. Verify copied file size
        size = os.path.getsize(dest_path)
        expected_size = snap_info.get("bytes") or snap_info.get("size") or os.path.getsize(staging_path)
        if size != expected_size:
            raise IOError(f"USB destination size mismatch: {size} vs {expected_size}")

        now_str = now_ist()
        _USB_STATE["last_backup_time"] = f"{today_ist()} {now_str}"
        _USB_STATE["last_backup_name"] = filename
        _USB_STATE["last_status"] = "SUCCESS"
        _USB_STATE["last_error"] = None

        try:
            db = get_db()
            with DB_LOCK:
                db.execute(
                    "INSERT INTO audit (id, at, action, details) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), f"{today_ist()} {now_str}", "USB_BACKUP",
                     f"Saved {filename} ({size} bytes, mount: {usb_info['mountPath']}, trigger: {trigger})")
                )
                db.commit()
        except Exception:
            pass

        return {
            "ok": True,
            "name": filename,
            "size": size,
            "mountPath": usb_info["mountPath"],
            "targetFile": dest_path
        }
    except Exception as e:
        _USB_STATE["last_status"] = "ERROR"
        _USB_STATE["last_error"] = str(e)
        return {"ok": False, "error": f"USB backup error: {e}"}
    finally:
        _USB_STATE["in_progress"] = False
        if os.path.exists(staging_path):
            try: os.remove(staging_path)
            except Exception: pass

@app.route("/api/backup/gdrive/status", methods=["GET"])
@require_admin
def gdrive_status():
    try:
        gc = _gdrive_config()
        client = gb.GDriveClient(gc, gc["token_file"])
        is_conf = client.is_configured()
        is_auth = client.is_authenticated()
        status_label = _GDRIVE_STATE["last_status"]
        if not gc["enabled"]:
            status_label = "DISABLED"
        elif not is_conf:
            status_label = "NOT_CONFIGURED"
        elif not is_auth:
            status_label = "AUTH_REQUIRED"

        with _GDRIVE_DEVICE_FLOW["lock"]:
            if _GDRIVE_DEVICE_FLOW["expires_at"] > time.time() and _GDRIVE_DEVICE_FLOW["user_code"]:
                device_flow_info = {
                    "userCode": _GDRIVE_DEVICE_FLOW["user_code"],
                    "verificationUrl": _GDRIVE_DEVICE_FLOW["verification_url"],
                    "verificationUrlComplete": _GDRIVE_DEVICE_FLOW["verification_url_complete"],
                    "expiresIn": int(_GDRIVE_DEVICE_FLOW["expires_at"] - time.time()),
                    "interval": _GDRIVE_DEVICE_FLOW["interval"]
                }
            else:
                device_flow_info = None

        sched = _get_gdrive_schedule()
        return jsonify({
            "enabled": gc["enabled"],
            "configured": is_conf,
            "authenticated": is_auth,
            "deviceFlow": device_flow_info,
            "lastBackup": _GDRIVE_STATE["last_backup_time"],
            "lastBackupName": _GDRIVE_STATE["last_backup_name"],
            "lastStatus": status_label,
            "lastError": _GDRIVE_STATE["last_error"],
            "inProgress": _GDRIVE_STATE["in_progress"],
            "folderName": gc["folder_name"],
            "scheduleTime": sched["time"],
            "schedule": sched,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500

@app.route("/api/backup/gdrive/schedule", methods=["GET", "POST"])
@require_admin
def gdrive_schedule_endpoint():
    if request.method == "GET":
        return jsonify({"ok": True, "schedule": _get_gdrive_schedule()})
    try:
        j = request.get_json(force=True) or {}
    except Exception:
        return jsonify({"error": "invalid JSON"}), 400

    clean_sched = _clean_gdrive_schedule(j)
    
    # Save into SQLite settings under key "gdriveSchedule"
    with DB_LOCK:
        cur_settings = get_settings()
        cur_settings["gdriveSchedule"] = clean_sched
        save_settings(cur_settings)
        try:
            db = get_db()
            db.execute(
                "INSERT INTO audit (id, at, action, details) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), f"{today_ist()} {now_ist()}", "GDRIVE_SCHEDULE_CHANGED", json.dumps(clean_sched))
            )
            db.commit()
        except Exception: pass

    return jsonify({"ok": True, "schedule": clean_sched})

@app.route("/api/backup/gdrive/device-start", methods=["GET", "POST"])
@require_admin
def gdrive_device_start():
    gc = _gdrive_config()
    client = gb.GDriveClient(gc, gc["token_file"])
    if not client.is_configured():
        return jsonify({"error": "Google OAuth Client ID and Secret are not configured in backend config.json"}), 400
    try:
        res = client.start_device_flow()
        with _GDRIVE_DEVICE_FLOW["lock"]:
            _GDRIVE_DEVICE_FLOW["device_code"] = res["device_code"]
            _GDRIVE_DEVICE_FLOW["user_code"] = res["user_code"]
            _GDRIVE_DEVICE_FLOW["verification_url"] = res["verification_url"]
            _GDRIVE_DEVICE_FLOW["verification_url_complete"] = res["verification_url_complete"]
            _GDRIVE_DEVICE_FLOW["expires_at"] = time.time() + res.get("expires_in", 1800)
            _GDRIVE_DEVICE_FLOW["interval"] = res.get("interval", 5)
        return jsonify({
            "ok": True,
            "userCode": res["user_code"],
            "verificationUrl": res["verification_url"],
            "verificationUrlComplete": res["verification_url_complete"],
            "expiresIn": res.get("expires_in", 1800),
            "interval": res.get("interval", 5)
        })
    except (gb.GDriveAuthError, gb.GDriveNetworkError) as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/backup/gdrive/device-poll", methods=["POST"])
@require_admin
def gdrive_device_poll():
    gc = _gdrive_config()
    client = gb.GDriveClient(gc, gc["token_file"])
    with _GDRIVE_DEVICE_FLOW["lock"]:
        device_code = _GDRIVE_DEVICE_FLOW.get("device_code")
        expires_at = _GDRIVE_DEVICE_FLOW.get("expires_at", 0)

    if not device_code or time.time() > expires_at:
        return jsonify({"status": "expired", "error": "Authorization session has expired. Please restart."}), 400

    try:
        res = client.poll_device_flow(device_code)
        if res.get("status") == "success":
            with _GDRIVE_DEVICE_FLOW["lock"]:
                _GDRIVE_DEVICE_FLOW["device_code"] = None
                _GDRIVE_DEVICE_FLOW["user_code"] = None
                _GDRIVE_DEVICE_FLOW["expires_at"] = 0
            _GDRIVE_STATE["last_status"] = "IDLE"
            _GDRIVE_STATE["last_error"] = None
            return jsonify({"status": "success", "authenticated": True})
        elif res.get("status") in ("pending", "slow_down"):
            return jsonify({"status": res["status"]})
        else:
            return jsonify(res)
    except gb.GDriveAuthError as e:
        with _GDRIVE_DEVICE_FLOW["lock"]:
            _GDRIVE_DEVICE_FLOW["device_code"] = None
            _GDRIVE_DEVICE_FLOW["user_code"] = None
            _GDRIVE_DEVICE_FLOW["expires_at"] = 0
        _GDRIVE_STATE["last_status"] = "AUTH_REQUIRED"
        _GDRIVE_STATE["last_error"] = str(e)
        return jsonify({"status": "error", "error": str(e)}), 400
    except gb.GDriveNetworkError as e:
        return jsonify({"status": "network_error", "error": str(e)}), 503

@app.route("/api/backup/gdrive/device-cancel", methods=["POST"])
@require_admin
def gdrive_device_cancel():
    with _GDRIVE_DEVICE_FLOW["lock"]:
        _GDRIVE_DEVICE_FLOW["device_code"] = None
        _GDRIVE_DEVICE_FLOW["user_code"] = None
        _GDRIVE_DEVICE_FLOW["expires_at"] = 0
    return jsonify({"ok": True})

@app.route("/api/backup/gdrive/disconnect", methods=["POST"])
@require_admin
def gdrive_disconnect():
    gc = _gdrive_config()
    client = gb.GDriveClient(gc, gc["token_file"])
    client.disconnect()
    _GDRIVE_STATE["last_status"] = "AUTH_REQUIRED"
    _GDRIVE_STATE["last_error"] = None
    return jsonify({"ok": True})

@app.route("/api/backup/gdrive/backup", methods=["POST"])
@require_admin
def gdrive_manual_backup():
    res = run_gdrive_backup(trigger="MANUAL")
    if res.get("ok"):
        return jsonify(res)
    status_code = 401 if "AUTH" in str(res.get("error")) else 500
    return jsonify(res), status_code

@app.route("/api/backup/gdrive/list", methods=["GET"])
@require_admin
def gdrive_list():
    gc = _gdrive_config()
    client = gb.GDriveClient(gc, gc["token_file"])
    if not client.is_authenticated():
        return jsonify({"error": "Google Drive not authenticated"}), 401
    try:
        storage = gb.GDriveStorage(client, folder_name=gc["folder_name"])
        files = storage.list_backups()
        return jsonify({"files": files})
    except (gb.GDriveAuthError, gb.GDriveNetworkError) as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/backup/gdrive/restore", methods=["POST"])
@require_admin
def gdrive_restore():
    try:
        j = request.get_json(silent=True) or {}
        file_id = j.get("fileId")
        if not file_id:
            return jsonify({"error": "fileId required"}), 400

        gc = _gdrive_config()
        client = gb.GDriveClient(gc, gc["token_file"])
        if not client.is_authenticated():
            return jsonify({"error": "Google Drive not authenticated"}), 401

        storage = gb.GDriveStorage(client, folder_name=gc["folder_name"])
        incoming = DB_PATH + ".incoming"
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        storage.download_backup(file_id, incoming)

        with open(incoming, "rb") as f:
            header = f.read(16)
            if not header.startswith(b"SQLite format 3\x00"):
                if os.path.exists(incoming):
                    try: os.remove(incoming)
                    except: pass
                return jsonify({"error": "invalid SQLite file from cloud"}), 400

        test = sqlite3.connect(incoming)
        row = test.execute("PRAGMA integrity_check").fetchone()
        if not row or row[0] != "ok":
            test.close()
            if os.path.exists(incoming):
                try: os.remove(incoming)
                except: pass
            return jsonify({"error": "integrity check failed on cloud backup"}), 400
        names = {r[0] for r in test.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        required = {"students", "events", "daily", "settings"}
        if not required.issubset(names):
            test.close()
            if os.path.exists(incoming):
                try: os.remove(incoming)
                except: pass
            return jsonify({"error": "cloud backup missing required tables"}), 400
        test.close()

        if not SENSOR_LOCK.acquire(timeout=30):
            try: os.remove(incoming)
            except: pass
            return jsonify({"error": "sensor busy, try again"}), 503
        if not DB_LOCK.acquire(timeout=30):
            SENSOR_LOCK.release()
            try: os.remove(incoming)
            except: pass
            return jsonify({"error": "database busy, try again"}), 503

        try:
            db = g.pop("db", None)
            if db:
                try: db.close()
                except: pass
            import shutil
            if os.path.exists(DB_PATH):
                if os.path.exists(DB_PATH + ".pre_restore.bak"):
                    try: shutil.copy2(DB_PATH + ".pre_restore.bak", DB_PATH + ".pre_restore.bak.1")
                    except: pass
                shutil.copy2(DB_PATH, DB_PATH + ".pre_restore.bak")

            try:
                os.replace(incoming, DB_PATH)
            except PermissionError:
                import gc, time
                try:
                    gc.collect()
                    time.sleep(0.08)
                except: pass
                try:
                    os.replace(incoming, DB_PATH)
                except PermissionError:
                    shutil.copy2(incoming, DB_PATH)
                    try: os.remove(incoming)
                    except: pass

            restored_size = os.path.getsize(DB_PATH)
            try:
                rec_db = get_db()
                rec_db.execute(
                    "INSERT INTO audit (id, at, action, details) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), f"{today_ist()} {now_ist()}", "GDRIVE_RESTORE", f"Restored cloud fileId: {file_id}, size: {restored_size}")
                )
                rec_db.commit()
            except: pass

            return jsonify({"ok": True, "restored": restored_size, "fileId": file_id})
        finally:
            try: DB_LOCK.release()
            except: pass
            try: SENSOR_LOCK.release()
            except: pass
    except Exception as e:
        return jsonify({"error": f"FAIL {e}"}), 500

# ---------------------------------------------------------------------------
# Telegram Secondary Backup Endpoints
# ---------------------------------------------------------------------------

@app.route("/api/backup/telegram/status", methods=["GET"])
@require_admin
def telegram_status():
    try:
        tc = _telegram_config()
        is_conf = bool(tc["bot_token"] and tc["chat_id"])
        status_label = _TELEGRAM_STATE["last_status"]
        if not tc["enabled"]:
            status_label = "DISABLED"
        elif not is_conf:
            status_label = "NOT_CONFIGURED"

        return jsonify({
            "enabled": tc["enabled"],
            "configured": is_conf,
            "chatId": tc["chat_id"] if tc["chat_id"] else None,
            "lastStatus": status_label,
            "lastBackup": _TELEGRAM_STATE["last_backup_time"],
            "lastBackupName": _TELEGRAM_STATE["last_backup_name"],
            "lastError": _TELEGRAM_STATE["last_error"],
            "inProgress": _TELEGRAM_STATE["in_progress"],
            "schedule": _get_telegram_schedule()
        })
    except Exception as e:
        return jsonify({"error": f"FAIL {e}"}), 500

@app.route("/api/backup/telegram/schedule", methods=["GET", "POST"])
@require_admin
def telegram_schedule_endpoint():
    if request.method == "GET":
        return jsonify({"ok": True, "schedule": _get_telegram_schedule()})
    try:
        j = request.get_json(force=True) or {}
    except Exception:
        return jsonify({"error": "invalid JSON"}), 400

    clean_sched = _clean_telegram_schedule(j)
    
    # Save into SQLite settings under key "telegramSchedule"
    with DB_LOCK:
        cur_settings = get_settings()
        cur_settings["telegramSchedule"] = clean_sched
        save_settings(cur_settings)
        try:
            db = get_db()
            db.execute(
                "INSERT INTO audit (id, at, action, details) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), f"{today_ist()} {now_ist()}", "TELEGRAM_SCHEDULE_CHANGED", json.dumps(clean_sched))
            )
            db.commit()
        except Exception: pass

    return jsonify({"ok": True, "schedule": clean_sched})

@app.route("/api/backup/telegram/backup", methods=["POST"])
@require_admin
def telegram_manual_backup():
    res = run_telegram_backup(trigger="MANUAL")
    if res.get("ok"):
        return jsonify(res)
    return jsonify(res), 400 if res.get("skipped") else 500

@app.route("/api/backup/telegram/toggle", methods=["POST"])
@require_admin
def telegram_toggle():
    try:
        j = request.get_json(force=True) or {}
        new_val = bool(j.get("enabled", False))
        cur = get_settings()
        cur["telegramEnabled"] = new_val
        save_settings(cur)
        if isinstance(cfg.get("telegram"), dict):
            cfg["telegram"]["enabled"] = new_val
        return jsonify({"ok": True, "enabled": new_val})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/backup/telegram/clear-status", methods=["POST"])
@require_admin
def telegram_clear_status():
    _TELEGRAM_STATE["last_error"] = None
    _TELEGRAM_STATE["last_status"] = "IDLE"
    return jsonify({"ok": True})

# --- USB Backup Endpoints ---
@app.route("/api/backup/usb/status", methods=["GET"])
@require_admin
def usb_status():
    try:
        usb_info = detect_usb_mount()
        s = get_settings()
        usb_enabled = s.get("usbEnabled", True)
        status_label = _USB_STATE["last_status"]
        if not usb_enabled:
            status_label = "DISABLED"
        elif not usb_info["connected"]:
            status_label = "USB_NOT_FOUND"

        return jsonify({
            "enabled": usb_enabled,
            "connected": usb_info["connected"],
            "mountPath": usb_info["mountPath"],
            "label": usb_info["label"],
            "freeBytes": usb_info["freeBytes"],
            "lastStatus": status_label,
            "lastBackup": _USB_STATE["last_backup_time"],
            "lastBackupName": _USB_STATE["last_backup_name"],
            "lastError": _USB_STATE["last_error"],
            "inProgress": _USB_STATE["in_progress"],
            "schedule": _get_usb_schedule()
        })
    except Exception as e:
        return jsonify({"error": f"FAIL {e}"}), 500

@app.route("/api/backup/usb/backup", methods=["POST"])
@require_admin
def usb_manual_backup():
    res = run_usb_backup(trigger="MANUAL")
    if res.get("ok"):
        return jsonify(res)
    return jsonify(res), 400

@app.route("/api/backup/usb/toggle", methods=["POST"])
@require_admin
def usb_toggle():
    try:
        j = request.get_json(force=True) or {}
        new_val = bool(j.get("enabled", False))
        cur = get_settings()
        cur["usbEnabled"] = new_val
        save_settings(cur)
        return jsonify({"ok": True, "enabled": new_val})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/backup/usb/clear-status", methods=["POST"])
@require_admin
def usb_clear_status():
    _USB_STATE["last_error"] = None
    _USB_STATE["last_status"] = "IDLE"
    return jsonify({"ok": True})

@app.route("/api/backup/usb/schedule", methods=["GET", "POST"])
@require_admin
def usb_schedule_endpoint():
    if request.method == "GET":
        return jsonify({"ok": True, "schedule": _get_usb_schedule()})
    try:
        j = request.get_json(force=True) or {}
    except Exception:
        return jsonify({"error": "invalid JSON"}), 400

    clean_sched = _clean_usb_schedule(j)
    
    with DB_LOCK:
        cur_settings = get_settings()
        cur_settings["usbSchedule"] = clean_sched
        save_settings(cur_settings)
        try:
            db = get_db()
            db.execute(
                "INSERT INTO audit (id, at, action, details) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), f"{today_ist()} {now_ist()}", "USB_SCHEDULE_CHANGED", json.dumps(clean_sched))
            )
            db.commit()
        except Exception: pass

    return jsonify({"ok": True, "schedule": clean_sched})

@app.route("/api/export/csv")
@require_admin
def export_csv():
    try:
        typ = (request.args.get("type") or "attendance").lower()
        date = request.args.get("date")
        start = request.args.get("start")
        end = request.args.get("end")
        cls = request.args.get("class")
        sid = request.args.get("studentId")
        status = request.args.get("status")
        db = get_db()
        import csv, io
        output = io.StringIO()
        writer = csv.writer(output, quoting=csv.QUOTE_MINIMAL)
        if typ == "students":
            writer.writerow(["id","name","roll","class","batch","section","parent","phone","address","fingerId","photo","active","createdAt","attendance_rate"])
            rows = db.execute("SELECT * FROM students ORDER BY id").fetchall()
            # compute rates
            rates = {}
            for r in db.execute("SELECT studentId, status, COUNT(*) AS c FROM daily GROUP BY studentId, status"):
                rec = rates.setdefault(r["studentId"], {"ok":0,"all":0})
                if r["status"] in ("PRESENT","LATE","ABSENT"):
                    rec["all"]+=r["c"]
                    if r["status"] in ("PRESENT","LATE"): rec["ok"]+=r["c"]
            for r in rows:
                d=dict(r)
                rate = round(rates.get(d["id"], {"ok":0,"all":0})["ok"]/rates.get(d["id"], {"ok":0,"all":0})["all"]*100) if rates.get(d["id"], {"ok":0,"all":0})["all"] else 0
                writer.writerow([d["id"], d["name"], d["roll"], d["grade"], d.get("batch",""), d.get("section",""), d.get("parent",""), d.get("phone",""), d.get("address",""), d.get("fingerId",""), d.get("photo",""), d.get("active",1), d.get("createdAt",""), rate])
            csv_data = output.getvalue()
            headers = {"Content-Disposition": f"attachment; filename=students_{today_ist()}.csv"}
            return csv_data, 200, {**headers, "Content-Type":"text/csv; charset=utf-8"}
        else:
            # attendance
            writer.writerow(["date","time","studentId","name","roll","class","status","fingerId","result","source"])
            # build query
            where = []
            params = []
            # date filters
            if date:
                try: datetime.date.fromisoformat(date)
                except: return jsonify({"error":"bad date"}), 400
                where.append("e.date=?")
                params.append(date)
            if start:
                try: datetime.date.fromisoformat(start)
                except: return jsonify({"error":"bad start"}), 400
                where.append("e.date>=?")
                params.append(start)
            if end:
                try: datetime.date.fromisoformat(end)
                except: return jsonify({"error":"bad end"}), 400
                where.append("e.date<=?")
                params.append(end)
            if sid:
                where.append("e.studentId=?")
                params.append(int(sid))
            if status:
                where.append("e.status=?")
                params.append(status)
            # class filter needs join
            sql = "SELECT e.*, s.name as sname, s.roll as sroll, s.grade as sgrade, s.fingerId as sfid FROM events e LEFT JOIN students s ON e.studentId=s.id"
            if where:
                sql += " WHERE " + " AND ".join(where)
            if cls:
                # filter after join
                sql += (" AND " if where else " WHERE ") + " lower(s.grade)=lower(?)"
                params.append(cls)
            sql += " ORDER BY e.date DESC, e.time DESC LIMIT 5000"
            rows = db.execute(sql, params).fetchall()
            for r in rows:
                writer.writerow([r["date"], r["time"], r["studentId"] or "", r["sname"] or "", r["sroll"] or "", r["sgrade"] or "", r["status"] or "", r["fingerId"] or r["sfid"] or "", r["result"] or "", r["source"] or ""])
            csv_data = output.getvalue()
            headers = {"Content-Disposition": f"attachment; filename=attendance_{start or date or today_ist()}_{end or ''}.csv".replace("__","_")}
            return csv_data, 200, {**headers, "Content-Type":"text/csv; charset=utf-8"}
    except Exception as e:
        return jsonify({"error": f"FAIL {e}"}), 500

@app.route("/api/import/csv", methods=["POST"])
@require_admin
def import_csv():
    try:
        # accept file upload or json with csv text
        csv_text = ""
        if "file" in request.files:
            f = request.files["file"]
            csv_text = f.read().decode("utf-8", errors="ignore")
        else:
            try:
                j = request.get_json(force=True) or {}
                csv_text = j.get("csv") or j.get("data") or ""
                if not csv_text and request.data:
                    csv_text = request.data.decode("utf-8", errors="ignore")
            except:
                csv_text = request.data.decode("utf-8", errors="ignore") if request.data else ""
        if not csv_text or len(csv_text.strip()) < 5:
            return jsonify({"error":"no CSV data"}), 400
        import csv, io
        reader = csv.DictReader(io.StringIO(csv_text))
        # normalize headers
        field_map = {k.lower().strip(): k for k in reader.fieldnames or []}
        # expected: name, roll, class/grade, phone, address
        def get_field(row, *keys):
            for k in keys:
                lk = k.lower()
                if lk in field_map:
                    return (row.get(field_map[lk]) or "").strip()
                # also try exact
                for rk in row:
                    if rk and rk.lower().strip()==lk:
                        return (row[rk] or "").strip()
            return ""
        db = get_db()
        s = get_settings()
        added = 0
        skipped = 0
        errors = []
        with DB_LOCK:
            for idx, row in enumerate(reader, start=2):
                name = get_field(row, "name", "full name", "student name")
                roll = get_field(row, "roll", "roll number", "roll no", "roll_no")
                grade = get_field(row, "class", "grade", "className")
                batch = get_field(row, "batch", "group", "batch/group")
                section = get_field(row, "section")
                parent = get_field(row, "parent", "parent name", "guardian")
                phone = get_field(row, "phone", "parent phone", "parent_phone", "contact")
                address = get_field(row, "address", "addr")
                if not name or not roll:
                    errors.append(f"row {idx}: name and roll required")
                    skipped+=1
                    continue
                if len(roll)>20 or len(name)>80:
                    errors.append(f"row {idx}: name/roll too long")
                    skipped+=1
                    continue
                if not grade:
                    grade = s.get("classes", ["Grade 10-A"])[0]
                if len(grade)>40:
                    errors.append(f"row {idx}: grade too long")
                    skipped+=1
                    continue
                if len(batch)>40:
                    errors.append(f"row {idx}: batch too long")
                    skipped+=1
                    continue
                if len(section)>20:
                    errors.append(f"row {idx}: section too long")
                    skipped+=1
                    continue
                if len(parent)>80:
                    errors.append(f"row {idx}: parent too long")
                    skipped+=1
                    continue
                if len(address)>200:
                    address = address[:200]
                # phone validation soft
                if phone and len("".join(c for c in phone if c.isdigit())) < 8:
                    errors.append(f"row {idx}: phone too short")
                    # not fatal, allow
                # duplicate roll
                if db.execute("SELECT 1 FROM students WHERE active=1 AND lower(roll)=lower(?)", (roll,)).fetchone():
                    errors.append(f"row {idx}: roll {roll} exists")
                    skipped+=1
                    continue
                if grade.lower() not in [c.lower() for c in s.get("classes",[])]:
                    s["classes"] = s.get("classes",[])+[grade]
                    save_settings(s)
                if batch and batch.lower() not in [b.lower() for b in s.get("batches",[])]:
                    s["batches"] = s.get("batches",[])+[batch]
                    save_settings(s)
                try:
                    db.execute(
                        "INSERT INTO students (name, roll, grade, batch, section, parent, phone, address, fingerId, photo, active, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (name, roll, grade, batch, section, parent, phone, address, None, "", 1, today_ist()),
                    )
                    db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "STUDENT_IMPORTED_CSV", f"{name} {roll}"))
                    added+=1
                except sqlite3.Error as e:
                    errors.append(f"row {idx}: DB {e}")
                    skipped+=1
            db.commit()
        return jsonify({"added": added, "skipped": skipped, "errors": errors[:20]})
    except Exception as e:
        return jsonify({"error": f"FAIL {e}"}), 500

@app.route("/api/correction", methods=["POST"])
@require_admin
def correction():
    """Attendance correction with audit trail. Requires date, studentId, status, reason. Preserves original."""
    try:
        j = request.get_json(force=True) or {}
    except Exception:
        return jsonify({"error":"invalid JSON"}), 400
    date = (j.get("date") or "").strip()
    sid = j.get("studentId") or j.get("id")
    new_status = (j.get("status") or "").strip().upper()
    reason = (j.get("reason") or "").strip()
    if not date or not sid or not new_status or not reason:
        return jsonify({"error":"date, studentId, status, reason required"}), 400
    if new_status not in ("PRESENT","LATE","ABSENT","NOT_SCHEDULED"):
        return jsonify({"error":"invalid status"}), 400
    if len(reason) < 3 or len(reason) > 300:
        return jsonify({"error":"reason must be 3-300 chars"}), 400
    try:
        datetime.date.fromisoformat(date)
    except Exception:
        return jsonify({"error":"bad date"}), 400
    try:
        db = get_db()
        stu = db.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
        if not stu:
            return jsonify({"error":"student not found"}), 404
        key = f"{date}|{sid}"
        with DB_LOCK:
            row = db.execute("SELECT status FROM daily WHERE key=?", (key,)).fetchone()
            old_status = row["status"] if row and row["status"] else None
            # ensure daily exists
            ensure_daily(date, sid, db)
            # update daily
            db.execute("UPDATE daily SET status=?, lastScan=? WHERE key=?", (new_status, datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).strftime("%H:%M:%S"), key))
            eid = str(uuid.uuid4())
            db.execute("INSERT INTO events(id, date, time, studentId, fingerId, result, status, source) VALUES (?,?,?,?,?,?,?,?)", (eid, date, datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).strftime("%H:%M:%S"), sid, stu["fingerId"], "CORRECTED", new_status, "CORRECTION"))
            db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "ATTENDANCE_CORRECTED", f"sid {sid} {date} {old_status}->{new_status} reason:{reason}"))
            db.commit()
        return jsonify({"ok": True, "oldStatus": old_status, "newStatus": new_status, "date": date, "studentId": sid})
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

def enroll_hint(msg):
    m = str(msg)
    if "TIMEOUT_WAIT_REMOVED" in m:
        return "Lift your finger completely off the glass, then wait for the next prompt. " + m
    if "TIMEOUT_WAIT_FINGER" in m or "NO_FINGER" in m:
        return "Press the same finger flat on the glass and hold still until the capture finishes. " + m
    if "CAPTURE" in m:
        return "Hold still — the sensor did not get a clear image. " + m
    if "UART" in m or m == "TIMEOUT":
        return "The sensor did not answer on serial. Check the GT-511C3 cable. " + m
    return m

@app.route("/api/enroll/progress")
@app.route("/api/sensor/progress")
def enroll_progress():
    return jsonify(sensor_progress_view())

@app.route("/api/sensor/audit", methods=["GET"])
@require_admin
def sensor_audit():
    """Read-only diagnostics: compares SQLite fingerId set vs sensor enroll count.
    Does not delete or enroll. Holds SENSOR_LOCK briefly. On sim or hardware_unusable returns 200 with sim flag.
    Returns {db_count, sensor_count, db_ids, sensor_ids (empty — not enumerated, driver has no proven ID enumeration), orphans_estimate, missing_estimate, note} — count-based only, not ID-level reconciliation."""
    try:
        db = get_db()
        db_ids = [r[0] for r in db.execute("SELECT fingerId FROM students WHERE active=1 AND fingerId IS NOT NULL ORDER BY fingerId").fetchall()]
        db_count = len(db_ids)
    except Exception as e:
        return jsonify({"error": f"DB_FAIL {e}"}), 500
    if not SENSOR_LOCK.acquire(timeout=5):
        return jsonify({"error": "sensor busy"}), 503
    try:
        sensor = get_sensor()
        if sensor.sim or hardware_unusable(sensor):
            try: sensor.close()
            except: pass
            return jsonify({
                "sim": True,
                "db_count": db_count,
                "db_ids": db_ids,
                "sensor_count": None,
                "sensor_ids": [],
                "orphans_estimate": None,
                "missing_estimate": None,
                "note": "sim mode or hardware offline — sensor not probed"
            })
        # real hardware: get enroll count
        try:
            ok, val = sensor._cmd(0x20, 0, timeout=1.0)  # CMD_GET_ENROLL_COUNT
            sensor_count = int(val) if ok else None
        except Exception as e:
            sensor_count = None
        try: sensor.close()
        except: pass
        orphans_estimate = None
        missing_estimate = None
        if sensor_count is not None:
            orphans_estimate = max(0, sensor_count - db_count)
            missing_estimate = max(0, db_count - sensor_count)
        return jsonify({
            "sim": False,
            "db_count": db_count,
            "db_ids": db_ids,
            "sensor_count": sensor_count,
            "sensor_ids": [],
            "orphans_estimate": orphans_estimate,
            "missing_estimate": missing_estimate,
            "note": "sensor_ids not enumerated (non-destructive); use led_test.py or manual verify if needed — count-based only, not ID-level; after sensor replacement db>sensor indicates missing templates requiring re-enrollment"
        })
    finally:
        try: SENSOR_LOCK.release()
        except: pass

# --- Enroll (REAL) ---
@app.route("/api/enroll", methods=["POST"])
@require_admin
def enroll():
    try:
        j = request.get_json(force=True)
    except:
        return jsonify({"error":"invalid JSON"}), 400
    name = (j.get("name") or "").strip()
    roll = (j.get("roll") or "").strip()
    grade = (j.get("grade") or j.get("class") or "").strip()
    batch = (j.get("batch") or j.get("group") or "").strip()
    section = (j.get("section") or "").strip()
    parent = (j.get("parent") or j.get("parent_name") or "").strip()
    phone = (j.get("phone") or "").strip()
    address = (j.get("address") or "").strip()
    ok_photo, photo = _photo_ok(j.get("photo") or "")
    if not ok_photo:
        return jsonify({"error": photo}), 400
    if not name or not roll:
        return jsonify({"error":"name and roll required"}), 400
    if len(roll) > 20 or len(name) > 80:
        return jsonify({"error":"name/roll too long"}), 400
    if not grade:
        return jsonify({"error":"grade required"}), 400
    if len(batch) > 40:
        return jsonify({"error":"batch too long"}), 400
    if len(section) > 20:
        return jsonify({"error":"section too long"}), 400
    if len(parent) > 80:
        return jsonify({"error":"parent too long"}), 400
    if len(address) > 200:
        return jsonify({"error":"address too long"}), 400
    digits = "".join(c for c in phone if c.isdigit())
    if phone and len(digits) < 8:
        return jsonify({"error":"phone too short"}), 400
    # clock check
    ok_clk, clk_msg = validate_clock()
    if not ok_clk:
        return jsonify({"error":clk_msg}), 500
    db = get_db()
    try:
        if db.execute("SELECT 1 FROM students WHERE active=1 AND lower(roll)=lower(?)", (roll,)).fetchone():
            return jsonify({"error":"roll exists"}), 409
        if grade and len(grade)>40:
            return jsonify({"error":"grade too long"}), 400
        fid = next_finger_id(db)
        if fid is None:
            return jsonify({"error":"fingerprint DB full (200 slots)"}), 507
        nid = None
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

    # --- REAL SENSOR ENROLL with ID sync (sensor + DB atomic) ---
    # Strategy: DB next_finger_id is first guess, but sensor may have orphan templates
    # (e.g., delete skipped when hardware_unusable). GT-511C3 enroll_start returns
    # IS_ALREADY_USED if ID occupied on sensor. We retry with next DB-free ID on that
    # specific error (bounded), and only report success after BOTH sensor and DB succeed.
    # If DB fails after sensor success, we delete the sensor template to avoid orphan.
    if not SENSOR_LOCK.acquire(timeout=5):
        return jsonify({"error":"sensor busy — wait for the current scan to finish"}), 503
    set_sensor_progress(mode="enroll", step=1, steps_total=3, state="place", title="Place your finger",
                        detail="Sensor light is on. Put your finger on the glass.", timeout_sec=40, finger=False)
    ok, msg = False, "NOT_STARTED"
    attempted_fids = []
    fid_candidate = fid
    try:
        for attempt in range(10):
            fid_candidate = fid_candidate if attempt == 0 else None
            if fid_candidate is None:
                # find next DB-free fid not yet attempted
                used = {r[0] for r in db.execute("SELECT fingerId FROM students WHERE active=1 AND fingerId IS NOT NULL")}
                used.update(attempted_fids)
                for i in range(1, 200):
                    if i not in used:
                        fid_candidate = i
                        break
                if fid_candidate is None:
                    ok, msg = False, "DB_IS_FULL"
                    break
            attempted_fids.append(fid_candidate)
            sensor = get_sensor()
            if hardware_unusable(sensor):
                try: sensor.close()
                except: pass
                ok, msg = False, f"sensor offline — hardware not ready {getattr(sensor, 'last_error','')}"
                break
            try:
                ok, msg = sensor.enroll(int(fid_candidate), log=set_sensor_progress)
                app.logger.info("sensor enroll fid=%s ok=%s result=%s (attempt %s)", fid_candidate, ok, msg, attempt+1)
            except Exception as e:
                ok, msg = False, f"EXC {e}"
                app.logger.exception("sensor enroll exception fid=%s", fid_candidate)
            finally:
                try: sensor.close()
                except: pass
            if ok:
                fid = fid_candidate
                break
            # retry only on already-used
            if "IS_ALREADY_USED" in str(msg) or "IS_ALREADY_USED" in str(msg):
                # try next fid in next loop
                fid_candidate = None
                continue
            else:
                break
    finally:
        SENSOR_LOCK.release()
    if not ok:
        hint = enroll_hint(msg)
        set_sensor_progress(state="fail", title="Try again", detail=hint, raw=str(msg), timeout_sec=0, deadline=0)
        comms = "UART" in str(msg) or str(msg) in ("TIMEOUT", "BAD_CHECKSUM", "SHORT")
        if comms:
            return jsonify({"error": f"enroll failed: {msg}", "sensor": "offline", "hint": hint, "raw": str(msg)}), 500
        return jsonify({"error": f"sensor enroll failed: {msg}", "hint": hint, "raw": str(msg)}), 500

    # Auto-add class if new
    try:
        s = get_settings()
        if grade and grade.lower() not in [c.lower() for c in s.get("classes",[])]:
            s["classes"] = s.get("classes",[])+[grade]
            save_settings(s)
        if batch and batch.lower() not in [b.lower() for b in s.get("batches",[])]:
            s["batches"] = s.get("batches",[])+[batch]
            save_settings(s)
        with DB_LOCK:
            cur = db.execute(
                "INSERT INTO students (name, roll, grade, batch, section, parent, phone, address, fingerId, photo, active, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (name, roll, grade, batch, section, parent, phone, address, fid, photo, 1, today_ist()),
            )
            nid = int(cur.lastrowid)
            db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "STUDENT_ENROLLED", f"{name} -> {grade} #{fid}"))
            db.commit()
    except sqlite3.Error as e:
        # Rollback fingerprint if DB fail → try delete from sensor
        try:
            sens2 = get_sensor()
            sens2.delete_id(int(fid))
            sens2.close()
        except: pass
        return jsonify({"error":f"DB_FAIL {e}"}), 500
    set_sensor_progress(mode="enroll", step=3, steps_total=3, state="success", title="Fingerprint enrolled",
                        detail="Saved on the sensor and in SQLite.", timeout_sec=0, deadline=0)
    return jsonify({"id": nid, "fingerId": fid, "grade": grade})

def _record_not_scheduled(db, date, t, stu, reason):
    """Write NOT_SCHEDULED daily+event with a real lastrowid seq. Never fabricates MAX(rowid)+1.
    Does not overwrite PRESENT/LATE daily status."""
    with DB_LOCK:
        student_id = stu["id"]
        ensure_daily(date, student_id, db)
        row = db.execute("SELECT status, firstScan FROM daily WHERE key=?", (f"{date}|{student_id}",)).fetchone()
        cur = row["status"] if row and row["status"] else None
        if cur in ("PRESENT", "LATE"):
            last = db.execute(
                "SELECT rowid FROM events WHERE date=? AND studentId=? ORDER BY rowid DESC LIMIT 1",
                (date, student_id),
            ).fetchone()
            if last:
                return {
                    "ok": False, "reason": reason, "status": "NOT_SCHEDULED",
                    "date": date, "time": t, "student": dict(stu), "seq": int(last[0]),
                }
        else:
            first = t
            if row and row["firstScan"] and cur == "NOT_SCHEDULED":
                first = row["firstScan"]
            db.execute(
                "UPDATE daily SET status='NOT_SCHEDULED', firstScan=?, lastScan=? WHERE key=?",
                (first, t, f"{date}|{student_id}"),
            )
        existing = db.execute(
            "SELECT rowid FROM events WHERE date=? AND studentId=? AND status='NOT_SCHEDULED' ORDER BY rowid DESC LIMIT 1",
            (date, student_id),
        ).fetchone()
        if existing:
            db.commit()
            return {
                "ok": False, "reason": reason, "status": "NOT_SCHEDULED",
                "date": date, "time": t, "student": dict(stu), "seq": int(existing[0]),
            }
        ins = db.execute(
            "INSERT INTO events(id, date, time, studentId, fingerId, result, status, source) VALUES (?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), date, t, student_id, stu["fingerId"], "NOT_SCHEDULED", "NOT_SCHEDULED", "GT511C3"),
        )
        action = "NON_WORKING_DAY_SCAN" if reason == "NON_WORKING_DAY" else "NOT_SCHEDULED_SCAN"
        db.execute(
            "INSERT INTO audit VALUES (?,?,?,?)",
            (str(uuid.uuid4()), now_ist(), action, f"{stu['name']} {t} {reason} {stu['grade']}/{stu['batch'] or ''}"),
        )
        db.commit()
        return {
            "ok": False, "reason": reason, "status": "NOT_SCHEDULED",
            "date": date, "time": t, "student": dict(stu), "seq": int(ins.lastrowid),
        }

# --- Scan (REAL) ---
@app.route("/api/scan", methods=["POST"])
def scan():
    try:
        j = request.get_json(force=True) or {}
    except:
        j = {}
    # clock validation
    ok_clk, clk_msg = validate_clock()
    if not ok_clk:
        return jsonify({"ok":False, "reason":"INVALID_CLOCK", "detail":clk_msg}), 500
    # Real hardware: omit studentId → identify. Tests/sim may send studentId.
    client_student_id = j.get("studentId")
    is_unknown = bool(j.get("isUnknown"))
    # Security: in real hardware mode, client-supplied studentId must never create attendance
    if cfg.get("sensor") == "real" and client_student_id is not None:
        return jsonify({"ok": False, "reason": "FINGERPRINT_REQUIRED", "detail": "real mode requires fingerprint identification"}), 403
    student_id = client_student_id
    # If no studentId and not explicit unknown, try real identify
    sensor_fid = None
    sensor_err = None
    if not is_unknown and not student_id:
        try:
            wait_sec = max(1, min(30, int(j.get("waitSec", 2))))
        except (TypeError, ValueError):
            wait_sec = 2
        # REAL path: student puts finger → Pi reads → identifies
        if not SENSOR_LOCK.acquire(timeout=5):
            return jsonify({"ok": False, "reason": "SENSOR_BUSY", "detail": "enroll in progress"}), 503
        sensor = get_sensor()
        if hardware_unusable(sensor):
            sensor.close()
            SENSOR_LOCK.release()
            return jsonify({"ok": False, "reason": "SENSOR_DISCONNECT", "detail": getattr(sensor, "last_error", "hardware not ready")}), 503
        try:
            # If sim mode and no hardware, identify returns None,UNKNOWN — but we treat as need studentId
            fid, msg = sensor.identify(log=set_sensor_progress, timeout=wait_sec)
            app.logger.info("sensor identify ok=%s fid=%s result=%s", fid is not None, fid, msg)
            if fid is not None:
                sensor_fid = int(fid)
            else:
                # msg contains UNKNOWN or NO_FINGER or UART_ERR
                sensor_err = msg
                msg_text = str(msg)
                if any(token in msg_text for token in ("UART", "COMM_ERR", "BAD_CHECKSUM", "SHORT", "INIT_FAIL")):
                    return jsonify({"ok":False, "reason":"SENSOR_DISCONNECT", "detail":msg_text, "sensor":"offline"}), 503
                if "NO_FINGER" in msg_text or msg_text == "TIMEOUT" or "TIMEOUT_WAIT" in msg_text:
                    return jsonify({"ok":False, "reason":"NO_FINGER", "detail":msg, "sensor": "offline" if "UART" in str(msg) else "ok"}), 400
                if "UNKNOWN" in msg_text:
                    # fall through to unknown handling
                    is_unknown = True
                elif sensor.sim:
                    return jsonify({"ok":False, "reason":"NEED_STUDENT_ID", "detail":"sim mode: send studentId"}), 400
                else:
                    is_unknown = True
        except Exception as e:
            sensor_err = str(e)
            return jsonify({"ok":False, "reason":"SENSOR_DISCONNECT", "detail":sensor_err}), 503
        finally:
            try:
                sensor.close()
            except Exception:
                pass
            SENSOR_LOCK.release()
        # Map fingerId to student
        if sensor_fid is not None:
            db = get_db()
            row = db.execute("SELECT * FROM students WHERE fingerId=? AND active=1", (sensor_fid,)).fetchone()
            if row:
                student_id = row["id"]
            else:
                # Finger exists in sensor but no student (orphan) → unknown
                is_unknown = True

    tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    now = datetime.datetime.now(tz)
    date = now.date().isoformat()
    t = now.strftime("%H:%M:%S")
    # Bad date edge: if date parse fails, already handled; also check future?
    if date > (now.date() + datetime.timedelta(days=1)).isoformat():
        return jsonify({"ok":False, "reason":"BAD_DATE", "date":date}), 400

    s = get_settings()
    try:
        db = get_db()
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

    if is_unknown or not student_id:
        try:
            with DB_LOCK:
                eid = str(uuid.uuid4())
                cur = db.execute("INSERT INTO events(id, date, time, studentId, fingerId, result, status, source) VALUES (?,?,?,?,?,?,?,?)", (eid, date, t, None, sensor_fid, "UNKNOWN", "UNKNOWN", "GT511C3"))
                db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "UNKNOWN_FINGERPRINT", f"{t} fid={sensor_fid} {sensor_err or ''}"))
                db.commit()
        except sqlite3.Error as e:
            return jsonify({"error":f"DB_FAIL {e}"}), 500
        return jsonify({"ok": False, "reason": "UNKNOWN", "date": date, "time": t, "fingerId": sensor_fid, "seq": int(cur.lastrowid)})

    # Validate student exists
    try:
        stu = db.execute("SELECT * FROM students WHERE id=? AND active=1", (student_id,)).fetchone()
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500
    if not stu:
        # Could be deleted student → treat as unknown, not attendance
        try:
            with DB_LOCK:
                eid = str(uuid.uuid4())
                db.execute("INSERT INTO events(id, date, time, studentId, fingerId, result, status, source) VALUES (?,?,?,?,?,?,?,?)", (eid, date, t, None, None, "UNKNOWN", "UNKNOWN", "GT511C3"))
                db.commit()
        except: pass
        return jsonify({"ok": False, "reason": "UNKNOWN"}), 404

    # canonical eligibility: per-student schedule with global fallback
    stu_dict = dict(stu)
    if not is_student_scheduled(date, stu_dict, s):
        reason = "NON_WORKING_DAY" if not is_working_day(date, s) else "NOT_SCHEDULED"
        return jsonify(_record_not_scheduled(db, date, t, stu, reason))

    # Duplicate scan edge
    try:
        with DB_LOCK:
            row = db.execute("SELECT status FROM daily WHERE key=?", (f"{date}|{student_id}",)).fetchone()
            status = row["status"] if row and row["status"] else None
            # NOT_SCHEDULED/ABSENT may be overwritten by a later valid scan if schedule changes; PRESENT/LATE/NOT_SCHEDULED stay first-scan otherwise
            if status and status not in ("ABSENT", "NOT_SCHEDULED"):
                eid = str(uuid.uuid4())
                cur = db.execute("INSERT INTO events(id, date, time, studentId, fingerId, result, status, source) VALUES (?,?,?,?,?,?,?,?)", (eid, date, t, student_id, stu["fingerId"], "MATCH", "DUPLICATE", "GT511C3"))
                db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "DUPLICATE_SCAN", f"{stu['name']} {t} already {status}"))
                db.commit()
                return jsonify({"ok": False, "reason": "DUPLICATE", "status": "DUPLICATE", "student": dict(stu), "date": date, "time": t, "seq": int(cur.lastrowid)})
            # Ensure daily row exists
            ensure_daily(date, student_id, db)
            st = classify(t, s)
            key = f"{date}|{student_id}"
            cur = db.execute("SELECT firstScan FROM daily WHERE key=?", (key,)).fetchone()
            first = cur["firstScan"] if cur and cur["firstScan"] else t
            db.execute("UPDATE daily SET status=?, firstScan=?, lastScan=? WHERE key=?", (st, first, t, key))
            eid = str(uuid.uuid4())
            event_cur = db.execute("INSERT INTO events(id, date, time, studentId, fingerId, result, status, source) VALUES (?,?,?,?,?,?,?,?)", (eid, date, t, student_id, stu["fingerId"], "MATCH", st, "GT511C3"))
            db.execute("INSERT INTO notifications VALUES (?,?,?,?,?,?)", (str(uuid.uuid4()), student_id, now_ist(), "PENDING", f"Attendance {st} at {t}", 0))
            db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "ATTENDANCE_RECORDED", f"{stu['name']} -> {st} {t}"))
            db.commit()
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500
    return jsonify({"ok": True, "student": dict(stu), "date": date, "time": t, "status": st, "seq": int(event_cur.lastrowid)})

@app.route("/api/scan/last")
def scan_last():
    """Latest real-scan event for the UI bridge poller (RECONCILE/CORRECTION excluded)."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT rowid AS seq, * FROM events WHERE source = 'GT511C3' "
            "ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        if not row:
            return jsonify({"seq": 0})
        ev = dict(row)
        stu = None
        if ev.get("studentId"):
            srow = db.execute("SELECT * FROM students WHERE id=?", (ev["studentId"],)).fetchone()
            if srow:
                stu = dict(srow)
        return jsonify({"seq": ev["seq"], "result": ev.get("result"), "status": ev.get("status"),
                        "date": ev.get("date"), "time": ev.get("time"),
                        "fingerId": ev.get("fingerId"), "student": stu})
    except sqlite3.Error as e:
        return jsonify({"error": f"DB_FAIL {e}"}), 500

def run_reconciliation(date=None, s=None, db=None):
    """Authoritative reconciliation logic.
    For the given date (default today_ist()), checks student schedules against daily records.
    Marks scheduled missing students as ABSENT (time: 23:59:59, source: RECONCILE).
    Marks unscheduled students as NOT_SCHEDULED (source: RECONCILE).
    Guards today's execution with BEFORE_CUTOFF if current IST time < lateCutoff.
    Executes under DB_LOCK and records an ABSENCE_RECONCILIATION audit entry if mutations occur.
    """
    if db is None and not has_app_context():
        with app.app_context():
            return run_reconciliation(date=date, s=s, db=get_db())

    date = date or today_ist()
    try:
        datetime.date.fromisoformat(date)
    except Exception:
        return {"error": "bad date", "ok": False}
    if s is None:
        s = get_settings()
    if date == today_ist():
        tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
        now_t = datetime.datetime.now(tz).strftime("%H:%M:%S")
        late = s.get("lateCutoff", "08:30")
        if len(late) == 5:
            late += ":00"
        if now_t < late:
            return {
                "working": True,
                "marked": 0,
                "notScheduled": 0,
                "reason": "BEFORE_CUTOFF",
                "cutoff": late,
                "now": now_t,
            }
    if db is None:
        db = get_db()
    with DB_LOCK:
        rows = db.execute("SELECT * FROM students WHERE active=1").fetchall()
        daily_map = {
            r["studentId"]: r["status"]
            for r in db.execute("SELECT studentId, status FROM daily WHERE date=?", (date,)).fetchall()
        }
        ns_existing = {
            r[0]
            for r in db.execute(
                "SELECT studentId FROM events WHERE date=? AND status='NOT_SCHEDULED'",
                (date,),
            ).fetchall()
        }
        marked = 0
        not_scheduled = 0
        for r in rows:
            stu = dict(r)
            key = f"{date}|{r['id']}"
            cur = daily_map.get(r["id"])
            scheduled = is_student_scheduled(date, stu, s)
            if not scheduled:
                # never mark absent when not scheduled
                if not cur or cur in ("ABSENT", None):
                    ensure_daily(date, r["id"], db)
                    if r["id"] not in ns_existing:
                        db.execute(
                            "UPDATE daily SET status='NOT_SCHEDULED', firstScan='--', lastScan='--' WHERE key=?",
                            (key,),
                        )
                        db.execute(
                            "INSERT INTO events(id, date, time, studentId, fingerId, result, status, source) VALUES (?,?,?,?,?,?,?,?)",
                            (str(uuid.uuid4()), date, "00:00:00", r["id"], None, "NOT_SCHEDULED", "NOT_SCHEDULED", "RECONCILE"),
                        )
                        ns_existing.add(r["id"])
                    else:
                        db.execute("UPDATE daily SET status='NOT_SCHEDULED' WHERE key=?", (key,))
                    not_scheduled += 1
                continue
            if not cur:
                ensure_daily(date, r["id"], db)
                db.execute("UPDATE daily SET status='ABSENT' WHERE key=?", (key,))
                db.execute(
                    "INSERT INTO events(id, date, time, studentId, fingerId, result, status, source) VALUES (?,?,?,?,?,?,?,?)",
                    (str(uuid.uuid4()), date, "23:59:59", r["id"], None, "ABSENT", "ABSENT", "RECONCILE"),
                )
                db.execute(
                    "INSERT INTO notifications VALUES (?,?,?,?,?,?)",
                    (str(uuid.uuid4()), r["id"], now_ist(), "PENDING", f"Absent {date}", 0),
                )
                marked += 1
        if marked or not_scheduled:
            db.execute(
                "INSERT INTO audit VALUES (?,?,?,?)",
                (str(uuid.uuid4()), now_ist(), "ABSENCE_RECONCILIATION", f"{marked} absent {not_scheduled} not_scheduled {date}"),
            )
        db.commit()
    any_scheduled = any(is_student_scheduled(date, dict(r), s) for r in rows) if rows else is_working_day(date, s)
    return {
        "working": bool(any_scheduled),
        "marked": marked,
        "notScheduled": not_scheduled,
        "date": date,
    }

_reconcile_stop_event = threading.Event()
_reconcile_thread = None

def _reconcile_tick(date=None, s=None, db=None) -> dict:
    """Evaluate and run reconciliation if due for date (defaults to today_ist()).
    Checks durable SQLite state (active students without daily record for date).
    """
    if db is None and not has_app_context():
        with app.app_context():
            return _reconcile_tick(date=date, s=s, db=get_db())

    try:
        today = date or today_ist()
        if s is None:
            s = get_settings()
        if today == today_ist():
            tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
            now_t = datetime.datetime.now(tz).strftime("%H:%M:%S")
            late = s.get("lateCutoff", "08:30")
            if len(late) == 5:
                late += ":00"
            if now_t < late:
                return {"status": "SKIPPED_BEFORE_CUTOFF", "cutoff": late, "now": now_t, "date": today}
        if db is None:
            db = get_db()
        with DB_LOCK:
            unresolved = db.execute(
                "SELECT COUNT(*) FROM students WHERE active=1 AND id NOT IN (SELECT studentId FROM daily WHERE date=?)",
                (today,)
            ).fetchone()[0]
        if unresolved == 0:
            return {"status": "NOT_NEEDED", "unresolved": 0, "date": today}
        res = run_reconciliation(date=today, s=s, db=db)
        print(f"[RECONCILE] Auto-reconciled {today}: {res.get('marked', 0)} absent, {res.get('notScheduled', 0)} not scheduled")
        return {"status": "RECONCILED", "result": res, "date": today}
    except Exception as e:
        print(f"[RECONCILE ERROR] {e}")
        return {"status": "ERROR", "error": str(e), "date": date or today_ist()}

def _reconcile_daemon():
    """Background daemon loop running approximately once per minute."""
    while not _reconcile_stop_event.is_set():
        try:
            with app.app_context():
                _reconcile_tick()
        except Exception as e:
            print(f"[RECONCILE DAEMON EXCEPTION] {e}")
        _reconcile_stop_event.wait(60)

def start_reconcile_daemon():
    global _reconcile_thread
    if _reconcile_thread is None or not _reconcile_thread.is_alive():
        _reconcile_stop_event.clear()
        _reconcile_thread = threading.Thread(target=_reconcile_daemon, daemon=True, name="ReconcileWorker")
        _reconcile_thread.start()
        print("[ATL] Background attendance reconciliation worker active (interval: 60s)")

def stop_reconcile_daemon(timeout=5):
    global _reconcile_thread
    _reconcile_stop_event.set()
    if _reconcile_thread is not None and _reconcile_thread.is_alive():
        _reconcile_thread.join(timeout=timeout)

# Start background reconciliation daemon
start_reconcile_daemon()

def _gdrive_backup_daemon():
    """Background daemon loop checking if Google Drive or Telegram backups should run based on configured schedules."""
    while not _gdrive_stop_event.is_set():
        today = today_ist()
        now_t = now_ist()[:5]

        # --- 1. Google Drive Scheduled Backup Evaluation ---
        try:
            gc = _gdrive_config()
            if gc["enabled"] and gc["client_id"] and gc["client_secret"]:
                g_sched = _get_gdrive_schedule()
                if g_sched.get("enabled", True):
                    sched_t = g_sched.get("time", "18:30")
                    already_done = bool(_GDRIVE_STATE["last_backup_time"] and _GDRIVE_STATE["last_backup_time"].startswith(today) and _GDRIVE_STATE["last_status"] == "SUCCESS")

                    if not already_done and now_t >= sched_t and not _GDRIVE_STATE["in_progress"]:
                        should_run = False
                        freq = g_sched.get("frequency", "daily")

                        if freq == "daily":
                            should_run = True
                        elif freq == "weekdays":
                            tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                            today_d = datetime.datetime.now(tz).date()
                            cur_wday = (today_d.weekday() + 1) % 7
                            if cur_wday in g_sched.get("weekdays", []):
                                should_run = True
                        elif freq == "interval":
                            interval_n = g_sched.get("intervalDays", 1)
                            tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                            today_d = datetime.datetime.now(tz).date()
                            last_date_str = None
                            if _GDRIVE_STATE.get("last_backup_time"):
                                last_date_str = _GDRIVE_STATE["last_backup_time"][:10]
                            else:
                                try:
                                    with app.app_context():
                                        db = get_db()
                                        with DB_LOCK:
                                            row = db.execute("SELECT at FROM audit WHERE action='GDRIVE_BACKUP' ORDER BY at DESC LIMIT 1").fetchone()
                                            if row and row[0]:
                                                last_date_str = row[0][:10]
                                except Exception:
                                    pass

                            if last_date_str:
                                try:
                                    last_d = datetime.date.fromisoformat(last_date_str)
                                    days_elapsed = (today_d - last_d).days
                                    if days_elapsed >= interval_n:
                                        should_run = True
                                except Exception:
                                    should_run = True
                            else:
                                should_run = True

                        if should_run:
                            with app.app_context():
                                print(f"[GDRIVE] Starting scheduled backup for {today} (freq: {freq})...")
                                res = run_gdrive_backup(trigger="SCHEDULED")
                                if res.get("ok"):
                                    print(f"[GDRIVE] Backup completed successfully: {res.get('name')}")
                                else:
                                    print(f"[GDRIVE ERROR] Backup failed: {res.get('error')}")
        except Exception as e:
            print(f"[GDRIVE DAEMON EXCEPTION] {e}")

        # --- 2. Telegram Secondary Scheduled Backup Evaluation ---
        try:
            tc = _telegram_config()
            if tc["enabled"] and tc["bot_token"] and tc["chat_id"]:
                t_sched = _get_telegram_schedule()
                if t_sched.get("enabled", True):
                    t_sched_t = t_sched.get("time", "18:30")
                    tg_already_done = bool(_TELEGRAM_STATE["last_backup_time"] and _TELEGRAM_STATE["last_backup_time"].startswith(today) and _TELEGRAM_STATE["last_status"] == "SUCCESS")

                    if not tg_already_done and now_t >= t_sched_t and not _TELEGRAM_STATE["in_progress"]:
                        tg_should_run = False
                        tg_freq = t_sched.get("frequency", "daily")

                        if tg_freq == "daily":
                            tg_should_run = True
                        elif tg_freq == "weekdays":
                            tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                            today_d = datetime.datetime.now(tz).date()
                            cur_wday = (today_d.weekday() + 1) % 7
                            if cur_wday in t_sched.get("weekdays", []):
                                tg_should_run = True
                        elif tg_freq == "interval":
                            interval_n = t_sched.get("intervalDays", 1)
                            tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                            today_d = datetime.datetime.now(tz).date()
                            tg_last_date_str = None
                            if _TELEGRAM_STATE.get("last_backup_time"):
                                tg_last_date_str = _TELEGRAM_STATE["last_backup_time"][:10]
                            else:
                                try:
                                    with app.app_context():
                                        db = get_db()
                                        with DB_LOCK:
                                            row = db.execute("SELECT at FROM audit WHERE action='TELEGRAM_BACKUP' ORDER BY at DESC LIMIT 1").fetchone()
                                            if row and row[0]:
                                                tg_last_date_str = row[0][:10]
                                except Exception:
                                    pass

                            if tg_last_date_str:
                                try:
                                    last_d = datetime.date.fromisoformat(tg_last_date_str)
                                    days_elapsed = (today_d - last_d).days
                                    if days_elapsed >= interval_n:
                                        tg_should_run = True
                                except Exception:
                                    tg_should_run = True
                            else:
                                tg_should_run = True

                        if tg_should_run:
                            with app.app_context():
                                print(f"[TELEGRAM] Starting scheduled backup for {today} (freq: {tg_freq})...")
                                res = run_telegram_backup(trigger="SCHEDULED")
                                if res.get("ok"):
                                    print(f"[TELEGRAM] Backup completed successfully: {res.get('name')}")
                                else:
                                    print(f"[TELEGRAM ERROR] Backup failed: {res.get('error')}")
        except Exception as e:
            print(f"[TELEGRAM DAEMON EXCEPTION] {e}")

        # --- 3. USB Storage Scheduled Backup Evaluation ---
        try:
            u_sched = _get_usb_schedule()
            if u_sched.get("enabled", True):
                u_sched_t = u_sched.get("time", "18:30")
                usb_already_done = bool(_USB_STATE["last_backup_time"] and _USB_STATE["last_backup_time"].startswith(today) and _USB_STATE["last_status"] == "SUCCESS")

                if not usb_already_done and now_t >= u_sched_t and not _USB_STATE["in_progress"]:
                    usb_should_run = False
                    usb_freq = u_sched.get("frequency", "daily")

                    if usb_freq == "daily":
                        usb_should_run = True
                    elif usb_freq == "weekdays":
                        tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                        today_d = datetime.datetime.now(tz).date()
                        cur_wday = (today_d.weekday() + 1) % 7
                        if cur_wday in u_sched.get("weekdays", []):
                            usb_should_run = True
                    elif usb_freq == "interval":
                        interval_n = u_sched.get("intervalDays", 1)
                        tz = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                        today_d = datetime.datetime.now(tz).date()
                        usb_last_date_str = None
                        if _USB_STATE.get("last_backup_time"):
                            usb_last_date_str = _USB_STATE["last_backup_time"][:10]
                        else:
                            try:
                                with app.app_context():
                                    db = get_db()
                                    with DB_LOCK:
                                        row = db.execute("SELECT at FROM audit WHERE action='USB_BACKUP' ORDER BY at DESC LIMIT 1").fetchone()
                                        if row and row[0]:
                                            usb_last_date_str = row[0][:10]
                            except Exception:
                                pass

                        if usb_last_date_str:
                            try:
                                last_d = datetime.date.fromisoformat(usb_last_date_str)
                                days_elapsed = (today_d - last_d).days
                                if days_elapsed >= interval_n:
                                    usb_should_run = True
                            except Exception:
                                usb_should_run = True
                        else:
                            usb_should_run = True

                    if usb_should_run:
                        with app.app_context():
                            print(f"[USB] Starting scheduled backup for {today} (freq: {usb_freq})...")
                            res = run_usb_backup(trigger="SCHEDULED")
                            if res.get("ok"):
                                print(f"[USB] Backup completed successfully: {res.get('name')}")
                            else:
                                print(f"[USB] Backup skipped or failed: {res.get('error')}")
        except Exception as e:
            print(f"[USB DAEMON EXCEPTION] {e}")

        _gdrive_stop_event.wait(60)

def start_gdrive_daemon():
    global _gdrive_thread
    if _gdrive_thread is None or not _gdrive_thread.is_alive():
        _gdrive_stop_event.clear()
        _gdrive_thread = threading.Thread(target=_gdrive_backup_daemon, daemon=True, name="GDriveBackupWorker")
        _gdrive_thread.start()
        print("[ATL] Background Google Drive backup worker active (interval: 60s)")

def stop_gdrive_daemon(timeout=5):
    global _gdrive_thread
    _gdrive_stop_event.set()
    if _gdrive_thread is not None and _gdrive_thread.is_alive():
        _gdrive_thread.join(timeout=timeout)

# Start background Google Drive backup daemon
start_gdrive_daemon()

@app.route("/api/reconcile", methods=["POST"])
@require_admin
def reconcile():
    try:
        j = request.get_json(silent=True) or {}
    except Exception:
        j = {}
    date = j.get("date") or today_ist()
    try:
        datetime.date.fromisoformat(date)
    except Exception:
        return jsonify({"error": "bad date"}), 400
    try:
        res = run_reconciliation(date=date)
        if "error" in res:
            return jsonify(res), 400
        return jsonify(res)
    except sqlite3.Error as e:
        return jsonify({"error": f"DB_FAIL {e}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/attendance")
def attendance():
    date = request.args.get("date")
    # pagination guard: limit clamped to 2000, offset >=0
    def _clamp_limit(default=2000, maxv=2000):
        try:
            v = int(request.args.get("limit", default))
        except: v = default
        return max(1, min(v, maxv))
    def _clamp_offset():
        try:
            v = int(request.args.get("offset", 0))
        except: v = 0
        return max(0, v)
    try:
        db = get_db()
        if date:
            try:
                datetime.date.fromisoformat(date)
            except:
                return jsonify({"error":"bad date"}), 400
            # optional limit for large date queries
            if "limit" in request.args:
                lim = _clamp_limit()
                off = _clamp_offset()
                rows = db.execute("SELECT * FROM events WHERE date=? ORDER BY time DESC LIMIT ? OFFSET ?", (date, lim, off)).fetchall()
            else:
                rows = db.execute("SELECT * FROM events WHERE date=? ORDER BY time DESC", (date,)).fetchall()
        else:
            lim = _clamp_limit()
            off = _clamp_offset()
            rows = db.execute("SELECT * FROM events ORDER BY date DESC, time DESC LIMIT ? OFFSET ?", (lim, off)).fetchall()
        return jsonify([dict(r) for r in rows])
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/daily")
def daily():
    date = request.args.get("date")
    def _clamp_limit(default=5000, maxv=5000):
        try:
            v = int(request.args.get("limit", default))
        except: v = default
        return max(1, min(v, maxv))
    def _clamp_offset():
        try:
            v = int(request.args.get("offset", 0))
        except: v = 0
        return max(0, v)
    try:
        db = get_db()
        if date:
            try:
                datetime.date.fromisoformat(date)
            except:
                return jsonify({"error":"bad date"}), 400
            if "limit" in request.args:
                lim = _clamp_limit()
                off = _clamp_offset()
                rows = db.execute("SELECT * FROM daily WHERE date=? LIMIT ? OFFSET ?", (date, lim, off)).fetchall()
            else:
                rows = db.execute("SELECT * FROM daily WHERE date=?", (date,)).fetchall()
        else:
            lim = _clamp_limit()
            off = _clamp_offset()
            rows = db.execute("SELECT * FROM daily LIMIT ? OFFSET ?", (lim, off)).fetchall()
        return jsonify([dict(r) for r in rows])
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/export")
@require_admin
def export_all():
    try:
        db = get_db()
        return jsonify({
            "exportedAt": now_ist(),
            "source": "sqlite",
            "settings": get_settings(),
            "students": [dict(r) for r in db.execute("SELECT * FROM students").fetchall()],
            "events": [dict(r) for r in db.execute("SELECT * FROM events ORDER BY date DESC, time DESC LIMIT 5000").fetchall()],
            "daily": [dict(r) for r in db.execute("SELECT * FROM daily").fetchall()],
        })
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/kpis")
def kpis():
    date = request.args.get("date") or today_ist()
    cls = (request.args.get("class") or request.args.get("grade") or "").strip()
    batch = (request.args.get("batch") or "").strip()
    try:
        datetime.date.fromisoformat(date)
    except:
        return jsonify({"error":"bad date"}), 400
    try:
        db = get_db()
        s = get_settings()
        # filter students by class/batch if requested
        if cls or batch:
            cond = " WHERE active=1"
            params = []
            if cls:
                cond += " AND lower(grade)=lower(?)"
                params.append(cls)
            if batch:
                cond += " AND lower(batch)=lower(?)"
                params.append(batch)
            rows = db.execute(f"SELECT * FROM students{cond}", params).fetchall()
        else:
            rows = db.execute("SELECT * FROM students WHERE active=1").fetchall()
        total = len(rows)
        scheduled = 0
        not_scheduled = 0
        present = late = absent = 0
        daily_map = {
            r["studentId"]: r["status"]
            for r in db.execute("SELECT studentId, status FROM daily WHERE date=?", (date,)).fetchall()
        }
        for r in rows:
            stu = dict(r)
            if is_student_scheduled(date, stu, s):
                scheduled += 1
                st = daily_map.get(r["id"])
                if st == "PRESENT":
                    present += 1
                elif st == "LATE":
                    late += 1
                elif st == "ABSENT":
                    absent += 1
                elif st == "NOT_SCHEDULED":
                    not_scheduled += 1
            else:
                not_scheduled += 1
        return jsonify({"total": total, "scheduled": scheduled, "present": present, "late": late, "absent": absent, "notScheduled": not_scheduled, "date": date})
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/reports")
def reports():
    sid = request.args.get("studentId")
    if not sid: return jsonify({"error":"studentId required"}), 400
    try:
        db = get_db()
        stu = db.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
        if not stu: return jsonify({"error":"not found"}), 404
        s = get_settings()
        # optional window, backward compatible
        start_param = request.args.get("start")
        end_param = request.args.get("end")
        try:
            start = datetime.date.fromisoformat(start_param) if start_param else datetime.date.fromisoformat(s["attendanceStartDate"])
            end = datetime.date.fromisoformat(end_param) if end_param else datetime.date.fromisoformat(today_ist())
        except Exception:
            return jsonify({"error": "bad date"}), 400
        if start > end:
            return jsonify({"error": "start after end"}), 400
        buckets = [{"attended":0,"total":0} for _ in range(11)]
        daily_map = {
            r["date"]: r["status"]
            for r in db.execute("SELECT date, status FROM daily WHERE studentId=? AND date BETWEEN ? AND ?", (sid, start.isoformat(), end.isoformat())).fetchall()
        }
        d = start
        while d <= end:
            iso = d.isoformat()
            if is_student_scheduled(iso, dict(stu), s):
                # Jun=0 .. Apr=10, year-agnostic (May unused)
                if d.month >= 6:
                    idx = d.month - 6
                elif d.month <= 4:
                    idx = d.month + 6
                else:
                    idx = None
                if idx is not None and 0 <= idx < 11:
                    buckets[idx]["total"] += 1
                    if daily_map.get(iso) in ("PRESENT", "LATE"):
                        buckets[idx]["attended"] += 1
            d += datetime.timedelta(days=1)
        present = db.execute("SELECT COUNT(*) FROM daily WHERE studentId=? AND status='PRESENT' AND date BETWEEN ? AND ?", (sid, start.isoformat(), end.isoformat())).fetchone()[0]
        late = db.execute("SELECT COUNT(*) FROM daily WHERE studentId=? AND status='LATE' AND date BETWEEN ? AND ?", (sid, start.isoformat(), end.isoformat())).fetchone()[0]
        absent = db.execute("SELECT COUNT(*) FROM daily WHERE studentId=? AND status='ABSENT' AND date BETWEEN ? AND ?", (sid, start.isoformat(), end.isoformat())).fetchone()[0]
        eligible = sum(b["total"] for b in buckets)
        attended = sum(b["attended"] for b in buckets)
        rate = round(attended/eligible*100) if eligible else 0
        return jsonify({"present": present, "late": late, "absent": absent, "eligible": eligible, "attended": attended, "rate": rate, "buckets": buckets, "start": start.isoformat(), "end": end.isoformat()})
    except Exception as e:
        return jsonify({"error":f"FAIL {e}"}), 500

# --- Images ---
@app.route("/api/images", methods=["GET", "DELETE"])
def list_images():
    if request.method == "DELETE":
        pin = _admin_pin()
        if pin:
            got = (request.headers.get("X-Admin-Pin") or "").strip()
            if got != pin:
                return jsonify({"error": "admin pin required"}), 401
    try:
        db = get_db()
        if request.method == "DELETE":
            try:
                rows_to_delete = db.execute("SELECT name FROM images").fetchall()
                names = [r[0] for r in rows_to_delete if r[0]]
            except:
                names = []
            with DB_LOCK:
                db.execute("DELETE FROM images")
                db.commit()
            s = get_settings()
            s["imageGallery"] = []
            save_settings(s)
            with DB_LOCK:
                db.execute("INSERT INTO audit VALUES (?,?,?,?)", (str(uuid.uuid4()), now_ist(), "GALLERY_CLEARED", ""))
                db.commit()
            import pathlib as pl
            for n in names:
                for base in (pl.Path(IMAGES_DIR), ROOT / "assets" / "images" / "students"):
                    try:
                        p = base / n
                        if p.is_file():
                            p.unlink()
                    except:
                        pass
            return jsonify({"ok": True})
        rows = db.execute("SELECT * FROM images ORDER BY at DESC").fetchall()
        s = get_settings()
        gal = s.get("imageGallery", [])
        seen = set()
        combined = []
        for r in rows:
            d = dict(r)
            iid = str(d.get("id"))
            if iid not in seen:
                seen.add(iid)
                combined.append(d)
        for g in gal:
            gid = str(g.get("id"))
            if gid not in seen:
                seen.add(gid)
                combined.append(g)
        return jsonify(combined[:60])
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/images/<iid>", methods=["DELETE"])
@require_admin
def delete_image(iid):
    try:
        db = get_db()
        row = db.execute("SELECT * FROM images WHERE id=?", (iid,)).fetchone()
        if row:
            name = None
            try:
                name = row["name"]
            except:
                pass
            with DB_LOCK:
                db.execute("DELETE FROM images WHERE id=?", (iid,))
                db.commit()
            if name:
                import pathlib as pl
                for base in (pl.Path(IMAGES_DIR), ROOT / "assets" / "images" / "students"):
                    try:
                        p = base / str(name)
                        if p.is_file():
                            p.unlink()
                    except:
                        pass
            return jsonify({"ok": True, "id": iid})
        s = get_settings()
        gal = s.get("imageGallery") or []
        next_gal = [x for x in gal if str(x.get("id")) != str(iid)]
        if len(next_gal) == len(gal):
            return jsonify({"error": "not found"}), 404
        s["imageGallery"] = next_gal
        save_settings(s)
        return jsonify({"ok": True, "id": iid})
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/notifications")
def list_notifications():
    try:
        db = get_db()
        rows = db.execute("SELECT * FROM notifications ORDER BY createdAt DESC LIMIT 50").fetchall()
        return jsonify([dict(r) for r in rows])
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/audit")
@require_admin
def list_audit():
    try:
        db = get_db()
        rows = db.execute("SELECT * FROM audit ORDER BY rowid DESC LIMIT 500").fetchall()
        return jsonify([dict(r) for r in rows])
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500

@app.route("/api/images/upload", methods=["POST"])
@require_admin
def upload_image():
    try:
        os.makedirs(IMAGES_DIR, exist_ok=True)
        if "file" not in request.files:
            return jsonify({"error":"no file"}), 400
        f = request.files["file"]
        name = f.filename or f"img_{int(time.time())}.png"
        name = "".join(c for c in name if c.isalnum() or c in "._-")[:80] or "image.png"
        # Check size via seek
        f.seek(0, os.SEEK_END)
        sz = f.tell()
        f.seek(0)
        if sz > 2*1024*1024:
            return jsonify({"error":"max 2MB"}), 400
        import pathlib as pl
        dest = pl.Path(IMAGES_DIR) / name
        if dest.exists():
            stem = dest.stem
            suffix = dest.suffix or ".png"
            stem = stem[: max(0, 80 - len(suffix) - 9)]
            name = f"{stem}_{uuid.uuid4().hex[:8]}{suffix}"
            dest = pl.Path(IMAGES_DIR) / name
        f.save(str(dest))
        url = f"/assets/images/students/{name}" if os.name=="nt" else f"/api/images/file/{name}"
        with DB_LOCK:
            db = get_db()
            iid = str(uuid.uuid4())
            db.execute("INSERT INTO images VALUES (?,?,?,?,?)", (iid, url, name, "students", now_ist()))
            db.commit()
        return jsonify({"url": url, "name": name, "id": iid})
    except sqlite3.Error as e:
        return jsonify({"error":f"DB_FAIL {e}"}), 500
    except Exception as e:
        return jsonify({"error":f"FAIL {e}"}), 500

@app.route("/api/images/file/<path:name>")
def serve_image(name):
    return send_from_directory(IMAGES_DIR, name)

# --- Fallback ---
@app.errorhandler(404)
def not_found(e):
    p = request.path
    if p.startswith(("/api/", "/assets/", "/backend/", "/tools/", "/pi/", "/.git")):
        return jsonify({"error":"not found"}), 404
    return _serve_production()

if __name__ == "__main__":
    print(f"[ATL] DB: {DB_PATH}")
    print(f"[ATL] Images: {IMAGES_DIR}")
    print(f"[ATL] http://{HOST}:{PORT}  sensor={cfg.get('sensor')} uart={cfg.get('uart')}")
    os.makedirs(IMAGES_DIR, exist_ok=True)
    with app.app_context():
        get_db()
    # Sensor light always on while the service runs (real hardware only)
    try:
        _s = get_sensor()
        if not _s.sim:
            _s.keep_led_on = True
            _ok = _s.set_led(True)
            print(f"[ATL] Sensor LED always-on: {'ACK' if _ok else 'NO_ACK'}")
        _s.close()
    except Exception as _e:
        print(f"[ATL] Sensor LED startup skipped: {_e}")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
