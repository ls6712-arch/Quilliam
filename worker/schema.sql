-- Quilliam D1 schema (database "quilliam"). Safe to run more than once.
CREATE TABLE IF NOT EXISTS buyers (token TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 1, season_until TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS purchases (session_id TEXT PRIMARY KEY, token TEXT NOT NULL, plan TEXT NOT NULL, amount_cents INTEGER, email TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS letters (id TEXT PRIMARY KEY, token TEXT NOT NULL, to_name TEXT, from_name TEXT, paper TEXT, layout TEXT, certified INTEGER NOT NULL DEFAULT 0, strokes INTEGER, words INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS mail_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, price TEXT, occasion TEXT, paper TEXT, layout TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS business_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, company TEXT NOT NULL, email TEXT NOT NULL, size TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS letters_token ON letters(token);
CREATE INDEX IF NOT EXISTS purchases_token ON purchases(token);
