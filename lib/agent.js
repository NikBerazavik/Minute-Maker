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
    "Style: you are replying in a Telegram chat. Be brief and plain. No markdown formatting,",
    "no headers, no bold. Use simple hyphen bullets for lists. A confirmation should be one line.",
  ].join("\n");
}

/**
 * Runs the tool-use loop for one user message and returns the reply text.
 * Stateless: each Telegram message is an independent conversation, so
 * "and what about that one" will not resolve.
 */
export async function runAgent(userText) {
  const messages = [{ role: "user", content: userText }];
  const usage = { input: 0, output: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await chat({
      system: systemPrompt(),
      messages,
      tools,
      maxTokens: config.llm.chatMaxTokens,
    });

    usage.input += response.usage.input;
    usage.output += response.usage.output;

    if (response.stopReason === "refusal") {
      return { text: "I can't help with that one.", usage };
    }

    // stopReason can say tool_use while the call list is empty on a truncated
    // response; treat that as the end rather than looping forever.
    if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) {
      return { text: response.text || "Done.", usage };
    }

    // Claude can emit several tool_use blocks in one response. Execute all of
    // them and return every result in ONE user message — splitting them
    // teaches the model to stop making parallel calls.
    const results = await Promise.all(
      response.toolCalls.map(async (call) => ({
        id: call.id,
        result: await executeTool(call.name, call.input),
      }))
    );

    messages.push(assistantTurn(response));
    messages.push(toolResultTurn(results));
  }

  return {
    text: "I got stuck working on that — too many steps without reaching an answer. Try rephrasing?",
    usage,
  };
}
