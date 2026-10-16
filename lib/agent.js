import { config } from "./config.js";
import { chat, assistantTurn, toolResultTurn } from "./llm.js";
import { tools, executeTool } from "./tools.js";
import { nowLocal, weekdayLocal, today } from "./dates.js";

const MAX_TURNS = 6; // guard against a tool loop that never terminates

function systemPrompt() {
  return [
    "You are a personal assistant over a Notion database of meeting recaps, talking to the user in Telegram.",
    "",
    `Current local time: ${nowLocal()} (${weekdayLocal()}), timezone ${config.timezone}.`,
    `Today's date is ${today()}. Resolve relative dates like "yesterday" or "last Tuesday" against this.`,
    "",
    "Rules:",
    "- Never answer a question about what was discussed without calling the tools first. Do not answer from memory.",
    "- search_meetings returns titles and dates only. To say anything about what was discussed, call read_meeting.",
    "- Never guess a page_id. Get it from search_meetings.",
    "- If a tool returns an error, say plainly what failed. Do not pretend it worked.",
    "- If nothing matches, say so. Do not substitute a different meeting and hope it is close enough.",
    "- Meetings are often held in Thai. The recaps are in English; names and product terms are kept as they were said.",
    "- Pages with status Pending or Skipped have no recap body. Say so rather than reporting an empty meeting.",
    "",
    "Sending Fireflies to a meeting:",
    "- When the user sends a meeting link, or a screenshot of a calendar event or invite (often Microsoft Teams or Outlook), call join_meeting. It shows them a confirmation card; nothing joins until they tap Send.",
    "- A Teams or Outlook event usually shows the subject, the start time, and in the body either a join link or a Meeting ID and Passcode. Prefer a fully visible link; otherwise use the Meeting ID and Passcode.",
    "- Copy IDs and passcodes character for character. Passcodes are case-sensitive and mix letters and digits. If any character is unreadable or ambiguous, do not call join_meeting; say which part you could not read.",
    "- If the screenshot shows neither a link nor a meeting ID, say so. Never make one up.",
    "",
    "Style: you are replying in a Telegram chat. Be brief and plain. No markdown formatting,",
    "no headers, no bold. Use simple hyphen bullets for lists. A confirmation should be one line.",
  ].join("\n");
}

/**
 * Runs the tool-use loop for one user message and returns the reply text.
 * Stateless: each Telegram message is an independent conversation, so
 * "and what about that one" will not resolve.
 *
 * `input` is the message text, or { text, images: [{ mediaType, data }] } for
 * a photo — images go first, which is where vision models read them best.
 *
 * `text` comes back empty when join_meeting put a card in front of the user
 * and the model had nothing to add: the card already says everything.
 */
export async function runAgent(input) {
  const { text, images = [] } = typeof input === "string" ? { text: input } : input;
  const content = images.length
    ? [...images.map((img) => ({ type: "image", mediaType: img.mediaType, data: img.data })), { type: "text", text }]
    : text;
  const messages = [{ role: "user", content }];
  const usage = { input: 0, output: 0 };
  const context = { cardSent: false };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await chat({
      system: systemPrompt(),
      messages,
      tools,
      maxTokens: config.llm.chatMaxTokens,
      effort: config.llm.effort,
    });

    usage.input += response.usage.input;
    usage.output += response.usage.output;

    if (response.stopReason === "refusal") {
      return { text: "I can't help with that one.", usage, cardSent: context.cardSent };
    }

    // stopReason can say tool_use while the call list is empty on a truncated
    // response; treat that as the end rather than looping forever.
    if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) {
      return { text: response.text || (context.cardSent ? "" : "Done."), usage, cardSent: context.cardSent };
    }

    // Claude can emit several tool_use blocks in one response. Execute all of
    // them and return every result in ONE user message — splitting them
    // teaches the model to stop making parallel calls.
    const results = await Promise.all(
      response.toolCalls.map(async (call) => ({
        id: call.id,
        result: await executeTool(call.name, call.input, context),
      }))
    );

    messages.push(assistantTurn(response));
    messages.push(toolResultTurn(results));
  }

  return {
    text: "I got stuck working on that — too many steps without reaching an answer. Try rephrasing?",
    usage,
    cardSent: context.cardSent,
  };
}
