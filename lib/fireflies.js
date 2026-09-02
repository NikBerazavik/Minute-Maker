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

export async function graphql(query, variables = {}) {
  const res = await fetch(config.fireflies.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.fireflies.apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

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
 * Ask the Fireflies bot to join a live meeting. Rate-limited to 3 requests per
 * 20 minutes. Response is only { success, message } — there is no id to
 * correlate with the later webhook, hence the timestamp-label design.
 */
export async function addToLiveMeeting({ meeting_link, title }) {
  const data = await graphql(
    `mutation AddToLive($meeting_link: String!, $title: String) {
       addToLiveMeeting(meeting_link: $meeting_link, title: $title) { success message }
     }`,
    { meeting_link, title: title ? String(title).slice(0, 256) : undefined }
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

/** Cheap connectivity check for scripts/verify.js (costs one request of the daily quota). */
export async function whoAmI() {
  const data = await graphql(`query { user { email name } }`);
  return data.user;
}
