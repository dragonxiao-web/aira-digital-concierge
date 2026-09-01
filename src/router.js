const { classify } = require("./classifier");
const { answerQuestion } = require("./qa");
const { notifyStaff } = require("./slack");
const { findOpenDuplicate, createTicket } = require("./tickets");
const { sensitiveTemplate, requestTemplate, CLARIFICATION_TEMPLATE } = require("./templates");

// Known gap noted in the spec: room_number is only captured structurally if
// the guest fills the optional field. This regex fallback pulls a plausible
// room number out of free text when the field was left blank, e.g.
// "room 214" or "room #305". It never overrides a room number the guest
// actually supplied.
function extractRoomNumberFallback(message) {
  const match = message.match(/room\s*#?\s*(\d{2,4})/i);
  return match ? match[1] : "";
}

// Router logic (Section 4). Evaluated in this exact order — first match
// wins. "sensitive" is checked independent of and prior to intent_type,
// so a mixed message ("AC is broken AND I want a refund") always routes
// as sensitive, never as a routine request.
async function routeGuestMessage({ guestMessage, sessionId, channel, guestName, roomNumber }) {
  const resolvedRoomNumber = roomNumber || extractRoomNumberFallback(guestMessage);

  const classification = await classify({
    guestName,
    roomNumber: resolvedRoomNumber,
    guestMessage,
  });

  if (classification.sensitive === true) {
    const ticket = createTicket({
      guestName,
      roomNumber: resolvedRoomNumber,
      guestMessage,
      category: classification.category,
      sensitive: true,
      confidence: classification.confidence,
      status: "pending_human_review",
      channel,
      sessionId,
    });

    await notifyStaff(ticket, "sensitive");

    return { answer: sensitiveTemplate(ticket.ticket_id), answered: true };
  }

  if (classification.intent_type === "clarification_needed") {
    return { answer: CLARIFICATION_TEMPLATE, answered: true };
  }

  if (classification.intent_type === "request") {
    const existing = findOpenDuplicate(sessionId, guestMessage);
    if (existing) {
      return { answer: requestTemplate(existing.ticket_id), answered: true };
    }

    const ticket = createTicket({
      guestName,
      roomNumber: resolvedRoomNumber,
      guestMessage,
      category: classification.category,
      sensitive: false,
      confidence: classification.confidence,
      status: "open",
      channel,
      sessionId,
    });

    await notifyStaff(ticket, "request");

    return { answer: requestTemplate(ticket.ticket_id), answered: true };
  }

  // classification.intent_type === "question"
  return answerQuestion({
    guestName,
    roomNumber: resolvedRoomNumber,
    guestMessage,
    sessionId,
    channel,
  });
}

module.exports = { routeGuestMessage };
