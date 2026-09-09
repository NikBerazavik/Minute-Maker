import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Fireflies GraphQL client. Two calls only: addToLiveMeeting and transcript.
// Free plan quota is 50 requests/day in total — keep call counts minimal.
// ---------------------------------------------------------------------------

export class FirefliesError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "FirefliesError";
    this.code = code || null;
    this.status = status || null;
  }
  get isRateLimited() {
    return this.code === "too_many_requests" || this.status === 429;
  }
  get isNotFound() {
    return (
      (this.code && /not_found/i.test(this.code)) ||
      this.status === 404 ||
      /not found|does not exist/i.test(this.message)
    );
  }
}

/**
 * `timeoutMs` matters for exactly one caller: the usage probe on the synchronous
 * /fireflies webhook, which has a 10-second Fireflies acknowledgement budget to
 * respect. Without it a hung request would hang the webhook until the platform
 * killed it and Fireflies would retry the whole delivery. Omitted everywhere
 * else, where the caller is a background function with minutes to spare.
 */
export async function graphql(query, variables = {}, { timeoutMs } = {}) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetch(config.fireflies.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.fireflies.apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller?.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new FirefliesError(`Fireflies request timed out after ${timeoutMs}ms`, { code: "timeout" });
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new FirefliesError(`Fireflies returned non-JSON (${res.status}): ${text.slice(0, 200)}`, {
      status: res.status,
    });
  }

  const first = json.errors?.[0];
  if (!res.ok || first) {
    throw new FirefliesError(`Fireflies ${res.status}: ${first?.message || text.slice(0, 200)}`, {
      code: first?.code || first?.extensions?.code,
      status: first?.extensions?.status || res.status,
    });
  }
  return json.data;
}

/**
 * Fireflies caps `language` at 5 characters. Truncating a longer value would
 * send a *different* language than intended ("multi-language" -> "multi"), so
 * an over-long value is dropped entirely and Fireflies falls back to its own
 * default. Values reaching here from /join are already validated (lib/join.js);
 * this guards the FIREFLIES_LANGUAGE env var, which nothing else checks.
 */
function normalizeLanguage(value) {
  const lang = String(value ?? "").trim();
  if (!lang) return undefined;
  if (lang.length > 5) {
    console.warn(`Ignoring language "${lang}": Fireflies allows at most 5 characters.`);
    return undefined;
  }
  return lang;
}

/**
 * Ask the Fireflies bot to join a live meeting. Rate-limited to 3 requests per
 * 20 minutes. Response is only { success, message } — there is no id to
 * correlate with the later webhook, hence the timestamp-label design.
 *
 * `language` defaults to config.fireflies.defaultLanguage ("auto" out of the
 * box) rather than Fireflies' own default (English) — see the comment there.
 * Pass an explicit code (e.g. "en") to override per call.
 */
export async function addToLiveMeeting({ meeting_link, title, language }) {
  const data = await graphql(
    `mutation AddToLive($meeting_link: String!, $title: String, $language: String) {
       addToLiveMeeting(meeting_link: $meeting_link, title: $title, language: $language) { success message }
     }`,
    {
      meeting_link,
      title: title ? String(title).slice(0, 256) : undefined,
      language: normalizeLanguage(language || config.fireflies.defaultLanguage),
    }
  );
  return data.addToLiveMeeting;
}

/**
 * Full transcript for a meeting id. This is the call that also yields the real
 * title and meeting date, so the stub page can be finalised in one fetch.
 */
export async function getTranscript(id) {
  const data = await graphql(
    `query Transcript($id: String!) {
       transcript(id: $id) {
         id
         title
         date
         duration
         organizer_email
         participants
         sentences { speaker_name text start_time }
       }
     }`,
    { id }
  );
  if (!data?.transcript) {
    throw new FirefliesError(`Transcript ${id} not found`, { code: "object_not_found", status: 404 });
  }
  return data.transcript;
}

// ---------------------------------------------------------------------------
// Summaries — the no-LLM "Notes" tier.
//
// Field names are read defensively. The live shapes were confirmed against the
// account on 2026-09-09, but the GraphQL spelling of the structured-recap field
// differs between schema versions ("notes" on some, "outline" on others) and
// asking for a field the schema does not have fails the WHOLE query, which
// would kill the tier on the first real meeting. So: ask for a superset, and on
// a field-validation error drop the field GraphQL named and try again. The
// working list is cached in module scope, so the cost is one extra request per
// cold start at worst and never one per meeting.
// ---------------------------------------------------------------------------

/** Preferred first within each role; see pickSummary() for how they are used. */
const SUMMARY_FIELDS = [
  "short_summary", // real prose — what the Summary section wants
  "overview", //     bold-bullet list on this account, so only a fallback
  "gist", //         one line, last resort
  "action_items", // "**Owner**\ntask (mm:ss)" — parsed by lib/render.js
  "notes", //        "## Topic" + nested bullets: the structured recap
  "outline", //      the same thing under a different schema version
];

let workingSummaryFields = null;

/** GraphQL names the offending field: 'Cannot query field "notes" on type "Summary"'. */
function unknownFields(message, candidates) {
  const named = [...String(message).matchAll(/Cannot query field ["'`]([A-Za-z0-9_]+)["'`]/g)].map((m) => m[1]);
  return candidates.filter((f) => named.includes(f));
}

/**
 * Summary for a meeting id, for the Notes tier. Deliberately does NOT request
 * `sentences`: fetching the full transcript is exactly the cost this tier
 * exists to avoid. `title` and `date` ride along for free, so a Notes page ends
 * up with the meeting's real title instead of the timestamp stub label.
 *
 * Returns null for `summary` when Fireflies has not produced one yet — the
 * caller claims the page and waits for meeting.summarized.
 */
export async function getSummary(id) {
  let fields = workingSummaryFields || SUMMARY_FIELDS;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await graphql(
        `query Summary($id: String!) {
           transcript(id: $id) { id title date summary { ${fields.join(" ")} } }
         }`,
        { id }
      );
      if (!data?.transcript) {
        throw new FirefliesError(`Transcript ${id} not found`, { code: "object_not_found", status: 404 });
      }
      workingSummaryFields = fields;
      const t = data.transcript;
      return { id: t.id, title: t.title || null, date: t.date || null, summary: t.summary || null };
    } catch (err) {
      const rejected = unknownFields(err.message, fields);
      if (rejected.length === 0) throw err;
      const remaining = fields.filter((f) => !rejected.includes(f));
      if (remaining.length === 0) throw err;
      console.warn(`Fireflies rejected summary field(s) ${rejected.join(", ")}; retrying without them.`);
      fields = remaining;
    }
  }
  throw new FirefliesError("Could not agree on a summary field set with Fireflies.");
}

/**
 * Account usage, for /space. `minutes_consumed` is the meter behind the free
 * plan's 400-minute storage cap; `num_transcripts` is how many are held.
 *
 * Open question, deliberately unresolved in code: whether minutes_consumed
 * DECREASES when transcripts are deleted, or only ever climbs. If it only
 * climbs it measures lifetime usage, not remaining space, and this command
 * needs a stored baseline to stay meaningful after a purge. Recorded baseline
 * for that test: 163.76 minutes on 2026-09-09. See PLAN.md.
 *
 * Costs one request of the 50/day quota.
 */
export async function getUsage({ timeoutMs } = {}) {
  const data = await graphql(`query { user { minutes_consumed num_transcripts } }`, {}, { timeoutMs });
  const user = data?.user || {};
  return {
    minutesConsumed: Number(user.minutes_consumed) || 0,
    transcripts: Number(user.num_transcripts) || 0,
  };
}

/** Cheap connectivity check for scripts/verify.js (costs one request of the daily quota). */
export async function whoAmI() {
  const data = await graphql(`query { user { email name } }`);
  return data.user;
}
