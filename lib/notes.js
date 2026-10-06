import { config, resolveTier } from "./config.js";
import { getMeeting, patchMeeting, replaceBody, CLEAR } from "./notion.js";
import { getSummary, FirefliesError } from "./fireflies.js";
import { renderNotesBlocks } from "./render.js";
import { eligibility, fail } from "./promote.js";
import { sendMessage } from "./telegram.js";
import { epochToLocalIso } from "./dates.js";

// ---------------------------------------------------------------------------
// The Notes tier: Fireflies' own summary, rendered into the same page shape an
// LLM recap produces, with no model call at all.
//
// Three different triggers reach the completion path for one meeting — a tap
// that found the summary already there, the meeting.summarized webhook, and the
// 24-hour backstop in the sweep — so completion lives in ONE function with the
// state guard at the top, exactly like promoteMeeting.
//
// Like promoteMeeting, nothing here throws. Its callers are background
// functions and a synchronous webhook; a thrown error would make Netlify retry
// the whole invocation, or cost Fireflies its delivery acknowledgement.
// ---------------------------------------------------------------------------

const TIER = resolveTier("notes");

/** Fireflies gives several summary fields; take the first that has content. */
function pickContent(summary) {
  const first = (...keys) => keys.map((k) => String(summary?.[k] ?? "").trim()).find(Boolean) || "";
  return {
    // short_summary is the prose one. `overview` is a bold-bullet list on this
    // account, so it is a fallback rather than the first choice.
    summary: first("short_summary", "overview", "gist"),
    actionItems: first("action_items"),
    // The structured "## Topic + bullets" recap, whose GraphQL name differs by
    // schema version — lib/fireflies.js asks for every spelling it might have.
    notes: first("notes", "outline", "shorthand_bullet"),
  };
}

async function readMeeting(pageId) {
  try {
    return { meeting: await getMeeting(pageId) };
  } catch (err) {
    console.error(`Could not read meeting page ${pageId}:`, err.message);
    return { error: `Notion page unreadable: ${err.message}` };
  }
}

/** One Fireflies summary fetch, with the tier's failure vocabulary. */
async function fetchSummary(meeting) {
  try {
    return { result: await getSummary(meeting.source_meeting_id) };
  } catch (err) {
    if (err instanceof FirefliesError && err.isNotFound) {
      return { error: "the transcript is no longer in Fireflies, so it cannot be recovered" };
    }
    if (err instanceof FirefliesError && err.isRateLimited) {
      // Not a failure: the claim stays and the backstop will try again later.
      return { retryable: true, error: "Fireflies is rate limiting me" };
    }
    return { error: `fetching the summary failed: ${err.message}` };
  }
}

/**
 * The shared completion write. Body first, Status = Done last — the same
 * ordering promoteMeeting uses, so a half-write leaves a page that a re-run
 * replaces rather than appends to.
 */
async function writeNotes(meeting, fetched, blocks, { notify }) {
  try {
    await replaceBody(meeting.page_id, blocks);
    await patchMeeting(meeting.page_id, {
      name: fetched.title || meeting.name,
      dateIso: fetched.date ? epochToLocalIso(fetched.date) : undefined,
      status: config.status.done,
      extractedBy: TIER.extractedBy,
      extractionState: CLEAR,
    });
  } catch (err) {
    return fail(meeting, `writing the notes to Notion failed: ${err.message}`);
  }

  const title = fetched.title || meeting.name;
  console.log(`Notes-recapped ${meeting.page_id} ("${title}") with ${blocks.length} blocks, no model call.`);
  if (notify) {
    await sendMessage(
      `Recap saved (${TIER.label}): ${title}${meeting.url ? `\n${meeting.url}` : ""}`
    ).catch(() => {});
  }
  return { promoted: true, title, tier: TIER.key, blocks: blocks.length, meeting };
}

/**
 * The Notes button.
 *
 * Claims the page BEFORE querying Fireflies. That costs one extra Notion write
 * on the happy path and closes the race where meeting.summarized arrives while
 * this handler is still running: the event finds the claim and, if this call
 * then completes the page, the completion guard stops the second one.
 */
export async function notesRecap(pageId, { notify = true } = {}) {
  const { meeting, error } = await readMeeting(pageId);
  if (error) return { promoted: false, failed: true, reason: error };

  const check = eligibility(meeting, { intent: "notes" });
  if (!check.ok) {
    console.log(`Skipping ${pageId}: ${check.reason}`);
    return { promoted: false, skipped: true, reason: check.reason, meeting };
  }
  if (!meeting.source_meeting_id) {
    return fail(meeting, "the page has no Source Meeting ID, so there is no summary to fetch");
  }

  try {
    await patchMeeting(meeting.page_id, {
      status: config.status.processing,
      extractionState: config.extractionState.pendingNotes,
    });
  } catch (err) {
    return fail(meeting, `could not claim the page: ${err.message}`);
  }

  const fetched = await fetchSummary(meeting);
  if (fetched.error) {
    // A rate limit leaves the claim in place: the backstop retries it, and
    // failing the page over a temporary limit would throw away the claim.
    if (fetched.retryable) return { promoted: false, waiting: true, reason: fetched.error, meeting };
    return fail(meeting, fetched.error);
  }

  const blocks = renderNotesBlocks(pickContent(fetched.result.summary));
  if (blocks.length === 0) {
    console.log(`Meeting ${meeting.source_meeting_id} has no summary yet; page ${pageId} is claimed and waiting.`);
    return { promoted: false, waiting: true, meeting };
  }
  return writeNotes(meeting, fetched.result, blocks, { notify });
}

/**
 * Completes a page a Notes tap already claimed. Reached by meeting.summarized
 * and by the sweep's backstop; never by a tap.
 *
 * `backstop` is the difference between "not ready yet, leave it claimed" and
 * "time is up": only the backstop is allowed to give up on a page.
 */
export async function completeNotes(pageId, { notify = true, backstop = false } = {}) {
  const { meeting, error } = await readMeeting(pageId);
  if (error) return { promoted: false, failed: true, reason: error };

  const check = eligibility(meeting, { intent: "complete-notes" });
  if (!check.ok) {
    console.log(`Not completing ${pageId}: ${check.reason}`);
    return { promoted: false, skipped: true, reason: check.reason, meeting };
  }
  if (!meeting.source_meeting_id) {
    return fail(meeting, "the page has no Source Meeting ID, so there is no summary to fetch");
  }

  const fetched = await fetchSummary(meeting);
  if (fetched.error) {
    if (fetched.retryable && !backstop) {
      return { promoted: false, waiting: true, reason: fetched.error, meeting };
    }
    return fail(meeting, fetched.error);
  }

  const blocks = renderNotesBlocks(pickContent(fetched.result.summary));
  if (blocks.length === 0) {
    if (!backstop) {
      console.log(`Summary for ${meeting.source_meeting_id} is still empty; leaving page ${pageId} claimed.`);
      return { promoted: false, waiting: true, meeting };
    }
    // fail() releases the claim as well as setting Failed, which is what lets
    // /sweep list this page again.
    return fail(
      meeting,
      `Fireflies still has no summary after ${config.notesBackstopHours}h. ` +
        "Recap it in Claude or ChatGPT instead (/sweep lists what is outstanding)."
    );
  }
  return writeNotes(meeting, fetched.result, blocks, { notify });
}
