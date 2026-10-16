import crypto from "node:crypto";
import { config as app } from "../../lib/config.js";
import { promoteMeeting } from "../../lib/promote.js";
import { completeNotes } from "../../lib/notes.js";

// ---------------------------------------------------------------------------
// Runs one meeting's work in its own invocation, so callers with a short
// ceiling — the meeting.summarized webhook (10 seconds) and the sweep's Notes
// backstop (30 seconds) — only have to TRIGGER it rather than perform it.
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

    const { page_id, mode, tier, backstop } = await req.json();
    if (!page_id) {
      console.warn("/promote called with no page_id.");
      return accepted;
    }
    // Both of these handle their own failures and never throw, which matters
    // here: a thrown error would make Netlify retry the whole run twice more.
    //
    // mode "notes" is the zero-model path — meeting.summarized and the sweep's
    // 24-hour backstop both arrive here, and nothing else calls this today.
    // Anything else is an LLM tier; an absent tier resolves to the default.
    if (mode === "notes") {
      await completeNotes(page_id, { backstop: Boolean(backstop) });
    } else {
      await promoteMeeting(page_id, { tier });
    }
  } catch (err) {
    console.error("/promote failed:", err);
  }

  return accepted;
};

export const config = { path: "/promote", background: true };
