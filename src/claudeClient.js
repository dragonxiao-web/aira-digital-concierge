const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";

// Both the classifier and the Q&A function ask Claude for ONLY a raw JSON
// object (no markdown fences, no prose). Models occasionally wrap that in
// ```json fences anyway, so strip them defensively before parsing rather
// than trusting the instruction to be followed literally.
function parseJsonResponse(text) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(stripped);
}

function firstTextBlock(message) {
  const block = message.content.find((b) => b.type === "text");
  if (!block) {
    throw new Error("Claude response contained no text block");
  }
  return block.text;
}

// Low effort: both call sites are short, single-turn structured-JSON tasks
// (classification / KB lookup) where latency matters more than deep reasoning.
async function askForJson({ system, user }) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    messages: [{ role: "user", content: user }],
  });

  return parseJsonResponse(firstTextBlock(message));
}

module.exports = { askForJson, MODEL };
