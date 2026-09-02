// ---------------------------------------------------------------------------
// Signs a Fireflies-shaped webhook body so you can exercise the endpoint
// locally without waiting for a real meeting.
//
//   npm run sign -- <meeting_id>            print a ready-to-paste curl
//   npm run sign -- <meeting_id> <url>      target a specific base URL
//
// Default target is the `netlify dev` address.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
if (!secret) {
  console.error("FIREFLIES_WEBHOOK_SECRET is not set.");
  process.exit(1);
}

const meetingId = process.argv[2];
if (!meetingId) {
  console.error("Usage: npm run sign -- <meeting_id> [base_url]");
  process.exit(1);
}
const base = (process.argv[3] || "http://localhost:8888").replace(/\/$/, "");

const body = JSON.stringify({
  event: "meeting.transcribed",
  timestamp: Date.now(),
  meeting_id: meetingId,
  client_reference_id: null,
});
const signature = `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

console.log(`curl -i -X POST ${base}/fireflies \\
  -H 'Content-Type: application/json' \\
  -H 'X-Hub-Signature: ${signature}' \\
  -d '${body}'`);
console.log(`
To confirm the signature check works, run it again with one character of the
signature changed — it must come back 401.`);
