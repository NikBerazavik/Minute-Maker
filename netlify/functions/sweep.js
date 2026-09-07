import { findSweepablePages } from "../../lib/notion.js";
import { triggerPromotions } from "../../lib/promote.js";
import { sendMessage } from "../../lib/telegram.js";

// ---------------------------------------------------------------------------
// Weekly safety net — Friday 17:00 Bangkok, which is 10:00 UTC (Netlify cron
// runs in UTC). Has zero effect on anything already answered: it only picks up
// meetings still Pending, or stuck in Processing past the stale threshold.
//
// Scheduled functions get 30 seconds, so this only TRIGGERS promotions — each
// one runs in its own background invocation via /promote.
// ---------------------------------------------------------------------------

export default async () => {
  try {
    const pending = await findSweepablePages({ includeFailed: false, limit: 20 });
    if (pending.length === 0) {
      console.log("Sweep: nothing pending.");
      return new Response(null, { status: 200 });
    }

    const { triggered } = await triggerPromotions(pending);
    console.log(`Sweep triggered ${triggered.length} of ${pending.length} promotion(s).`);
    if (triggered.length > 0) {
      await sendMessage(
        `Weekly sweep: ${triggered.length} meeting(s) were still waiting on a Yes/No, so I'm recapping them now.`
      ).catch(() => {});
    }
  } catch (err) {
    console.error("Sweep failed:", err);
    await sendMessage(`Weekly sweep failed: ${err.message}`).catch(() => {});
  }

  return new Response(null, { status: 200 });
};

export const config = { schedule: "0 10 * * 5" };
