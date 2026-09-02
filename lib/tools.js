import { config } from "./config.js";
import {
  searchMeetings,
  mostRecentMeeting,
  listChildren,
  appendBlocks,
  getMeeting,
} from "./notion.js";
import { blocksToText, heading2, renderNoteBullet } from "./render.js";

// ---------------------------------------------------------------------------
// Three tools, deliberately no more. Every schema is re-sent as input tokens
// on every turn, and a small tool surface keeps routing reliable.
//
// Why three and not the two originally sketched: Notion's query endpoint
// filters on properties only — it cannot see page bodies — so answering
// "what did we decide about X" needs a metadata search followed by a body
// read. Merging them would mean pulling every candidate page's full body on
// every question.
// ---------------------------------------------------------------------------

export const tools = [
  {
    name: "search_meetings",
    description:
      "Find meetings by title text and/or date range. Returns metadata only (title, date, status, page_id) — not the recap contents. Use this first, then read_meeting for the details. Call with no arguments to list the most recent meetings.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match against the meeting title. Omit to match any title." },
        date_from: { type: "string", description: "YYYY-MM-DD, inclusive." },
        date_to: { type: "string", description: "YYYY-MM-DD, inclusive." },
        limit: { type: "integer", description: "Max results, default 10, max 50." },
      },
    },
  },
  {
    name: "read_meeting",
    description:
      "Read the full recap body of one meeting. You must have its page_id from search_meetings — never guess a page_id.",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page_id returned by search_meetings." },
      },
      required: ["page_id"],
    },
  },
  {
    name: "add_note_to_meeting",
    description:
      "Append a note to an existing meeting page, under a 'Post-meeting notes' heading. Use this for things that happened OUTSIDE the recorded meeting, such as a hallway follow-up. Never use it to correct the recap itself.",
    input_schema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "The page to append to, from search_meetings. Omit only if you want the most recent meeting.",
        },
        note: { type: "string", description: "The note text, written as a full sentence." },
        is_action_item: { type: "boolean", description: "True only for a genuine commitment." },
        action_owner: { type: "string", description: "Who owns it. Use 'TBA' when unstated." },
        action_due: { type: "string", description: "When it is due, if stated." },
      },
      required: ["note"],
    },
  },
];

async function doSearch(input) {
  const meetings = await searchMeetings(input || {});
  return { count: meetings.length, meetings };
}

async function doRead({ page_id }) {
  if (!page_id) return { error: "page_id is required. Call search_meetings first." };
  const meeting = await getMeeting(page_id);
  const body = blocksToText(await listChildren(page_id));
  return {
    title: meeting.name,
    date: meeting.date,
    status: meeting.status,
    body: body || "(this page has no recap yet)",
  };
}

async function doAddNote({ page_id, note, is_action_item, action_owner, action_due }) {
  if (!note || !String(note).trim()) return { error: "note is required." };

  let meeting;
  if (page_id) {
    meeting = await getMeeting(page_id);
  } else {
    meeting = await mostRecentMeeting();
    if (!meeting) {
      return {
        error:
          "There are no meetings with a recap yet, so there is nothing to append to. If the transcript is still processing, try again once the recap exists.",
      };
    }
  }

  const blocks = [];
  const existing = await listChildren(meeting.page_id);
  const hasHeading = existing.some(
    (b) =>
      b.type === "heading_2" &&
      (b.heading_2?.rich_text || [])
        .map((r) => r.plain_text ?? r.text?.content ?? "")
        .join("")
        .trim() === config.text.postMeetingHeading
  );
  if (!hasHeading) blocks.push(heading2(config.text.postMeetingHeading));
  blocks.push(renderNoteBullet({ note, is_action_item, action_owner, action_due }));

  await appendBlocks(meeting.page_id, blocks);
  return { appended: true, meeting: meeting.name, page_id: meeting.page_id };
}

// Errors are returned as data, not thrown, so the model can see what went
// wrong and tell the user plainly instead of the whole request failing.
export async function executeTool(name, input) {
  console.log(`Tool call: ${name}`, JSON.stringify(input));
  try {
    switch (name) {
      case "search_meetings":
        return await doSearch(input);
      case "read_meeting":
        return await doRead(input || {});
      case "add_note_to_meeting":
        return await doAddNote(input || {});
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`Tool ${name} failed:`, err);
    return { error: err.message };
  }
}
