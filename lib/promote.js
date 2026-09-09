import { config, resolveTier } from "./config.js";
import { getMeeting, patchMeeting, replaceBody, CLEAR } from "./notion.js";
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

/**
 * Why this meeting is (or is not) eligible. The single definition of "already
 * handled" for every tier — extended rather than duplicated for the Notes tier
 * so the two paths cannot drift apart on what "done" means.
 *
 * `intent`:
 *   "extract"        an LLM tier (Haiku/Sonnet), or the sweep
 *   "notes"          a Notes tap, which is about to query Fireflies
 *   "complete-notes" finishing a page that a Notes tap already claimed
 */
export function eligibility(meeting, { allowFailed = false, intent = "extract" } = {}) {
  const s = meeting.status;
  const claimed = meeting.extraction_state === config.extractionState.pendingNotes;

  if (s === config.status.done) return { ok: false, reason: "already has a recap" };
  if (s === config.status.skipped) return { ok: false, reason: "was skipped" };

  // The one intent that WANTS a claimed page. Requiring the claim to still be
  // there is what makes a late or redelivered meeting.summarized safe: if an
  // LLM tier took the page over, or the backstop already gave up on it, the
  // claim is gone and this no-ops instead of overwriting a finished recap.
  if (intent === "complete-notes") {
    return claimed ? { ok: true } : { ok: false, reason: "is no longer waiting on Fireflies' notes" };
  }

  if (s === config.status.failed) {
    return allowFailed ? { ok: true } : { ok: false, reason: "failed earlier — run /sweep to retry" };
  }

  if (claimed) {
    // A second Notes tap must not re-ask Fireflies for a summary we already
    // know is not ready — that is a wasted request against a 50/day quota.
    // An LLM tap, though, is an explicit decision to stop waiting, and takes
    // the page over: the claim is cleared as it starts. Without that escape
    // hatch a stub whose meeting.summarized never arrives is stuck for a day.
    return intent === "notes"
      ? { ok: false, reason: "is already waiting on Fireflies' notes" }
      : { ok: true };
  }

  if (s === config.status.processing) {
    return isStaleProcessing(meeting)
      ? { ok: true }
      : { ok: false, reason: "is already being processed" };
  }
  return { ok: true }; // Pending, or a page created by hand with no status yet
}

/**
 * Exported because the Notes path fails for the same reasons and must fail the
 * same way. Clearing Extraction State alongside Failed is load-bearing: a page
 * left both Failed AND claimed is invisible to findSweepablePages, which now
 * excludes claimed pages — so it would never be retried by anything, ever.
 */
export async function fail(meeting, message) {
  console.error(`Promotion failed for ${meeting.page_id}: ${message}`);
  try {
    await patchMeeting(meeting.page_id, { status: config.status.failed, extractionState: CLEAR });
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
 * @param {string}  options.tier         extraction tier key; defaults to the
 *                                       first tier in config (Haiku), which is
 *                                       what both sweep paths get.
 */
export async function promoteMeeting(pageId, { allowFailed = false, notify = true, tier } = {}) {
  const t = resolveTier(tier);
  // LLM_EXTRACT_MODEL stays a hard override across both LLM tiers — the
  // pre-tier escape hatch, kept so an urgent "put everything on model X" needs
  // no deploy. Read from the environment rather than config.llm.extractModel(),
  // which falls back to config.llm.model and would silently override the tier
  // with the CHAT model whenever LLM_EXTRACT_MODEL is unset.
  const model = process.env.LLM_EXTRACT_MODEL || t.model;
  let meeting;
  try {
    meeting = await getMeeting(pageId);
  } catch (err) {
    console.error(`Could not read meeting page ${pageId}:`, err.message);
    return { promoted: false, failed: true, reason: `Notion page unreadable: ${err.message}` };
  }

  const check = eligibility(meeting, { allowFailed, intent: "extract" });
  if (!check.ok) {
    console.log(`Skipping ${pageId}: ${check.reason}`);
    return { promoted: false, skipped: true, reason: check.reason, meeting };
  }

  if (!meeting.source_meeting_id) {
    return fail(meeting, "the page has no Source Meeting ID, so there is no transcript to fetch");
  }

  // Claim the page before doing anything slow. The window between the read
  // above and this write is the only race left, and the remaining triggers
  // (a tier tap, whose keyboard is removed first, and the sweep, which only
  // picks up Pending or long-stale pages) make overlapping in it unlikely.
  try {
    // Clearing Extraction State in the SAME write that claims the page is what
    // makes an LLM tier able to take over a stub that was waiting on Fireflies:
    // a meeting.summarized landing mid-run then finds no claim and no-ops.
    await patchMeeting(meeting.page_id, {
      status: config.status.processing,
      extractionState: CLEAR,
    });
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
    blocks = renderBlocks(await extractMeeting(transcript, { model, thinking: t.thinking }));
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
      extractedBy: t.extractedBy ?? model,
      extractionState: CLEAR,
    });
  } catch (err) {
    return fail(meeting, `writing the recap to Notion failed: ${err.message}`);
  }

  const title = transcript.title || meeting.name;
  console.log(`Promoted ${meeting.page_id} ("${title}") on ${model} with ${blocks.length} blocks.`);
  if (notify) {
    await sendMessage(`Recap saved (${t.label}): ${title}${meeting.url ? `\n${meeting.url}` : ""}`).catch(() => {});
  }
  return { promoted: true, title, tier: t.key, model, blocks: blocks.length, meeting };
}

/**
 * Fires each promotion as its own /promote invocation and returns how many
 * were accepted. Both sweep paths use this rather than looping the work
 * inline: the scheduled function only gets 30 seconds, and even the 15-minute
 * background budget behind /sweep would not cover 20 transcripts back to back.
 * Each triggered run reports its own result to Telegram when it finishes.
 */
export async function triggerPromotions(pages, { allowFailed = false, mode, tier, backstop } = {}) {
  const url = `${config.siteUrl().replace(/\/$/, "")}/promote`;
  const triggered = [];
  const failed = [];
  for (const page of pages) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": config.internalSecret() },
        body: JSON.stringify({ page_id: page.page_id, allow_failed: allowFailed, mode, tier, backstop }),
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

/** The Skip path: keep the page as a record that the meeting happened. */
export async function skipMeeting(pageId) {
  const meeting = await getMeeting(pageId);
  if (meeting.status === config.status.done) {
    return { skipped: false, reason: "already has a recap" };
  }
  await replaceBody(pageId, [paragraph(config.text.skipped)]);
  // Skipped is terminal, so it releases a Notes claim like every other terminal
  // write. Leaving the claim would make findStaleNotesStubs return this page on
  // every sweep from now until the end of time, each one spending a /promote
  // invocation to discover it is skipped.
  await patchMeeting(pageId, { status: config.status.skipped, extractionState: CLEAR });
  return { skipped: true, meeting };
}
