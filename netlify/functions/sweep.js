import { config as app } from "../../lib/config.js";
import { findSweepablePages, findStaleNotesStubs } from "../../lib/notion.js";
import { triggerPromotions } from "../../lib/promote.js";
import { sendMessage } from "../../lib/telegram.js";

// ---------------------------------------------------------------------------
// Twice-weekly safety net — Tuesday and Friday 22:00 Bangkok, which is 15:00
// UTC (Netlify cron runs in UTC). Has zero effect on anything already
// answered: it only picks up meetings still Pending, or stuck in Processing
// past the stale threshold.
//
// Two passes:
//   1. Promote anything still waiting on an answer, using the DEFAULT tier
//      (Haiku) — nobody chose, so the cheap model is the right default.
//      Pages claimed for the Notes tier are excluded at the query level, or the
//      sweep would hand a meeting waiting on a free recap a paid one instead.
//   2. The Notes backstop: a stub claimed more than notesBackstopHours ago
//      whose meeting.summarized never arrived. Either Fireflies has the summary
//      by now, or nothing is coming and the page must stop claiming to be in
//      progress — completeNotes({ backstop: true }) decides which.
//
// Scheduled functions get 30 seconds, so this only TRIGGERS work — every item
// in both passes runs in its own background invocation via /promote.
// ---------------------------------------------------------------------------

export default async () => {
  try {
    const pending = await findSweepablePages({ includeFailed: false, limit: 20 });
    if (pending.length > 0) {
      const { triggered } = await triggerPromotions(pending);
      console.log(`Sweep triggered ${triggered.length} of ${pending.length} promotion(s).`);
      if (triggered.length > 0) {
        await sendMessage(
          `Sweep: ${triggered.length} meeting(s) were still waiting on an answer, ` +
            `so I'm recapping them now with ${app.extractTiers[0].label}.`
        ).catch(() => {});
      }
    } else {
      console.log("Sweep: nothing pending.");
    }

    const stranded = await findStaleNotesStubs({ olderThanHours: app.notesBackstopHours, limit: 20 });
    if (stranded.length > 0) {
      const { triggered } = await triggerPromotions(stranded, { mode: "notes", backstop: true });
      console.log(`Sweep triggered the Notes backstop for ${triggered.length} of ${stranded.length} stub(s).`);
    }
  } catch (err) {
    console.error("Sweep failed:", err);
    await sendMessage(`Sweep failed: ${err.message}`).catch(() => {});
  }

  return new Response(null, { status: 200 });
};

// Tue + Fri 22:00 Bangkok. Worst-case wait for a stranded meeting drops from
// about 7 days to about 3 and a half.
export const config = { schedule: "0 15 * * 2,5" };
