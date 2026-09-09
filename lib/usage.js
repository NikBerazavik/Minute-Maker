import { config } from "./config.js";
import { getUsage, FirefliesError } from "./fireflies.js";

// ---------------------------------------------------------------------------
// The Fireflies storage meter, in one place.
//
// Two callers with very different tolerances for failure:
//   /space                     — asked for it, so an error is worth reporting
//   the meeting.transcribed prompt — nice to have, and running inside a
//                                synchronous webhook with a 10-second budget
//
// Sharing the arithmetic and the wording is the point: the "you are running
// out" warning must not appear in one place and not the other.
// ---------------------------------------------------------------------------

/** Timeout for the probe on the webhook path. Well inside Fireflies' 10s ack budget. */
export const PROMPT_PROBE_TIMEOUT_MS = 4000;

/** The numbers, derived once. `used` is minutes consumed against the plan cap. */
export function summarise(usage) {
  const cap = config.fireflies.minutesAllowance;
  const used = Math.round(usage.minutesConsumed);
  const left = Math.max(0, cap - used);
  return {
    cap,
    used,
    left,
    transcripts: usage.transcripts,
    // Floor, not round: 398 of 400 must never read "100%" next to "2 minutes left".
    percent: cap > 0 ? Math.floor((usage.minutesConsumed / cap) * 100) : 0,
    low: usage.minutesConsumed >= config.fireflies.minutesWarnAt,
  };
}

/** The shared "you are running low" paragraph, or [] when there is room left. */
export function warningLines(stats) {
  if (!stats.low) return [];
  return [
    "",
    `That is past the ${config.fireflies.minutesWarnAt}-minute mark — clear some transcripts in Fireflies soon.`,
    "Anything already recapped into Notion is safe to delete there.",
  ];
}

/** The full /space body. */
export function formatReport(usage) {
  const s = summarise(usage);
  return [
    `Fireflies storage: ${s.used} of ${s.cap} minutes used (${s.percent}%).`,
    `${s.left} minutes left, across ${s.transcripts} transcript(s).`,
    ...warningLines(s),
  ].join("\n");
}

/** The one-liner appended to the transcribed prompt, leading with what is LEFT. */
export function formatLine(usage) {
  const s = summarise(usage);
  return [`Storage: ${s.left} of ${s.cap} minutes left.`, ...warningLines(s)].join("\n");
}

/**
 * The webhook's usage probe. Never throws and never rejects: any failure —
 * timeout, rate limit, malformed response, a missing API key — returns null and
 * the prompt simply goes out without the line. A storage reading is never worth
 * a failed webhook delivery, which is what a throw here would cost (Fireflies
 * treats a non-2xx as undelivered and retries the whole event).
 */
export async function usageLine({ timeoutMs = PROMPT_PROBE_TIMEOUT_MS } = {}) {
  try {
    return formatLine(await getUsage({ timeoutMs }));
  } catch (err) {
    const why = err instanceof FirefliesError && err.isRateLimited ? "rate limited" : err.message;
    console.warn(`Skipping the storage line on this prompt: ${why}`);
    return null;
  }
}
