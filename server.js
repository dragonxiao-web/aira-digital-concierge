require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;
const { routeGuestMessage } = require("./src/router");
const { listTickets, markResolved, findTicket } = require("./src/tickets");
const { verifySlackSignature } = require("./src/slackVerify");
const { summaryText } = require("./src/slack");

// Same fail-closed posture as DB_ENCRYPTION_KEY (src/db.js): the staff
// endpoints below expose guest PII (names, room numbers, message content),
// so an app that silently ran with auth disabled because this was unset
// would look secure without being secure.
const STAFF_API_KEY = process.env.STAFF_API_KEY;
if (!STAFF_API_KEY || STAFF_API_KEY.length < 32) {
  throw new Error(
    "STAFF_API_KEY is not set (or too short). Refusing to start — the /tickets " +
      "endpoints expose guest PII and must not run unauthenticated. Generate one " +
      "with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` " +
      "and set it in .env."
  );
}

// Staff-only endpoints require `Authorization: Bearer <STAFF_API_KEY>`.
// Constant-time comparison so response timing can't be used to guess the key.
function requireStaffAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "missing or malformed Authorization header" });
  }

  const provided = Buffer.from(token);
  const expected = Buffer.from(STAFF_API_KEY);
  const valid = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);

  if (!valid) {
    return res.status(401).json({ error: "invalid staff API key" });
  }
  next();
}

const app = express();

// Needed for accurate per-IP rate limiting behind a reverse proxy/tunnel
// (ngrok, or a real load balancer in production) — without this, every
// request's req.ip resolves to the proxy's address instead of the actual
// client, so every guest would share one rate-limit bucket. `1` means
// "trust exactly one hop in front of this app"; adjust if the real
// deployment topology has more hops between the internet and this process.
app.set("trust proxy", 1);

// /webhook is the one endpoint that costs real money per request (an
// Anthropic API call every time, sometimes two) and is meant to be public —
// nothing stops a bot from hammering it otherwise. Two limiters stack here
// because hotel guests typically share one public IP (hotel WiFi NAT) —
// limiting by IP alone would mean every guest in the building shares a
// single budget, and a handful of guests chatting at once could trip a
// "too many requests" error that has nothing to do with any one of them.
const webhookLimiterHandler = (req, res) => {
  res.status(429).json({
    answer: "You're sending messages a little too quickly — please wait a moment and try again.",
    answered: false,
  });
};

// Per-guest limit: keyed by session_id (stable per guest, set by the widget)
// rather than IP, so each guest gets their own 20-per-5-minutes budget
// regardless of how many other guests share the same hotel network.
const webhookSessionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    req.body && typeof req.body.session_id === "string" && req.body.session_id
      ? `session:${req.body.session_id}`
      : ipKeyGenerator(req.ip),
  handler: webhookLimiterHandler,
});

// Per-network backstop: keyed by IP as normal, with a much higher ceiling
// since this key now represents a whole hotel's worth of legitimate
// traffic, not one guest. Catches a genuine flood (e.g. a bot spraying
// random session_ids to dodge the limiter above) without punishing a busy
// hotel for having several guests chatting at once.
const webhookIpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: webhookLimiterHandler,
});

// Defense in depth on top of requireStaffAuth: STAFF_API_KEY is a 64-char
// hex string so brute-forcing it is already computationally infeasible,
// but this still slows/logs repeated failed-auth attempts against these
// PII-exposing endpoints.
const staffLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: "too many requests" }),
});

// Slack requests are already signature-verified (verifySlackSignature) —
// this is just a backstop against a replay flood, so the limit is generous.
const slackActionsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).send(""),
});

// Liveness probe for monitoring tools. Mounted before CORS/body-parsing/
// everything else, and its handler touches nothing but the process clock —
// no DB, no Anthropic/Slack calls — so it stays reachable even if those are
// down or the encrypted DB failed to open. (A missing/malformed
// DB_ENCRYPTION_KEY still prevents the process from starting at all — see
// src/db.js — but once the process is up, this endpoint can't be dragged
// down by anything that happens after this line.)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

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

app.post("/webhook", webhookIpLimiter, webhookSessionLimiter, async (req, res) => {
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
// new" behavior described in Section 6. Gated by requireStaffAuth since
// these expose guest names, room numbers, and message content.
app.get("/tickets", staffLimiter, requireStaffAuth, (req, res) => {
  res.json(listTickets({ status: req.query.status }));
});

app.post("/tickets/:ticketId/resolve", staffLimiter, requireStaffAuth, (req, res) => {
  const result = markResolved(req.params.ticketId);
  if (result.changes === 0) {
    return res.status(404).json({ error: "ticket not found" });
  }
  res.json({ ok: true });
});

// Slack calls this when staff click a button on a ticket alert. Must be
// signature-verified (src/slackVerify.js) since anyone who finds this URL
// could otherwise resolve tickets or spam the channel.
app.post("/slack/actions", slackActionsLimiter, async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AIRA Digital Concierge listening on port ${PORT}`);
});
