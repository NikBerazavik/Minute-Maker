// ---------------------------------------------------------------------------
// Signs a Fireflies-shaped webhook body so you can exercise the endpoint
// locally without waiting for a real meeting.
//
//   npm run sign -- <meeting_id>                     meeting.transcribed
//   npm run sign -- <meeting_id> meeting.summarized  the Instant completion event
//   npm run sign -- <meeting_id> <url>               target a specific base URL
//   npm run sign -- <meeting_id> <event> <url>       both
//
// Default target is the `netlify dev` address. Being able to fire
// meeting.summarized by hand is what makes the Instant tier testable before
// (or without) subscribing that event in the Fireflies dashboard.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
if (!secret) {
  console.error("FIREFLIES_WEBHOOK_SECRET is not set.");
  process.exit(1);
}

const meetingId = process.argv[2];
if (!meetingId) {
  console.error("Usage: npm run sign -- <meeting_id> [meeting.transcribed|meeting.summarized] [base_url]");
  process.exit(1);
}
// argv[3] is either the event or the base URL — a URL is unmistakable, so
// detect rather than forcing a fixed argument order on an existing command.
const rest = process.argv.slice(3).filter(Boolean);
const urlArg = rest.find((a) => /^https?:\/\//.test(a));
const eventArg = rest.find((a) => a !== urlArg);

const EVENTS = ["meeting.transcribed", "meeting.summarized"];
const event = eventArg || EVENTS[0];
if (!EVENTS.includes(event)) {
  console.error(`Unknown event "${event}". Expected one of: ${EVENTS.join(", ")}`);
  process.exit(1);
}
const base = (urlArg || "http://localhost:8888").replace(/\/$/, "");

const body = JSON.stringify({
  event,
  timestamp: Date.now(),
  meeting_id: meetingId,
  // Fireflies omits client_reference_id on meeting.summarized; mirror that so
  // the fake payload cannot pass where a real one would fail.
  ...(event === "meeting.transcribed" ? { client_reference_id: null } : {}),
});
const signature = `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

console.log(`curl -i -X POST ${base}/fireflies \\
  -H 'Content-Type: application/json' \\
  -H 'X-Hub-Signature: ${signature}' \\
  -d '${body}'`);
console.log(`
To confirm the signature check works, run it again with one character of the
signature changed — it must come back 401.`);
