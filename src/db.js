const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3-multiple-ciphers");

const DB_PATH = process.env.DB_PATH || "./data/concierge.db";
const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;

// Fail closed: an app that silently falls back to an unencrypted database
// when the key is missing isn't actually meeting a "data encrypted at
// rest" requirement, it just looks like it does until someone checks.
if (!DB_ENCRYPTION_KEY) {
  throw new Error(
    "DB_ENCRYPTION_KEY is not set. Refusing to open the database unencrypted — " +
      "generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` " +
      "and set it in .env."
  );
}
// The key is interpolated into a PRAGMA string below (the driver has no
// parameterized form for it) — a stray single quote would break out of the
// SQL string literal, so validate the shape rather than trust it blindly.
if (!/^[0-9a-f]{64}$/i.test(DB_ENCRYPTION_KEY)) {
  throw new Error("DB_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Must run before anything else touches the database: on a fresh file this
// encrypts it from creation; on an existing encrypted file this unlocks it.
// `cipher='sqlcipher'` + `legacy=4` selects the AES-256 scheme compatible
// with SQLCipher 4 (see README for the full cipher list) rather than this
// driver's own default (sqleet) — SQLCipher is what was asked for by name.
db.pragma("cipher='sqlcipher'");
db.pragma("legacy=4");
db.pragma(`key='${DB_ENCRYPTION_KEY}'`);

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
