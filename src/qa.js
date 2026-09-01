const fs = require("fs");
const path = require("path");
const db = require("./db");
const { askForJson } = require("./claudeClient");

const KB_PATH = path.join(__dirname, "..", "data", "knowledge-base.json");
const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf8"));

const aggregatedKbText = kb
  .map((row) => `Category: ${row.category}\nQ: ${row.question}\nA: ${row.answer}`)
  .join("\n\n");

const SYSTEM_PROMPT = `You are a hotel Q&A assistant. A guest has asked a question. Answer using ONLY the hotel information provided below. Do not guess, invent, or assume information beyond what's given.

HOTEL KNOWLEDGE BASE:
${aggregatedKbText}

Output ONLY the following JSON object. No markdown formatting, no backticks, no text before or after.
{
  "answer": "your answer here, max 3 sentences, friendly and professional tone",
  "answered": true or false
}

Rules:
- Set "answered": true only if the knowledge base above contains information that answers the question
- Set "answered": false and leave "answer" as an empty string if the knowledge base doesn't cover this question — do not guess or use outside knowledge
- Keep tone warm but professional, matching a hotel front-desk assistant`;

function logUnanswered({ guestName, roomNumber, question, sessionId, channel }) {
  db.prepare(
    `INSERT INTO unanswered_questions (guest_name, room_number, question, session_id, channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(guestName, roomNumber, question, sessionId, channel, new Date().toISOString());
}

async function answerQuestion({ guestName, roomNumber, guestMessage, sessionId, channel }) {
  const user = `Guest Name: ${guestName}
Room Number: ${roomNumber}
Question: ${guestMessage}`;

  const result = await askForJson({ system: SYSTEM_PROMPT, user });

  const answered = result && result.answered === true;
  const answer = answered && typeof result.answer === "string" ? result.answer : "";

  if (!answered) {
    // Known gap fixed per spec Section 7: every unanswered question is logged
    // so the KB can be expanded over time instead of silently evaporating.
    logUnanswered({ guestName, roomNumber, question: guestMessage, sessionId, channel });
  }

  return { answer, answered };
}

module.exports = { answerQuestion, kb };
