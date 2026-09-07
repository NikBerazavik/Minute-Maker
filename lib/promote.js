import { config } from "./config.js";
import { getMeeting, setStatus, patchMeeting, replaceBody } from "./notion.js";
import { getTranscript, FirefliesError } from "./fireflies.js";
import { extractMeeting } from "./extract.js";
import { renderBlocks, paragraph } from "./render.js";
import { sendMessage } from "./telegram.js";
import { epochToLocalIso } from "./dates.js";

// ---------------------------------------------------------------------------
// The single shared "promote if still pending" function.
//
// Four different triggers can reach it for the same meeting — a Yes tap, the
// Friday sweep, /sweep, and a redelivered Fireflies webhook — so the guard at
// the top is what keeps a meeting from being processed twice.
//
// This function never throws. Every failure path ends with Status = Failed and
// a Telegram alert naming the meeting, because its callers are background
// functions where a thrown error triggers Netlify's own retry (twice, at 1 and
// 2 minutes) and would re-run the whole extraction.
// ---------------------------------------------------------------------------

function isStaleProcessing(meeting) {
  if (meeting.status !== config.status.processing) return false;
  if (!meeting.last_edited_time) return true;
  const age = Date.now() - new Date(meeting.last_edited_time).getTime();
  return age > config.staleProcessingMinutes * 60 * 1000;
}

/** Why this meeting is (or is not) eligible. Exported for the callers' messaging. */
export function eligibility(meeting, { allowFailed = false } = {}) {
  const s = meeting.status;
  if (s === config.status.done) return { ok: false, reason: "already has a recap" };
  if (s === config.status.skipped) return { ok: false, reason: "was skipped" };
  if (s === config.status.failed) {
    return allowFailed ? { ok: true } : { ok: false, reason: "failed earlier — run /sweep to retry" };
  }
  if (s === config.status.processing) {
    return isStaleProcessing(meeting)
      ? { ok: true }
      : { ok: false, reason: "is already being processed" };
  }
  return { ok: true }; // Pending, or a page created by hand with no status yet
}

async function fail(meeting, message) {
  console.error(`Promotion failed for ${meeting.page_id}: ${message}`);
  try {
    await setStatus(meeting.page_id, config.status.failed);
  } catch (err) {
    console.error("Could not even set Failed status:", err.message);
  }
  await sendMessage(`Recap failed for "${meeting.name}": ${message}`).catch(() => {});
  return { promoted: false, failed: true, reason: message };
}

/**
 * @param {string} pageId       Notion page id of the meeting
 * @param {object} options
 * @param {boolean} options.allowFailed  retry a page that previously failed (/sweep)
 * @param {boolean} options.notify       send the success message (off for bulk runs)
 */
export async function promoteMeeting(pageId, { allowFailed = false, notify = true } = {}) {
  let meeting;
  try {
    meeting = await getMeeting(pageId);
  } catch (err) {
    console.error(`Could not read meeting page ${pageId}:`, err.message);
    return { promoted: false, failed: true, reason: `Notion page unreadable: ${err.message}` };
  }

  const check = eligibility(meeting, { allowFailed });
  if (!check.ok) {
    console.log(`Skipping ${pageId}: ${check.reason}`);
    return { promoted: false, skipped: true, reason: check.reason, meeting };
  }

  if (!meeting.source_meeting_id) {
    return fail(meeting, "the page has no Source Meeting ID, so there is no transcript to fetch");
  }

  // Claim the page before doing anything slow. The window between the read
  // above and this write is the only race left, and both remaining triggers
  // (a Yes tap, whose keyboard is removed first, and the sweep, which only
  // picks up Pending or long-stale pages) make overlapping in it unlikely.
  try {
    await setStatus(meeting.page_id, config.status.processing);
  } catch (err) {
    return fail(meeting, `could not mark the page as processing: ${err.message}`);
  }

  let transcript;
  try {
    transcript = await getTranscript(meeting.source_meeting_id);
  } catch (err) {
    if (err instanceof FirefliesError && err.isNotFound) {
      return fail(meeting, "the transcript is no longer in Fireflies, so it cannot be recovered");
    }
    return fail(meeting, `fetching the transcript failed: ${err.message}`);
  }

  let blocks;
  try {
    blocks = renderBlocks(await extractMeeting(transcript));
  } catch (err) {
    return fail(meeting, err.message);
  }

  try {
    // Body first, Status = Done last: if the append dies halfway, the page
    // stays Failed and a re-run replaces the partial body rather than
    // appending a second copy beneath it.
    await replaceBody(meeting.page_id, blocks);
    await patchMeeting(meeting.page_id, {
      name: transcript.title || meeting.name,
      dateIso: transcript.date ? epochToLocalIso(transcript.date) : undefined,
      status: config.status.done,
    });
  } catch (err) {
    return fail(meeting, `writing the recap to Notion failed: ${err.message}`);
  }

  const title = transcript.title || meeting.name;
  console.log(`Promoted ${meeting.page_id} ("${title}") with ${blocks.length} blocks.`);
  if (notify) {
    await sendMessage(`Recap saved: ${title}${meeting.url ? `\n${meeting.url}` : ""}`).catch(() => {});
  }
  return { promoted: true, title, blocks: blocks.length, meeting };
}

/**
 * Fires each promotion as its own /promote invocation and returns how many
 * were accepted. Both sweep paths use this rather than looping the work
 * inline: the scheduled function only gets 30 seconds, and even the 15-minute
 * background budget behind /sweep would not cover 20 transcripts back to back.
 * Each triggered run reports its own result to Telegram when it finishes.
 */
export async function triggerPromotions(pages, { allowFailed = false } = {}) {
  const url = `${config.siteUrl().replace(/\/$/, "")}/promote`;
  const triggered = [];
  const failed = [];
  for (const page of pages) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": config.internalSecret() },
        body: JSON.stringify({ page_id: page.page_id, allow_failed: allowFailed }),
      });
      if (res.ok || res.status === 202) triggered.push(page);
      else {
        console.error(`Triggering ${page.page_id} returned ${res.status}.`);
        failed.push(page);
      }
    } catch (err) {
      console.error(`Could not trigger ${page.page_id}:`, err.message);
      failed.push(page);
    }
  }
  return { triggered, failed };
}

/** The No path: keep the page as a record that the meeting happened. */
export async function skipMeeting(pageId) {
  const meeting = await getMeeting(pageId);
  if (meeting.status === config.status.done) {
    return { skipped: false, reason: "already has a recap" };
  }
  await replaceBody(pageId, [paragraph(config.text.skipped)]);
  await setStatus(pageId, config.status.skipped);
  return { skipped: true, meeting };
}
