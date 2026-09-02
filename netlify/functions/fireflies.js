import crypto from "node:crypto";
import { config as app } from "../../lib/config.js";
import { findMeetingByFirefliesId, createStubPage } from "../../lib/notion.js";
import { sendMessage, sendYesNoPrompt } from "../../lib/telegram.js";
import { timestampLabel, epochToLocalIso } from "../../lib/dates.js";

// ---------------------------------------------------------------------------
// Fireflies Webhooks V2 receiver.
//
// Synchronous on purpose: it has to be able to answer 401 on a bad signature,
// and Fireflies treats anything other than a 2xx within 10 seconds as a failed
// delivery. The work here is deliberately small — one Notion query, one Notion
// write, one Telegram send.
//
// (The app config is imported as `app` because Netlify reserves the name
// `config` for the function's own export, below.)
// ---------------------------------------------------------------------------

/** HMAC-SHA256 of the raw body, hex, prefixed "sha256=". */
export function verifySignature(rawBody, header, secret) {
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so check that first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  if (!verifySignature(rawBody, req.headers.get("x-hub-signature"), app.fireflies.webhookSecret())) {
    console.warn("Rejected Fireflies webhook with a bad or missing X-Hub-Signature.");
    return new Response("Invalid signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Malformed JSON", { status: 400 });
  }

  // Only meeting.transcribed is subscribed, but acknowledge anything else so
  // Fireflies does not retry an event we simply do not act on.
  if (payload.event !== "meeting.transcribed") {
    console.log(`Ignoring Fireflies event "${payload.event}".`);
    return Response.json({ ok: true, ignored: payload.event });
  }

  const meetingId = payload.meeting_id;
  if (!meetingId) {
    console.warn("meeting.transcribed arrived with no meeting_id.");
    return Response.json({ ok: true, ignored: "no meeting_id" });
  }

  try {
    // Idempotency: a redelivery must not create a second page or re-prompt.
    const existing = await findMeetingByFirefliesId(meetingId);
    if (existing) {
      console.log(`Meeting ${meetingId} already has page ${existing.page_id} (${existing.status}).`);
      return Response.json({ ok: true, duplicate: true });
    }

    // The payload carries no title and no duration — only a transcription
    // timestamp — so the page is labelled by time until the real title
    // arrives with the transcript on Yes.
    const ts = Number(payload.timestamp) || Date.now();
    const label = timestampLabel(ts);
    const page = await createStubPage({ meetingId, label, dateIso: epochToLocalIso(ts) });

    await sendYesNoPrompt(meetingId, label);
    console.log(`Created stub page ${page.page_id} for meeting ${meetingId}.`);
    return Response.json({ ok: true, page_id: page.page_id });
  } catch (err) {
    console.error("Fireflies webhook failed:", err);
    await sendMessage(`Fireflies webhook failed for meeting ${meetingId}: ${err.message}`).catch(() => {});
    // A non-2xx here is deliberate. If the stub page was never created there
    // is nothing for the sweep to find later, so a redelivery is the only
    // recovery path — and the idempotency check above makes it safe.
    return new Response("Internal error", { status: 500 });
  }
};

export const config = { path: "/fireflies" };
