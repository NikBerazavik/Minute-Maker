import crypto from "node:crypto";
import { config as app } from "../../lib/config.js";
import { findMeetingByFirefliesId, createStubPage, findPendingNotes } from "../../lib/notion.js";
import { sendMessage, sendTierPrompt } from "../../lib/telegram.js";
import { usageLine, PROMPT_PROBE_TIMEOUT_MS } from "../../lib/usage.js";
import { getTitle } from "../../lib/fireflies.js";
import { triggerPromotions } from "../../lib/promote.js";
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

  // Two subscribed events. Anything else is acknowledged so Fireflies does not
  // retry an event we simply do not act on. The meeting_id check is hoisted
  // above the branch because both events need it.
  const { event } = payload;
  if (event !== "meeting.transcribed" && event !== "meeting.summarized") {
    console.log(`Ignoring Fireflies event "${event}".`);
    return Response.json({ ok: true, ignored: event });
  }

  const meetingId = payload.meeting_id;
  if (!meetingId) {
    console.warn(`${event} arrived with no meeting_id.`);
    return Response.json({ ok: true, ignored: "no meeting_id" });
  }

  try {
    if (event === "meeting.summarized") return await handleSummarized(meetingId);
    return await handleTranscribed(meetingId, payload);
  } catch (err) {
    console.error("Fireflies webhook failed:", err);
    await sendMessage(`Fireflies webhook failed for meeting ${meetingId}: ${err.message}`).catch(() => {});
    // A non-2xx here is deliberate: it asks Fireflies to redeliver. For
    // meeting.transcribed a redelivery is the only recovery path if the stub
    // page was never created, and for meeting.summarized it is the only way to
    // retry a Notion lookup that failed. Both arms are idempotent — the
    // duplicate check below and the claim guard in completeNotes — so a
    // redelivery cannot double anything.
    return new Response("Internal error", { status: 500 });
  }
};

async function handleTranscribed(meetingId, payload) {
  // Idempotency: a redelivery must not create a second page or re-prompt.
  const existing = await findMeetingByFirefliesId(meetingId);
  if (existing) {
    console.log(`Meeting ${meetingId} already has page ${existing.page_id} (${existing.status}).`);
    return Response.json({ ok: true, duplicate: true });
  }

  // The payload carries no title and no duration — only a transcription
  // timestamp — so the page is labelled by time until the real title arrives
  // with the transcript or the summary.
  const ts = Number(payload.timestamp) || Date.now();
  const label = timestampLabel(ts);
  const page = await createStubPage({ meetingId, label, dateIso: epochToLocalIso(ts) });

  // The storage reading rides along on the prompt: this is the one moment per
  // meeting when it is both fresh and actionable. The real title rides along
  // too, for the chat hand-off prompt. Both probes never throw and run in
  // PARALLEL, each timing out well inside Fireflies' 10-second acknowledgement
  // budget — the prompt goes out without the line, or with the timestamp label,
  // rather than the delivery failing. The page already exists by this point, so
  // even a slow probe cannot cost you it.
  const [extra, title] = await Promise.all([usageLine(), titleProbe(meetingId)]);
  await sendTierPrompt(meetingId, { label, title, extra });
  console.log(`Created stub page ${page.page_id} for meeting ${meetingId}.`);
  return Response.json({ ok: true, page_id: page.page_id });
}

/** The meeting's real title, or null on any failure — same contract as usageLine(). */
async function titleProbe(meetingId) {
  try {
    return await getTitle(meetingId, { timeoutMs: PROMPT_PROBE_TIMEOUT_MS });
  } catch (err) {
    console.warn(`Prompt goes out with the timestamp label instead of the title: ${err.message}`);
    return null;
  }
}

/**
 * Fireflies has finished summarising. Only interesting if a Notes tap claimed a
 * page and is waiting on exactly this — which is the minority case: once the
 * event is subscribed it fires for EVERY meeting, so the no-op below is the
 * common path and is kept to a single Notion query.
 *
 * Completion is not done inline. This function is synchronous against a
 * 10-second budget; it hands the work to /promote, the same background
 * function the sweep fans out to, and returns immediately.
 */
async function handleSummarized(meetingId) {
  const claimed = await findPendingNotes(meetingId);
  if (!claimed) {
    console.log(`meeting.summarized for ${meetingId}: no page is waiting on it.`);
    return Response.json({ ok: true, ignored: "nothing claimed" });
  }

  const { triggered } = await triggerPromotions([claimed], { mode: "notes" });
  console.log(`meeting.summarized for ${meetingId}: triggered completion of ${claimed.page_id}.`);
  return Response.json({ ok: true, page_id: claimed.page_id, triggered: triggered.length });
}

export const config = { path: "/fireflies" };
