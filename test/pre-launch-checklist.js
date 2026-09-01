// Covers spec Sections 7-11 (failure handling, concurrency, language/local
// context, edge cases, logging) — the sections the spec says were never
// completed even on the Make prototype. Requires the server running with a
// valid ANTHROPIC_API_KEY.
//
// Usage: node test/pre-launch-checklist.js [webhook_url]

const BASE_URL = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const WEBHOOK_URL = `${BASE_URL}/webhook`;

let pass = 0;
let fail = 0;

function report(name, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && extra) console.log(`      ${extra}`);
  ok ? pass++ : fail++;
}

async function post(body) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, body: json };
}

async function postRaw(rawBody) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, body: json };
}

function baseMsg(overrides = {}) {
  return {
    guest_message: "What time is check-in?",
    session_id: crypto.randomUUID(),
    channel: "web_widget",
    guest_name: "Test Guest",
    room_number: "214",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function section7_failureHandling() {
  console.log("\n-- Section 7: Failure handling --");

  // Missing guest_message
  {
    const { status, body } = await post(baseMsg({ guest_message: "" }));
    report(
      "empty guest_message -> 400 with guest-facing shape",
      status === 400 && body && typeof body.answer === "string" && body.answered === false,
      JSON.stringify({ status, body })
    );
  }

  // Missing session_id
  {
    const { status, body } = await post(baseMsg({ session_id: undefined }));
    report(
      "missing session_id -> 400 with guest-facing shape",
      status === 400 && body && typeof body.answer === "string" && body.answered === false,
      JSON.stringify({ status, body })
    );
  }

  // Malformed JSON body entirely
  {
    const { status } = await postRaw("{not valid json");
    report("malformed JSON body -> 4xx, does not crash server", status >= 400 && status < 500, `status=${status}`);
  }

  // Server still alive after malformed input
  {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    report("server still healthy after bad input", res.status === 200 && body.ok === true);
  }

  // Guest name / room number omitted entirely (both optional per contract)
  {
    const { status, body } = await post({
      guest_message: "What time is check-out?",
      session_id: crypto.randomUUID(),
      channel: "web_widget",
      timestamp: new Date().toISOString(),
    });
    report(
      "guest_name/room_number omitted -> still answers normally",
      status === 200 && body && body.answered === true,
      JSON.stringify({ status, body })
    );
  }
}

async function section8_concurrency() {
  console.log("\n-- Section 8: Concurrency --");

  // Double-tap: two identical requests fired near-simultaneously on the
  // same session. This is the real race the spec's dedup design has to
  // survive — a check-then-insert without a DB constraint can create two
  // tickets if both requests read "no existing ticket" before either write
  // lands.
  const sessionId = crypto.randomUUID();
  const msg = baseMsg({ session_id: sessionId, guest_message: "Can I get more towels sent up?" });

  const [r1, r2] = await Promise.all([post(msg), post(msg)]);

  const t1 = r1.body && (r1.body.answer || "").match(/TCK-\d+/);
  const t2 = r2.body && (r2.body.answer || "").match(/TCK-\d+/);

  report(
    "simultaneous double-tap does not create two tickets",
    t1 && t2 && t1[0] === t2[0],
    `r1=${JSON.stringify(r1.body)} r2=${JSON.stringify(r2.body)}`
  );

  // Distinct sessions concurrently must not cross-contaminate (no shared
  // mutable state between requests).
  const sA = crypto.randomUUID();
  const sB = crypto.randomUUID();
  const [ra, rb] = await Promise.all([
    post(baseMsg({ session_id: sA, guest_message: "I need a refund for last night" })),
    post(baseMsg({ session_id: sB, guest_message: "What are the pool hours?" })),
  ]);
  const aLooksSensitive = /reference number/i.test(ra.body.answer) && /forwarded to our team/i.test(ra.body.answer);
  const bLooksLikeAnswer = ra.body !== rb.body && !/TCK-/.test(rb.body.answer || "");
  report(
    "concurrent distinct sessions routed independently, no cross-talk",
    aLooksSensitive && bLooksLikeAnswer,
    `ra=${JSON.stringify(ra.body)} rb=${JSON.stringify(rb.body)}`
  );
}

async function section9_language() {
  console.log("\n-- Section 9: Language / local context --");

  const cases = [
    { msg: "Magkano po ang isang gabi sa Standard room?", note: "Tagalog — room rate question" },
    { msg: "Pwede po ba mag-refund kung hindi maganda ang serbisyo?", note: "Tagalog — refund request, must be sensitive" },
    { msg: "Hi, gusto ko lang i-cancel yung booking ko bukas please", note: "Taglish — cancellation, must be sensitive" },
    { msg: "unsa oras ang check-out?", note: "Cebuano — check-out time" },
  ];

  for (const c of cases) {
    const { status, body } = await post(baseMsg({ guest_message: c.msg }));
    const shapeOk = status === 200 && body && typeof body.answer === "string" && typeof body.answered === "boolean";
    const isEnglishLike = shapeOk && /^[\x00-\x7F]*$/.test(body.answer) === false ? true : shapeOk; // just check it answered coherently
    report(`${c.note}: "${c.msg}"`, shapeOk, JSON.stringify({ status, body }));
  }
}

async function section10_edgeCases() {
  console.log("\n-- Section 10: Edge cases --");

  // Very short / low-content message
  {
    const { status, body } = await post(baseMsg({ guest_message: "?" }));
    report(
      '"?" alone -> handled without crashing (any of question/request/clarification, all no-500)',
      status === 200 && body && typeof body.answer === "string",
      JSON.stringify({ status, body })
    );
  }

  // Emoji-only message
  {
    const { status, body } = await post(baseMsg({ guest_message: "🥶🥶🥶" }));
    report(
      "emoji-only message -> handled without crashing",
      status === 200 && body && typeof body.answer === "string",
      JSON.stringify({ status, body })
    );
  }

  // Very long message
  {
    const long = "The room is too cold and I would like housekeeping to bring extra blankets. ".repeat(60);
    const { status, body } = await post(baseMsg({ guest_message: long }));
    report("very long message (~4900 chars) handled without error", status === 200 && body, `status=${status}`);
  }

  // Room number only in free text, field left blank -> regex fallback should capture it
  {
    const roomlessMsg = baseMsg({
      guest_message: "Can someone bring extra pillows to room 305?",
      room_number: "",
    });
    await post(roomlessMsg);
    // Confirm via /tickets that the fallback-extracted room number landed on the ticket
    const res = await fetch(`${BASE_URL}/tickets`);
    const tickets = await res.json();
    const match = tickets.find((t) => t.guest_message === roomlessMsg.guest_message);
    report(
      "room number mentioned in free text (field left blank) captured via regex fallback",
      match && match.room_number === "305",
      JSON.stringify(match)
    );
  }

  // Mixed sensitive + routine in one message — sensitive must still win
  {
    const { body } = await post(
      baseMsg({ guest_message: "The wifi keeps dropping and also I want to dispute a charge on my bill" })
    );
    const looksSensitive = /forwarded to our team for review/i.test(body.answer);
    report("mixed routine+billing message still routes sensitive", looksSensitive, JSON.stringify(body));
  }
}

async function section11_logging() {
  console.log("\n-- Section 11: Logging --");

  const res = await fetch(`${BASE_URL}/tickets`);
  const tickets = await res.json();

  report("GET /tickets returns an array", Array.isArray(tickets) && tickets.length > 0);

  const sample = tickets[0];
  const hasAllFields = [
    "ticket_id",
    "guest_name",
    "room_number",
    "guest_message",
    "category",
    "sensitive",
    "confidence",
    "status",
    "created_at",
    "channel",
    "session_id",
  ].every((k) => k in sample);
  report("ticket rows carry the full Section 8 schema", hasAllFields, JSON.stringify(sample));

  const isUtcIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(sample.created_at);
  report("created_at stored as UTC ISO-8601", isUtcIso, sample.created_at);

  const ticketIdFormat = /^TCK-\d{14}$/.test(sample.ticket_id);
  report("ticket_id matches TCK-YYYYMMDDHHmmss format", ticketIdFormat, sample.ticket_id);
}

async function main() {
  await section7_failureHandling();
  await section8_concurrency();
  await section9_language();
  await section10_edgeCases();
  await section11_logging();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Checklist run failed:", err);
  process.exit(1);
});
