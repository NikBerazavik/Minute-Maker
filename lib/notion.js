import { config } from "./config.js";
import { startOfDay, addDays } from "./dates.js";
import { chunkArray, BLOCKS_PER_REQUEST } from "./render.js";

const NOTION_BASE = "https://api.notion.com/v1";
const P = config.props;

// ---------------------------------------------------------------------------
// Raw REST client. No SDK: the SDK's method names shifted across the
// data-sources migration, and this keeps the pinned Notion-Version in one file.
// ---------------------------------------------------------------------------

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

export async function notionRequest(path, { method = "GET", body, attempt = 0 } = {}) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.notion.apiKey()}`,
      "Notion-Version": config.notion.apiVersion,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (RETRY_STATUSES.has(res.status) && attempt < 2) {
    const retryAfter = Number(res.headers.get("retry-after")) || 1;
    await new Promise((r) => setTimeout(r, Math.min(retryAfter, 5) * 1000));
    return notionRequest(path, { method, body, attempt: attempt + 1 });
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Notion returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const err = new Error(`Notion ${res.status} on ${method} ${path}: ${json.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.code = json.code;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Data source resolution. Since API version 2025-09-03 a "database" contains
// one or more "data sources", and the data source holds the rows. The id in
// the Notion URL is the DATABASE id; queries and page creation need the DATA
// SOURCE id. Resolved once per cold start and cached in module scope.
// ---------------------------------------------------------------------------

let dataSourceIdCache = null;
let schemaCache = null;

export async function meetingsSourceId() {
  if (dataSourceIdCache) return dataSourceIdCache;
  const dbId = config.notion.meetingsDbId();
  const db = await notionRequest(`/databases/${dbId}`);
  const sources = db.data_sources || [];
  if (sources.length === 0) {
    throw new Error(`Database ${dbId} reports no data sources. Is the integration connected to it?`);
  }
  if (sources.length > 1) {
    console.warn(`Database ${dbId} has ${sources.length} data sources; using the first ("${sources[0].name}").`);
  }
  dataSourceIdCache = sources[0].id;
  return dataSourceIdCache;
}

/** Live property schema, cached. Used to adapt to how Status was actually created. */
export async function meetingsSchema() {
  if (schemaCache) return schemaCache;
  const source = await notionRequest(`/data_sources/${await meetingsSourceId()}`);
  schemaCache = source.properties || {};
  return schemaCache;
}

/**
 * "Status" can legitimately be either a Select or Notion's dedicated Status
 * type depending on how the database was built by hand. Both are supported;
 * the write shape and the filter shape differ, so resolve it from the schema
 * rather than assuming.
 */
async function statusKind() {
  const schema = await meetingsSchema();
  const type = schema[P.status]?.type;
  if (type !== "select" && type !== "status") {
    throw new Error(
      `Notion property "${P.status}" is ${type ? `a ${type}` : "missing"}; it must be a Select or Status property.`
    );
  }
  return type;
}

export async function statusProperty(value) {
  return (await statusKind()) === "status" ? { status: { name: value } } : { select: { name: value } };
}

export async function statusFilter(value) {
  const kind = await statusKind();
  return kind === "status"
    ? { property: P.status, status: { equals: value } }
    : { property: P.status, select: { equals: value } };
}

// ---------------------------------------------------------------------------
// Property builders and flattening
// ---------------------------------------------------------------------------

const asTitle = (v) => ({ title: [{ text: { content: String(v).slice(0, 2000) } }] });
const asRichText = (v) => ({ rich_text: v ? [{ text: { content: String(v).slice(0, 2000) } }] : [] });
const asDate = (start) => ({ date: start ? { start } : null });

export function flattenMeeting(page) {
  const p = page.properties || {};
  return {
    page_id: page.id,
    name: p[P.name]?.title?.[0]?.plain_text || "(untitled)",
    date: p[P.date]?.date?.start || null,
    source_meeting_id: (p[P.sourceId]?.rich_text || []).map((r) => r.plain_text).join("").trim() || null,
    status: p[P.status]?.select?.name || p[P.status]?.status?.name || null,
    last_edited_time: page.last_edited_time || null,
    url: page.url || null,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function query({ filter, sorts, pageSize = 25, startCursor } = {}) {
  const res = await notionRequest(`/data_sources/${await meetingsSourceId()}/query`, {
    method: "POST",
    body: {
      ...(filter ? { filter } : {}),
      sorts: sorts || [{ property: P.date, direction: "descending" }],
      page_size: pageSize,
      ...(startCursor ? { start_cursor: startCursor } : {}),
    },
  });
  return {
    meetings: (res.results || []).map(flattenMeeting),
    nextCursor: res.has_more ? res.next_cursor : null,
  };
}

/** The idempotency lookup. Source Meeting ID is the Fireflies meeting id. */
export async function findMeetingByFirefliesId(meetingId) {
  const { meetings } = await query({
    filter: { property: P.sourceId, rich_text: { equals: meetingId } },
    pageSize: 2,
  });
  if (meetings.length > 1) {
    console.warn(`More than one page has Source Meeting ID ${meetingId}; using the newest.`);
  }
  return meetings[0] || null;
}

export async function getMeeting(pageId) {
  return flattenMeeting(await notionRequest(`/pages/${pageId}`));
}

/**
 * Pages the sweep should promote: still Pending, or stuck in Processing past
 * the stale threshold (a function that died mid-run). Failed pages are only
 * retried on an explicit /sweep, never by the scheduled job — a repeatedly
 * failing meeting should not retry itself forever.
 */
export async function findSweepablePages({ includeFailed = false, limit = 20 } = {}) {
  const staleBefore = new Date(Date.now() - config.staleProcessingMinutes * 60 * 1000).toISOString();
  const or = [
    await statusFilter(config.status.pending),
    {
      and: [
        await statusFilter(config.status.processing),
        { timestamp: "last_edited_time", last_edited_time: { before: staleBefore } },
      ],
    },
  ];
  if (includeFailed) or.push(await statusFilter(config.status.failed));

  const { meetings } = await query({
    filter: { or },
    sorts: [{ property: P.date, direction: "ascending" }],
    pageSize: limit,
  });
  return meetings;
}

/** Metadata search for the chat loop. */
export async function searchMeetings({ query: q, date_from, date_to, limit = 10 } = {}) {
  const conditions = [];
  if (q) conditions.push({ property: P.name, title: { contains: q } });
  if (date_from) conditions.push({ property: P.date, date: { on_or_after: startOfDay(date_from) } });
  if (date_to) conditions.push({ property: P.date, date: { before: startOfDay(addDays(date_to, 1)) } });

  const filter = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : { and: conditions };
  const { meetings } = await query({ filter, pageSize: Math.min(Math.max(limit, 1), 50) });
  return meetings;
}

/** Most recent meeting that actually has a recap. Fallback for add_note_to_meeting. */
export async function mostRecentMeeting() {
  const { meetings } = await query({ filter: await statusFilter(config.status.done), pageSize: 1 });
  return meetings[0] || null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createStubPage({ meetingId, label, dateIso }) {
  const page = await notionRequest("/pages", {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: await meetingsSourceId() },
      properties: {
        [P.name]: asTitle(label),
        [P.date]: asDate(dateIso),
        [P.sourceId]: asRichText(meetingId),
        [P.status]: await statusProperty(config.status.pending),
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: config.text.awaiting } }] },
        },
      ],
    },
  });
  return flattenMeeting(page);
}

export async function setStatus(pageId, status) {
  await notionRequest(`/pages/${pageId}`, {
    method: "PATCH",
    body: { properties: { [P.status]: await statusProperty(status) } },
  });
}

export async function patchMeeting(pageId, { name, dateIso, status }) {
  const properties = {};
  if (name) properties[P.name] = asTitle(name);
  if (dateIso) properties[P.date] = asDate(dateIso);
  if (status) properties[P.status] = await statusProperty(status);
  if (Object.keys(properties).length === 0) return;
  await notionRequest(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
}

export async function listChildren(pageId) {
  const blocks = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    const res = await notionRequest(`/blocks/${pageId}/children?${qs}`);
    blocks.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return blocks;
}

/**
 * Notion has no bulk delete, so this is one request per block. It runs before
 * every recap write, which is what makes the write idempotent: a retry or a
 * concurrent promotion replaces the body instead of appending a second copy.
 */
export async function deleteChildren(pageId) {
  const blocks = await listChildren(pageId);
  const CONCURRENCY = 3; // Notion allows ~3 requests/second
  for (let i = 0; i < blocks.length; i += CONCURRENCY) {
    await Promise.all(
      blocks.slice(i, i + CONCURRENCY).map((b) =>
        notionRequest(`/blocks/${b.id}`, { method: "DELETE" }).catch((err) => {
          // A block already gone is fine; anything else is worth knowing about.
          if (err.status !== 404) console.error(`Failed to delete block ${b.id}:`, err.message);
        })
      )
    );
  }
  return blocks.length;
}

/** Appends in order, 100 blocks per request (Notion's hard limit). */
export async function appendBlocks(pageId, blocks) {
  for (const batch of chunkArray(blocks, BLOCKS_PER_REQUEST)) {
    await notionRequest(`/blocks/${pageId}/children`, { method: "PATCH", body: { children: batch } });
  }
  return blocks.length;
}

/** Replaces the whole page body. */
export async function replaceBody(pageId, blocks) {
  await deleteChildren(pageId);
  await appendBlocks(pageId, blocks);
}

export { P as properties };
