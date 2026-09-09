import crypto from "node:crypto";
import { config as app } from "../../lib/config.js";
import { promoteMeeting } from "../../lib/promote.js";
import { completeNotes } from "../../lib/notes.js";

// ---------------------------------------------------------------------------
// Runs one meeting's promotion in its own invocation, so the scheduled sweep
// (30-second ceiling) only has to TRIGGER work rather than perform it. A week
// of ignored prompts therefore fans out into N independent 15-minute
// background runs instead of one that blows the sweep's limit.
//
// This URL is public, so it carries its own shared secret.
// ---------------------------------------------------------------------------

function secretMatches(header) {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(app.internalSecret());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async (req) => {
  const accepted = new Response(null, { status: 202 });

  if (req.method !== "POST") return accepted;

  try {
    // Inside the try: secretMatches() reads an env var that can throw, and a
    // throw out of a background function makes Netlify re-run it.
    if (!secretMatches(req.headers.get("x-internal-secret"))) {
      console.warn("Rejected /promote call with a bad or missing internal secret.");
      return accepted;
    }

    const { page_id, allow_failed, mode, tier, backstop } = await req.json();
    if (!page_id) {
      console.warn("/promote called with no page_id.");
      return accepted;
    }
    // Both of these handle their own failures and never throw, which matters
    // here: a thrown error would make Netlify retry the whole run twice more.
    //
    // mode "notes" is the zero-model path — meeting.summarized and the sweep's
    // 24-hour backstop both arrive here. Anything else is an LLM tier; an
    // absent tier resolves to the default (Haiku), which is what both sweeps
    // send.
    if (mode === "notes") {
      await completeNotes(page_id, { backstop: Boolean(backstop) });
    } else {
      await promoteMeeting(page_id, { allowFailed: Boolean(allow_failed), tier });
    }
  } catch (err) {
    console.error("/promote failed:", err);
  }

  return accepted;
};

export const config = { path: "/promote", background: true };
