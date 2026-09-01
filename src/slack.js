const { WebClient } = require("@slack/web-api");

const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_CHANNEL || "#concierge-alerts";
const client = token ? new WebClient(token) : null;

// Slack rejects a mrkdwn block whose text exceeds 3000 characters
// (invalid_blocks) — the ticket's own guest_message has no length limit,
// so it's the one part of this that needs capping before it goes to Slack.
// The full, untruncated message still lives in the ticket record itself.
const MAX_MESSAGE_CHARS = 800;

function summaryText(ticket, style) {
  const header = style === "sensitive" ? "🚨 SENSITIVE TICKET — Needs Human Review" : "🛎️ New Request";
  const message =
    ticket.guest_message.length > MAX_MESSAGE_CHARS
      ? `${ticket.guest_message.slice(0, MAX_MESSAGE_CHARS)}… (truncated, see full ticket)`
      : ticket.guest_message;
  return [
    `*${header}*`,
    `Ticket: *${ticket.ticket_id}*`,
    `Guest: ${ticket.guest_name} (Room ${ticket.room_number})`,
    `Category: ${ticket.category}`,
    `Message: "${message}"`,
  ].join("\n");
}

// "Mark Completed" resolves the ticket (and unlocks the dedup rule in
// tickets.js — a resolved ticket's message can be re-opened as new).
// "Not Yet" doesn't change ticket status; it just acknowledges the alert
// was seen and stays actionable, so staff aren't left wondering if anyone
// noticed it. Both button values carry the ticket_id so /slack/actions
// knows what they're acting on.
function buildBlocks(ticket, style) {
  return [
    { type: "section", text: { type: "mrkdwn", text: summaryText(ticket, style) } },
    {
      type: "actions",
      block_id: `ticket_actions_${ticket.ticket_id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Mark Completed", emoji: true },
          style: "primary",
          action_id: "ticket_complete",
          value: ticket.ticket_id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Not Yet", emoji: true },
          action_id: "ticket_not_yet",
          value: ticket.ticket_id,
        },
      ],
    },
  ];
}

// Best-effort side notification — the guest-facing response must never
// depend on Slack succeeding. Any failure (missing token, network error,
// invalid channel) is swallowed here, never thrown to the caller.
async function notifyStaff(ticket, style) {
  if (!client) {
    console.warn("[slack] SLACK_BOT_TOKEN not set — skipping staff notification");
    return;
  }
  try {
    await client.chat.postMessage({
      channel,
      text: summaryText(ticket, style), // fallback text for notifications/screen readers
      blocks: buildBlocks(ticket, style),
    });
  } catch (err) {
    console.error("[slack] notification failed:", err.message);
  }
}

module.exports = { notifyStaff, summaryText };
