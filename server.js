require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { routeGuestMessage } = require("./src/router");
const { listTickets, markResolved, findTicket } = require("./src/tickets");
const { verifySlackSignature } = require("./src/slackVerify");
const { summaryText } = require("./src/slack");

const app = express();

// Capture the raw body alongside the parsed one — Slack's signature check
// (see src/slackVerify.js) has to run over the exact bytes Slack sent,
// which is gone once a body parser re-serializes it.
function captureRawBody(req, res, buf) {
  req.rawBody = buf.toString("utf8");
}

// CORS must be handled (incl. OPTIONS preflight) or the widget's fetch()
// call gets silently blocked by the guest's browser (Section 10). The
// `cors` package handles both the header and the preflight automatically.
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ verify: captureRawBody }));
// Slack sends interactive payloads as application/x-www-form-urlencoded
// with a `payload` field holding JSON — a different content type than the
// rest of the API, so it needs its own parser.
app.use(express.urlencoded({ extended: false, verify: captureRawBody }));
app.use(express.static("public"));

app.post("/webhook", async (req, res) => {
  const body = req.body || {};

  const guestMessage = typeof body.guest_message === "string" ? body.guest_message.trim() : "";
  const sessionId = body.session_id;
  const channel = body.channel || "web_widget";
  const guestName = body.guest_name && body.guest_name.trim() ? body.guest_name.trim() : "Guest";
  const roomNumber = body.room_number && String(body.room_number).trim() ? String(body.room_number).trim() : "";

  if (!guestMessage || !sessionId) {
    return res.status(400).json({
      answer: "Sorry, something went wrong on my end. Please contact the front desk directly.",
      answered: false,
    });
  }

  try {
    const result = await routeGuestMessage({
      guestMessage,
      sessionId,
      channel,
      guestName,
      roomNumber,
    });
    return res.json(result);
  } catch (err) {
    console.error("[webhook] error handling guest message:", err);
    return res.status(500).json({
      answer: "Sorry, something went wrong on my end. Please contact the front desk directly and we'll help right away.",
      answered: false,
    });
  }
});

// Minimal staff-side endpoints — not part of the guest-facing contract,
// but needed to view tickets and to unlock the "resolved -> can dedupe as
// new" behavior described in Section 6.
app.get("/tickets", (req, res) => {
  res.json(listTickets({ status: req.query.status }));
});

app.post("/tickets/:ticketId/resolve", (req, res) => {
  const result = markResolved(req.params.ticketId);
  if (result.changes === 0) {
    return res.status(404).json({ error: "ticket not found" });
  }
  res.json({ ok: true });
});

// Slack calls this when staff click a button on a ticket alert. Must be
// signature-verified (src/slackVerify.js) since anyone who finds this URL
// could otherwise resolve tickets or spam the channel.
app.post("/slack/actions", async (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).send("invalid signature");
  }

  // Ack immediately — Slack expects a response within 3 seconds and treats
  // silence/timeouts as a failed delivery it may retry.
  res.status(200).send("");

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (err) {
    console.error("[slack/actions] failed to parse payload:", err.message);
    return;
  }

  const action = payload.actions && payload.actions[0];
  if (!action) return;

  const ticketId = action.value;
  const ticket = findTicket(ticketId);
  if (!ticket) {
    console.error(`[slack/actions] unknown ticket_id: ${ticketId}`);
    return;
  }

  const clickedBy = (payload.user && payload.user.name) || "someone";
  let statusLine;

  if (action.action_id === "ticket_complete") {
    markResolved(ticketId);
    statusLine = `✅ Marked *completed* by ${clickedBy}`;
  } else if (action.action_id === "ticket_not_yet") {
    statusLine = `🕓 Marked *not yet done* by ${clickedBy} — still open`;
  } else {
    return;
  }

  // Replace the original message: same summary, buttons swapped out for a
  // plain status line so it can't be double-clicked.
  try {
    await fetch(payload.response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text: summaryText(ticket, ticket.sensitive ? "sensitive" : "request"),
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: summaryText(ticket, ticket.sensitive ? "sensitive" : "request") } },
          { type: "context", elements: [{ type: "mrkdwn", text: statusLine }] },
        ],
      }),
    });
  } catch (err) {
    console.error("[slack/actions] failed to update message:", err.message);
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AIRA Digital Concierge listening on port ${PORT}`);
});
