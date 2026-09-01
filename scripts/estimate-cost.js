require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";

// Reach into the actual prompt-building logic rather than duplicating it,
// so this stays accurate if the prompts change.
const classifierSrc = require("fs").readFileSync(__dirname + "/../src/classifier.js", "utf8");
const SYSTEM_PROMPT = classifierSrc.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];

const { kb } = require("../src/qa.js");
const aggregatedKbText = kb
  .map((row) => `Category: ${row.category}\nQ: ${row.question}\nA: ${row.answer}`)
  .join("\n\n");
const QA_SYSTEM = `You are a hotel Q&A assistant. A guest has asked a question. Answer using ONLY the hotel information provided below. Do not guess, invent, or assume information beyond what's given.\n\nHOTEL KNOWLEDGE BASE:\n${aggregatedKbText}\n\nOutput ONLY the following JSON object...`;

// $ per 1M tokens. Sonnet 5 had $2/$10 intro pricing through 2026-08-31;
// using the standard post-intro rate here since that window has passed.
const PRICES = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};
const PRICE = PRICES[MODEL] || PRICES["claude-sonnet-5"];

async function count(system, user) {
  const res = await client.messages.countTokens({
    model: MODEL,
    system,
    messages: [{ role: "user", content: user }],
  });
  return res.input_tokens;
}

async function main() {
  console.log(`Model: ${MODEL}  ($${PRICE.input}/1M input, $${PRICE.output}/1M output)\n`);

  const sampleMsg = "Can I get extra towels for room 204?";

  const classifierInputTokens = await count(SYSTEM_PROMPT, `Guest Name: Guest\nRoom Number: 204\nMessage: ${sampleMsg}`);
  const qaInputTokens = await count(QA_SYSTEM, `Guest Name: Guest\nRoom Number: 204\nQuestion: What time is check-in?`);

  // Observed typical output size for these structured JSON responses.
  const typicalOutputTokens = 90;

  const classifierCost = (classifierInputTokens / 1e6) * PRICE.input + (typicalOutputTokens / 1e6) * PRICE.output;
  const qaCost = (qaInputTokens / 1e6) * PRICE.input + (typicalOutputTokens / 1e6) * PRICE.output;

  console.log(`Classifier call:  ~${classifierInputTokens} input tokens  ->  $${classifierCost.toFixed(5)}`);
  console.log(`Q&A call:         ~${qaInputTokens} input tokens  ->  $${qaCost.toFixed(5)}`);
  console.log(`\nRequest / clarification / sensitive message (1 call):  ~$${classifierCost.toFixed(5)}`);
  console.log(`Question message (2 calls: classifier + Q&A):           ~$${(classifierCost + qaCost).toFixed(5)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
