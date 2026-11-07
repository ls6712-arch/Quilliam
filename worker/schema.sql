-- Quilliam D1 schema (database "quilliam"). Safe to run more than once.
CREATE TABLE IF NOT EXISTS buyers (token TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 1, season_until TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS purchases (session_id TEXT PRIMARY KEY, token TEXT NOT NULL, plan TEXT NOT NULL, amount_cents INTEGER, email TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS letters (id TEXT PRIMARY KEY, token TEXT NOT NULL, to_name TEXT, from_name TEXT, paper TEXT, layout TEXT, certified INTEGER NOT NULL DEFAULT 0, strokes INTEGER, words INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS mail_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, price TEXT, occasion TEXT, paper TEXT, layout TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS business_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, company TEXT NOT NULL, email TEXT NOT NULL, size TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS letters_token ON letters(token);
CREATE INDEX IF NOT EXISTS purchases_token ON purchases(token);
-- 2026-11: scheduled delivery, secret question, envelope seal, Quilliam AI usage
ALTER TABLE letters ADD COLUMN unlock_at TEXT;
ALTER TABLE letters ADD COLUMN lock_q TEXT;
ALTER TABLE letters ADD COLUMN lock_hash TEXT;
ALTER TABLE letters ADD COLUMN seal_c TEXT;
ALTER TABLE letters ADD COLUMN seal_d TEXT;
ALTER TABLE letters ADD COLUMN seal_g TEXT;
CREATE TABLE IF NOT EXISTS quilliam_usage (token TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (token, day));
-- 2026-11: accounts, codes, sign-in, contact, wax seal designer
ALTER TABLE buyers ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS buyers_email ON buyers(email);
ALTER TABLE letters ADD COLUMN seal_o TEXT;
CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0, season INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS redemptions (code TEXT NOT NULL, token TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (code, token));
CREATE TABLE IF NOT EXISTS signin_codes (code_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS signin_email ON signin_codes(email, created_at);
CREATE TABLE IF NOT EXISTS contact_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT NOT NULL, topic TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS signup_ips (ip TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip, day));
-- 2026-11: server-side handwriting check + replay
ALTER TABLE letters ADD COLUMN ink_report TEXT;
