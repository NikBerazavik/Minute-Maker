import { config as app } from "../../lib/config.js";
import { findSweepablePages, findStaleNotesStubs } from "../../lib/notion.js";
import { triggerPromotions, formatUnsummarised } from "../../lib/promote.js";
import { sendMessage } from "../../lib/telegram.js";

// ---------------------------------------------------------------------------
// Twice-weekly reminder — Tuesday and Friday 22:00 Bangkok, which is 15:00
// UTC (Netlify cron runs in UTC).
//
// Two passes:
//   1. REPORT meetings still waiting on a recap. It never calls a model: the
//      recap is yours to run on your subscription, so this only tells you which
//      meetings are outstanding. (Pages claimed for the Notes tier are excluded
//      at the query level — they are already being handled.)
//   2. The Notes backstop: a stub claimed more than notesBackstopHours ago
//      whose meeting.summarized never arrived. Either Fireflies has the summary
//      by now, or nothing is coming and the page must stop claiming to be in
//      progress — completeNotes({ backstop: true }) decides which. Zero model.
//
// Scheduled functions get 30 seconds, so the backstop only TRIGGERS work — each
// stub runs in its own background invocation via /promote.
// ---------------------------------------------------------------------------

export default async () => {
  try {
    const pending = await findSweepablePages({ includeFailed: true, limit: 20 });
    if (pending.length > 0) {
      console.log(`Sweep: ${pending.length} meeting(s) not summarised.`);
      await sendMessage(formatUnsummarised(pending));
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
