import { config } from "./config.js";
import {
  searchMeetings,
  mostRecentMeeting,
  listChildren,
  appendBlocks,
  getMeeting,
} from "./notion.js";
import { blocksToText, heading2, renderNoteBullet } from "./render.js";
import { buildJoinLink, resolveLanguage, JOIN_PLATFORMS } from "./join.js";
import { minutesUntil } from "./dates.js";
import { sendJoinCard } from "./telegram.js";

// ---------------------------------------------------------------------------
// Four tools, deliberately no more. Every schema is re-sent as input tokens
// on every turn, and a small tool surface keeps routing reliable.
//
// Why search and read are separate: Notion's query endpoint filters on
// properties only — it cannot see page bodies — so answering "what did we
// decide about X" needs a metadata search followed by a body read. Merging
// them would mean pulling every candidate page's full body on every question.
//
// join_meeting never joins by itself. It puts a confirmation card in front of
// the user, and Fireflies is sent only when they tap Send: a single misread
// digit in a screenshot would otherwise spend one of only 3 joins per 20
// minutes on the wrong meeting.
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
  {
    name: "join_meeting",
    description:
      "Send the Fireflies notetaker to a meeting, from a join link or from a screenshot of a calendar event or invite. This does not join straight away: it shows the user a confirmation card with a Send button, and Fireflies joins only when they tap it. Give either meeting_link, or meeting_id (plus passcode when one is shown).",
    input_schema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: JOIN_PLATFORMS, description: "The meeting platform." },
        meeting_link: {
          type: "string",
          description: "The full join URL, exactly as shown. Omit when no URL is visible — never construct or guess one.",
        },
        meeting_id: {
          type: "string",
          description: "The meeting ID exactly as shown (spaces are fine), when there is no visible link.",
        },
        passcode: {
          type: "string",
          description: "The passcode or password exactly as shown. Case-sensitive. Omit when none is shown.",
        },
        title: { type: "string", description: "The event's subject line." },
        starts_at: {
          type: "string",
          description: "The event's start as local date and time, YYYY-MM-DDTHH:MM. Omit when no start time is shown.",
        },
        language: {
          type: "string",
          description: "Only when the user names the meeting's language, e.g. thai, english, th, ja.",
        },
        join_now_anyway: {
          type: "boolean",
          description: "True only when the user explicitly asks to send Fireflies now even though the meeting starts later.",
        },
      },
      required: ["platform"],
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
  const body = blocksToText(await listChildren(page_id, { withChildren: true }));
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

async function doJoin(input, context) {
  const built = buildJoinLink(input);
  if (built.error) return { error: built.error };

  let language = null;
  if (input.language) {
    const resolved = resolveLanguage(input.language);
    if (resolved.error) return { error: resolved.error };
    language = resolved.code;
  }

  // addToLiveMeeting joins NOW. A meeting hours away would get a bot sitting
  // in an empty room until its duration ran out, so it is not offered at all.
  const lead = config.fireflies.joinLeadMinutes;
  const minutes = input.starts_at ? minutesUntil(input.starts_at) : null;
  if (minutes !== null && minutes > lead && !input.join_now_anyway) {
    return {
      not_sent: true,
      reason:
        `The meeting starts in about ${Math.round(minutes)} minutes. Fireflies can only join a meeting that is live, ` +
        `so no card was shown. Tell the user to send it again within ${lead} minutes of the start, ` +
        `or to ask you to send it now anyway.`,
    };
  }

  await sendJoinCard({
    link: built.link,
    title: String(input.title || "").trim() || null,
    password: built.password,
    language,
    starts: input.starts_at ? String(input.starts_at).replace("T", " ").slice(0, 16) : null,
  });
  context.cardSent = true;
  return {
    status: "confirmation_card_sent",
    note:
      "The user can now see the details and a Send Fireflies button. Do not repeat the details. " +
      "Reply with nothing, or one short line if something needs flagging, such as a character you were unsure of.",
  };
}

// Errors are returned as data, not thrown, so the model can see what went
// wrong and tell the user plainly instead of the whole request failing.
// `context` carries per-message state back to the agent loop.
export async function executeTool(name, input, context = {}) {
  // Passcodes stay out of the function logs.
  console.log(`Tool call: ${name}`, JSON.stringify({ ...input, ...(input?.passcode ? { passcode: "***" } : {}) }));
  try {
    switch (name) {
      case "search_meetings":
        return await doSearch(input);
      case "read_meeting":
        return await doRead(input || {});
      case "add_note_to_meeting":
        return await doAddNote(input || {});
      case "join_meeting":
        return await doJoin(input || {}, context);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`Tool ${name} failed:`, err);
    return { error: err.message };
  }
}
