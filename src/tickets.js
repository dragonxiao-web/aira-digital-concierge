const db = require("./db");

const OPEN_STATUSES = ["open", "pending_human_review"];

function generateTicketId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  return `TCK-${stamp}`;
}

// Duplicate = same session_id + exact same guest_message, on a ticket that
// hasn't been resolved yet. Once staff mark a ticket resolved, the same
// message from the same guest is treated as a brand-new request (Section 6).
function findOpenDuplicate(sessionId, guestMessage) {
  const placeholders = OPEN_STATUSES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT * FROM tickets
       WHERE session_id = ? AND guest_message = ? AND status IN (${placeholders})
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(sessionId, guestMessage, ...OPEN_STATUSES);
  return row || null;
}

function createTicket({
  guestName,
  roomNumber,
  guestMessage,
  category,
  sensitive,
  confidence,
  status,
  channel,
  sessionId,
}) {
  const ticket = {
    ticket_id: generateTicketId(),
    guest_name: guestName,
    room_number: roomNumber,
    guest_message: guestMessage,
    category,
    sensitive: sensitive ? 1 : 0,
    confidence,
    status,
    created_at: new Date().toISOString(),
    channel,
    session_id: sessionId,
  };

  db.prepare(
    `INSERT INTO tickets
      (ticket_id, guest_name, room_number, guest_message, category, sensitive, confidence, status, created_at, channel, session_id)
     VALUES (@ticket_id, @guest_name, @room_number, @guest_message, @category, @sensitive, @confidence, @status, @created_at, @channel, @session_id)`
  ).run(ticket);

  return ticket;
}

function findTicket(ticketId) {
  return db.prepare(`SELECT * FROM tickets WHERE ticket_id = ?`).get(ticketId) || null;
}

function markResolved(ticketId) {
  return db
    .prepare(`UPDATE tickets SET status = 'resolved' WHERE ticket_id = ?`)
    .run(ticketId);
}

function listTickets({ status } = {}) {
  if (status) {
    return db
      .prepare(`SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC`)
      .all(status);
  }
  return db.prepare(`SELECT * FROM tickets ORDER BY created_at DESC`).all();
}

module.exports = { findOpenDuplicate, createTicket, markResolved, listTickets, findTicket };
