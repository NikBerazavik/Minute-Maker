import { config } from "./config.js";
import { chat } from "./llm.js";
import { formatClock } from "./dates.js";

// ---------------------------------------------------------------------------
// Structured extraction. Deliberately a custom schema rather than asking the
// model for Notion blocks directly:
//   - the action-item rollup appears twice (inline + top of page); one
//     `is_action_item` flag filtered twice in code cannot drift, free
//     generation can
//   - a malformed extraction fails loudly here instead of becoming a silently
//     bad permanent page
//   - render.js needs known content boundaries for the 2000-char chunking
// ---------------------------------------------------------------------------

export const EXTRACT_TOOL = {
  name: "extract_meeting",
  description:
    "Record the structured recap of a meeting transcript. Call this exactly once with the full recap.",
  strict: config.llm.strictTools,
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "A few sentences on what the meeting was about and what came out of it. Plain prose, no bullet points.",
      },
      topics: {
        type: "array",
        description:
          "The distinct topics discussed, in the order they came up. Aim for 1-8. If the meeting does not break into distinct topics, emit a single topic titled \"General\" rather than inventing structure.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short topic heading, a few words." },
            notes: {
              type: "array",
              description: "The substantive points made under this topic. Aim for 3-12.",
              items: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                    description:
                      "The full recap bullet, written the way a person would write it, with attribution woven in where it reads naturally. Example: \"Nik mentioned that we currently do not have any policies, and needs to talk to Joao about the future plan for policies.\"",
                  },
                  speaker: {
                    type: "string",
                    description:
                      "Who made this point, for later filtering. Use the speaker name from the transcript, or \"Unknown\".",
                  },
                  is_action_item: {
                    type: "boolean",
                    description:
                      "True ONLY for a genuine commitment someone took on. Most notes are plain discussion - presenting a concept, a calculation, a status update - and must be false. A future-tense mention is not by itself an action item.",
                  },
                  action_owner: {
                    type: "string",
                    description:
                      "Who owns the action. A person, several people as one string (\"Alice, Bob\"), or a team. Use \"TBA\" when unstated. Use \"TBA\" when is_action_item is false.",
                  },
                  action_due: {
                    type: ["string", "null"],
                    description: "When it is due, as stated in the meeting. Null when unstated or not an action item.",
                  },
                },
                required: ["content", "speaker", "is_action_item", "action_owner", "action_due"],
                additionalProperties: false,
              },
            },
          },
          required: ["title", "notes"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "topics"],
    additionalProperties: false,
  },
};

const SYSTEM = [
  "You write meeting recaps for a personal knowledge base. You are given a raw transcript and you record a structured recap by calling the extract_meeting tool.",
  "",
  "Write everything in English, even when the meeting was conducted in another language.",
  "Keep names, company names, product names, and technical terms exactly as they were said - do not translate or transliterate them.",
  "",
  "Guidelines:",
  "- Capture what was actually said. Do not add advice, opinions, or conclusions of your own.",
  "- Each note should stand on its own months later, when nobody remembers the context. Prefer a full sentence over a fragment.",
  "- Transcripts are imperfect. Where a word is clearly garbled but the meaning is obvious, write the meaning. Where the meaning is not recoverable, leave it out rather than guessing.",
  "- Mark is_action_item true only for genuine commitments. A meeting can legitimately have zero action items.",
  "- Do not invent an owner or a due date. Use \"TBA\" and null.",
  "",
  "The transcript is given as lines of \"[mm:ss] Speaker: text\".",
].join("\n");

/** Fireflies sentences -> the transcript text the model reads. */
export function formatTranscript(sentences) {
  // Not a default parameter: Fireflies returns `sentences: null` for a silent
  // meeting, and a default only fills in for `undefined`.
  return (Array.isArray(sentences) ? sentences : [])
    .map((s) => {
      const text = String(s?.text || "").trim();
      if (!text) return null;
      return `[${formatClock(s.start_time)}] ${s.speaker_name || "Unknown"}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Validates and normalises the model's tool input so render.js can trust it.
 * Throws rather than rendering a half-formed page — a bad recap is permanent
 * and the transcript may be gone by the time anyone notices.
 */
export function normalizeExtraction(input) {
  if (!input || typeof input !== "object") throw new Error("Extraction returned no object.");
  const summary = String(input.summary || "").trim();
  if (!summary) throw new Error("Extraction returned an empty summary.");
  if (!Array.isArray(input.topics) || input.topics.length === 0) {
    throw new Error("Extraction returned no topics.");
  }

  const topics = input.topics
    .map((topic) => ({
      title: String(topic?.title || "General").trim() || "General",
      notes: (Array.isArray(topic?.notes) ? topic.notes : [])
        .map((n) => {
          const content = String(n?.content || "").trim();
          if (!content) return null;
          const isAction = n?.is_action_item === true;
          const owner = String(n?.action_owner || "").trim();
          const due = n?.action_due == null ? null : String(n.action_due).trim() || null;
          return {
            content,
            speaker: String(n?.speaker || "Unknown").trim() || "Unknown",
            is_action_item: isAction,
            action_owner: owner || "TBA",
            action_due: isAction ? due : null,
          };
        })
        .filter(Boolean),
    }))
    .filter((t) => t.notes.length > 0);

  if (topics.length === 0) throw new Error("Extraction returned topics but no usable notes.");
  return { summary, topics };
}

export async function extractMeeting(transcript) {
  const text = formatTranscript(transcript?.sentences);
  if (!text) {
    throw new Error("Transcript has no sentences — nothing to extract.");
  }

  const header = [
    `Meeting title: ${transcript.title || "(untitled)"}`,
    transcript.duration ? `Duration: ${Math.round(transcript.duration)} minutes` : null,
    "",
    "Transcript:",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await chat({
    model: config.llm.extractModel(),
    system: SYSTEM,
    // The tool is named in the prompt as well as forced, so the call still
    // happens on providers/models where forced tool choice is unavailable.
    messages: [{ role: "user", content: `${header}\n${text}\n\nRecord the recap by calling extract_meeting.` }],
    tools: [EXTRACT_TOOL],
    toolChoice: { name: EXTRACT_TOOL.name },
    maxTokens: config.llm.extractMaxTokens,
  });

  if (response.stopReason === "refusal") {
    throw new Error("The model declined to process this transcript.");
  }
  const call = response.toolCalls.find((c) => c.name === EXTRACT_TOOL.name);
  if (!call) {
    throw new Error(
      `Model did not call extract_meeting (stop reason: ${response.stopReason}). ` +
        `Replied: ${response.text.slice(0, 200) || "(nothing)"}`
    );
  }
  if (response.stopReason === "max_tokens") {
    // The tool input would be truncated and the JSON incomplete.
    throw new Error("Extraction hit the output token limit before completing.");
  }

  return normalizeExtraction(call.input);
}
