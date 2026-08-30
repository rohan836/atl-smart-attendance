-- SQLite schema mirroring localStorage state
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  roll TEXT UNIQUE NOT NULL,
  grade TEXT NOT NULL,
  batch TEXT,
  section TEXT,
  parent TEXT,
  phone TEXT,
  address TEXT,
  fingerId INTEGER UNIQUE,
  photo TEXT,
  active INTEGER DEFAULT 1,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  studentId INTEGER,
  fingerId INTEGER,
  result TEXT,
  status TEXT,
  source TEXT,
  at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(studentId) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS daily (
  key TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  studentId INTEGER NOT NULL,
  status TEXT,
  firstScan TEXT,
  lastScan TEXT,
  FOREIGN KEY(studentId) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  studentId INTEGER,
  createdAt TEXT,
  status TEXT,
  message TEXT,
  attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at TEXT,
  action TEXT,
  details TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT -- JSON
);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  url TEXT,
  name TEXT,
  category TEXT,
  at TEXT
);
