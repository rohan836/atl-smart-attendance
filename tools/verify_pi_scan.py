#!/usr/bin/env python3
import requests, json, sys, time
BASE="http://192.168.1.8:5000"
def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}: {name} {detail}")
    return cond
ok=True
# health
r=requests.get(f"{BASE}/api/health", timeout=5)
j=r.json()
ok &= check("health db_ok", j.get("db_ok")==True)
ok &= check("health sensor ready/busy (real)", j.get("sensor") in ("ready","busy"))
# students
r=requests.get(f"{BASE}/api/students", timeout=5)
students=r.json()
has_fid=[s for s in students if s.get("fingerId") is not None]
ok &= check(f"students {len(students)} has finger", len(has_fid)>0, f"fid={has_fid[0].get('fingerId') if has_fid else 'none'}")
sid=None
if has_fid:
    sid=has_fid[0]["id"]
    # Present/Late via studentId (bypasses sensor, tests API response handling)
    r=requests.post(f"{BASE}/api/scan", json={"studentId": sid}, timeout=5)
    j=r.json()
    # first scan may be Present/Late or Duplicate if already scanned today
    ok &= check("scan registered Present/Late or Already recorded", j.get("status") in ("PRESENT","LATE","DUPLICATE") or j.get("reason") in ("DUPLICATE",), str(j))
    # duplicate
    r=requests.post(f"{BASE}/api/scan", json={"studentId": sid}, timeout=5)
    j=r.json()
    ok &= check("duplicate Already recorded", j.get("reason")=="DUPLICATE" and j.get("status")=="DUPLICATE", str(j))
else:
    print("SKIP registered scan - no fid student")
# Not Scheduled: create a student with Grade 10 and set classSchedules to make Monday not scheduled, then reconcile
# For Pi, use today if not scheduled else use a known Monday
# Simpler: test via is_student_scheduled logic - use a student with Grade 10 and set schedule to not today
try:
    import datetime
    today=datetime.date.today().isoformat()
    # create temp student for Not Scheduled test if needed
    # use existing Grade 10 student and try to hit NOT_SCHEDULED via schedule
    # Instead directly test via API: set classSchedules for Grade 10 to not today
    s=requests.get(f"{BASE}/api/settings", timeout=5).json()
    # save original
    orig=s.copy()
    # make today not scheduled for Grade 10
    wd={str(i):False for i in range(7)}
    # find today's weekday (0 Sun)
    import datetime as dt
    today_w=(dt.date.today().weekday()+1)%7
    # set Grade 10 to false today, true other
    cs=s.get("classSchedules") or {}
    cs["Grade 10"]={str(i): (i!=today_w) for i in range(7)}
    requests.post(f"{BASE}/api/settings", json={"classSchedules": cs}, timeout=5)
    # create student Grade 10
    r=requests.post(f"{BASE}/api/students", json={"name":"NS Test","roll":f"NS-{int(time.time())%10000}","grade":"Grade 10","phone":"9000000000"}, timeout=5)
    ns_sid=r.json().get("id")
    r=requests.post(f"{BASE}/api/scan", json={"studentId": ns_sid}, timeout=5)
    j=r.json()
    ok &= check("Not Scheduled", j.get("reason")=="NOT_SCHEDULED" and j.get("status")=="NOT_SCHEDULED" and "seq" in j, str(j))
    # ensure second NOT_SCHEDULED also has seq
    r=requests.post(f"{BASE}/api/scan", json={"studentId": ns_sid}, timeout=5)
    j=r.json()
    ok &= check("Not Scheduled second has seq", j.get("reason")=="NOT_SCHEDULED" and "seq" in j, str(j))
    # restore settings
    requests.post(f"{BASE}/api/settings", json={"classSchedules": orig.get("classSchedules",{})}, timeout=5)
    # test NON_WORKING_DAY: set holiday today
    s2=requests.get(f"{BASE}/api/settings", timeout=5).json()
    orig2=s2.copy()
    requests.post(f"{BASE}/api/settings", json={"holidays":[f"{today}:holiday:TestHoliday"]}, timeout=5)
    # create or reuse student
    r=requests.post(f"{BASE}/api/scan", json={"studentId": ns_sid}, timeout=5)
    j=r.json()
    ok &= check("NON_WORKING_DAY", j.get("reason")=="NON_WORKING_DAY" and "seq" in j, str(j))
    requests.post(f"{BASE}/api/settings", json={"holidays": orig2.get("holidays",[])}, timeout=5)
except Exception as e:
    print(f"FAIL: Not Scheduled/NON_WORKING_DAY exception {e}")

# Unknown
r=requests.post(f"{BASE}/api/scan", json={"isUnknown": True}, timeout=5)
j=r.json()
ok &= check("Unknown", j.get("reason")=="UNKNOWN" and "seq" in j, str(j))

# NO_FINGER creates no event
r=requests.get(f"{BASE}/api/attendance", timeout=5)
before=len(r.json())
r=requests.post(f"{BASE}/api/scan", json={"waitSec":2}, timeout=7)
j=r.json() if r.status_code==400 else {}
ok &= check("NO_FINGER no event", j.get("reason")=="NO_FINGER", str(j))
r=requests.get(f"{BASE}/api/attendance", timeout=5)
after=len(r.json())
ok &= check("NO_FINGER count unchanged", before==after, f"{before}->{after}")

# Admin still works
r=requests.get(f"{BASE}/", timeout=5)
ok &= check("Admin HTML", "adminLayer" in r.text and "PLACE YOUR FINGER TO SCAN" in r.text)
# enrollment still works (will fail without finger but should not crash, should return sensor error)
r=requests.post(f"{BASE}/api/enroll", json={"name":"EnrollTest","roll":f"EN-{int(time.time())%10000}","grade":"Grade 10-A","phone":"9000000000"}, timeout=10)
# enroll without finger on real sensor should return 503 or 500 with sensor error, not crash
ok &= check("enroll endpoint reachable", r.status_code in (503,500,400), f"code {r.status_code}")

print("OVERALL", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
