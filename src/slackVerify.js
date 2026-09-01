const crypto = require("crypto");

const FIVE_MINUTES = 60 * 5;

// Verifies the request actually came from Slack (v0 signing scheme), so
// /slack/actions can't be spoofed to resolve tickets or spam the channel.
// Requires the raw request body — must run before anything re-serializes it.
function verifySlackSignature(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn("[slack] SLACK_SIGNING_SECRET not set — rejecting /slack/actions request");
    return false;
  }

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature || typeof req.rawBody !== "string") return false;

  // Reject stale requests as a replay-attack guard.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > FIVE_MINUTES) return false;

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifySlackSignature };
