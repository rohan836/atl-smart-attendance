import sqlite3
db = sqlite3.connect('/var/lib/atl/attendance.db')
db.row_factory = sqlite3.Row
print('STUDENTS:')
for r in db.execute('SELECT id,name,roll,grade,fingerId,active,photo FROM students'):
    print(' ', dict(r))
print('EVENT_COUNT:', db.execute('SELECT COUNT(*) FROM events').fetchone()[0])
print('LAST_EVENTS:')
for r in db.execute('SELECT date,time,studentId,fingerId,result,status,source FROM events ORDER BY rowid DESC LIMIT 6'):
    print(' ', dict(r))
print('DAILY_COUNT:', db.execute('SELECT COUNT(*) FROM daily').fetchone()[0])
print('SETTINGS_KEYS:', [r[0] for r in db.execute('SELECT key FROM settings')])
print('AUDIT_LAST:')
for r in db.execute('SELECT at,action,details FROM audit ORDER BY rowid DESC LIMIT 5'):
    print(' ', dict(r))
