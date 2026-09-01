const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || "./data/concierge.db";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    ticket_id TEXT PRIMARY KEY,
    guest_name TEXT NOT NULL,
    room_number TEXT NOT NULL,
    guest_message TEXT NOT NULL,
    category TEXT NOT NULL,
    sensitive INTEGER NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    channel TEXT NOT NULL,
    session_id TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_dedup
    ON tickets (session_id, guest_message, status);

  CREATE TABLE IF NOT EXISTS unanswered_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_name TEXT NOT NULL,
    room_number TEXT NOT NULL,
    question TEXT NOT NULL,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

module.exports = db;
