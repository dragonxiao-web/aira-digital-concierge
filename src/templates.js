// Every branch returns the same { answer, answered } shape (Section 5).
// None of these promise a timeframe the backend can't guarantee.

function sensitiveTemplate(ticketId) {
  return `Thank you for reaching out. Your message has been received and forwarded to our team for review. Your reference number is ${ticketId} — a staff member will follow up with you shortly. If you have any urgent concerns, please contact the front desk directly.`;
}

function requestTemplate(ticketId) {
  return `Thanks for letting us know! Your request has been received and our team has been notified. Your reference number is ${ticketId} — someone will take care of this shortly. Let us know if there's anything else you need.`;
}

// Deliberately generic — fires for a vague message on any topic, so it must
// never hardcode a specific subject like "booking".
const CLARIFICATION_TEMPLATE = "Happy to help! Could you tell me a bit more about what you need?";

module.exports = { sensitiveTemplate, requestTemplate, CLARIFICATION_TEMPLATE };
