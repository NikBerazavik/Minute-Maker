import { config as app, resolveTier, isTierKey } from "../../lib/config.js";
import { sendMessage, answerCallbackQuery, editMessageText } from "../../lib/telegram.js";
import { findMeetingByFirefliesId, findSweepablePages } from "../../lib/notion.js";
import { promoteMeeting, skipMeeting, triggerPromotions } from "../../lib/promote.js";
import { notesRecap } from "../../lib/notes.js";
import { addToLiveMeeting, getUsage, FirefliesError } from "../../lib/fireflies.js";
import { formatReport } from "../../lib/usage.js";
import { parseJoinCommand } from "../../lib/join.js";
import { runAgent } from "../../lib/agent.js";

// ---------------------------------------------------------------------------
// Telegram webhook.
//
// A BACKGROUND function: Netlify returns 202 the moment it is invoked, which
// is all Telegram needs, and the handler then gets up to 15 minutes. That is
// what makes it possible to run a full transcript extraction inline on a Yes
// tap — a synchronous function would time out long before.
//
// Consequences of being a background function, both handled below:
//   1. The Response returned here is ignored, so the auth checks gate the WORK
//      rather than the status code. An unauthenticated caller gets a 202 and
//      nothing happens.
//   2. A thrown error makes Netlify retry the invocation twice (after 1 and 2
//      minutes). Nothing in this handler may throw.
// ---------------------------------------------------------------------------

const HELP = [
  "I turn your Fireflies meetings into Notion recaps.",
  "",
  '/join <link> "<title>" <language>  — send the Fireflies bot to a live meeting',
  '  e.g. /join https://... "Weekly sync" thai',
  "  Quotes are the safe form: everything inside them is the title, the word",
  "  after them is the language (thai, english, or a code like th, ja, zh-CN).",
  "  Both are optional — without a language I let Fireflies auto-detect it.",
  "/sweep — process any meeting still waiting on an answer",
  "/space — how much Fireflies transcription storage is left",
  "/help — this message",
  "",
  "When a transcript is ready I'll ask how to recap it, and tell you how much",
  "Fireflies storage is left. Four buttons:",
  "  Haiku  — a model recap, cheap. The default for /sweep and the weekly job.",
  "  Sonnet — a model recap, better at long or messy meetings.",
  "  Notes  — no model at all: Fireflies' own summary, in the meeting's own",
  "           language. Free. If Fireflies hasn't finished summarising yet I",
  "           claim the page and finish it the moment it does.",
  "  Skip   — no recap; the page stays as a record that the meeting happened.",
  "",
  "Anything else you type, I answer from your meeting notes:",
  '- "what did we decide about the 5G report?"',
  '- "what happened in the UAT meeting last week?"',
  '- "add a note to the UAT meeting: Joao agreed to send the policy draft"',
].join("\n");

async function handleJoin(argText) {
  const parsed = parseJoinCommand(argText);
  if (parsed.error) return sendMessage(parsed.error);

  const { link, title, language } = parsed;
  try {
    const result = await addToLiveMeeting({ meeting_link: link, title: title || undefined, language });
    if (result?.success === false) {
      return sendMessage(`Fireflies refused to join: ${result.message || "no reason given"}`);
    }
    // Echo the resolved language back: it is the only way to notice that a
    // title was mis-read as a language, or vice versa, before the meeting ends.
    const used = language || app.fireflies.defaultLanguage;
    const languageNote = used === "auto" ? "auto-detecting the language" : `language: ${used}`;
    return sendMessage(
      `Fireflies is joining${title ? ` "${title}"` : ""} (${languageNote}). I'll ask about a recap when the transcript is ready.`
    );
  } catch (err) {
    if (err instanceof FirefliesError && err.isRateLimited) {
      // No retry button: callback_data is capped at 64 bytes and a Teams link
      // is far longer than that, so there is nowhere to keep the link.
      return sendMessage(
        "Fireflies is rate limited — it allows 3 join requests per 20 minutes. Wait a few minutes and send the same /join again."
      );
    }
    return sendMessage(`Could not ask Fireflies to join: ${err.message}`);
  }
}

/**
 * Fireflies' free plan caps stored transcription at a number of minutes, and
 * nothing warns you before a meeting is refused. One API call, no LLM, no
 * Notion — deliberately the cheapest command in the bot.
 */
async function handleSpace() {
  let usage;
  try {
    usage = await getUsage();
  } catch (err) {
    if (err instanceof FirefliesError && err.isRateLimited) {
      return sendMessage("Fireflies is rate limiting me right now — try /space again in a few minutes.");
    }
    return sendMessage(`Could not read your Fireflies usage: ${err.message}`);
  }

  // Shared with the line on the transcribed prompt, so the "running out"
  // warning cannot appear in one and not the other.
  return sendMessage(formatReport(usage));
}

async function handleSweep() {
  const pending = await findSweepablePages({ includeFailed: true, limit: 20 });
  if (pending.length === 0) {
    return sendMessage("Nothing is waiting — every meeting is recapped or skipped.");
  }

  // Each promotion runs in its own background invocation rather than inline:
  // 20 transcripts back to back would not fit in this function's 15 minutes.
  // Every run reports its own result, so the reply here is just the receipt.
  const { triggered, failed } = await triggerPromotions(pending, { allowFailed: true });
  const lines = [`Recapping ${triggered.length} meeting(s). I'll message you as each one lands.`];
  for (const m of triggered) lines.push(`- ${m.name}`);
  if (failed.length) {
    lines.push("", `${failed.length} could not be started — check the Netlify logs:`);
    for (const m of failed) lines.push(`- ${m.name}`);
  }
  return sendMessage(lines.join("\n"));
}

async function handleCallback(callbackQuery) {
  const [rawAction, meetingId] = String(callbackQuery.data || "").split(":");
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  // A prompt sitting in scrollback from before the tiers shipped still sends
  // "yes:". Map it to the default tier rather than answering "Unrecognised".
  const action = rawAction === "yes" ? app.extractTiers[0].key : rawAction;
  const tier = isTierKey(action) ? resolveTier(action) : null;

  // Always answer, or the client shows a spinner until it times out.
  await answerCallbackQuery(callbackQuery.id, tier ? `Working on it — ${tier.label}` : "Skipping");

  const meeting = await findMeetingByFirefliesId(meetingId);
  if (!meeting) {
    return editMessageText(chatId, messageId, `No Notion page found for meeting ${meetingId}.`);
  }

  if (tier) {
    // Editing without reply_markup removes the keyboard, so the prompt cannot
    // be tapped twice while the work runs. That is a UI defence only — it does
    // not survive a redelivery or a second device — so the real guard is the
    // state check inside promoteMeeting/notesRecap.
    await editMessageText(chatId, messageId, `${tier.label} — building the recap for "${meeting.name}"...`);

    const result =
      tier.key === "notes"
        ? await notesRecap(meeting.page_id)
        : await promoteMeeting(meeting.page_id, { tier: tier.key });

    if (result.skipped) {
      await sendMessage(`Nothing to do: that meeting ${result.reason}.`);
    } else if (result.waiting) {
      await sendMessage(
        `Fireflies hasn't finished its notes for "${meeting.name}" yet. ` +
          `I've claimed the page and I'll finish it the moment they land` +
          `${result.reason ? ` (${result.reason})` : ""}. ` +
          `Tap Haiku or Sonnet on that meeting if you'd rather not wait.`
      );
    }
    return;
  }

  if (action === "no") {
    const result = await skipMeeting(meeting.page_id);
    return editMessageText(
      chatId,
      messageId,
      result.skipped ? `Skipped. The page stays as a record that the meeting happened.` : `Not skipped: it ${result.reason}.`
    );
  }

  return editMessageText(chatId, messageId, `Unrecognised action "${rawAction}".`);
}

async function handleMessage(text) {
  if (text === "/start" || text === "/help") return sendMessage(HELP);

  const [command, ...rest] = text.split(/\s+/);
  if (command === "/join") return handleJoin(rest.join(" "));
  if (command === "/sweep") return handleSweep();
  if (command === "/space") return handleSpace();

  const { text: reply, usage } = await runAgent(text);
  console.log(`Handled message. Tokens in=${usage.input} out=${usage.output}`);
  return sendMessage(reply);
}

export default async (req) => {
  // Netlify ignores this response for a background function; it exists so the
  // handler has a single, honest exit shape.
  const accepted = new Response(null, { status: 202 });

  if (req.method !== "POST") return accepted;

  try {
    // Auth gate 1: the secret token Telegram echoes on every delivery.
    // Inside the try because a missing env var throws here, and a throw out of
    // a background function makes Netlify re-run the whole invocation.
    if (req.headers.get("x-telegram-bot-api-secret-token") !== app.telegram.webhookSecret()) {
      console.warn("Rejected Telegram update with a bad or missing secret token.");
      return accepted;
    }

    let update;
    try {
      update = await req.json();
    } catch {
      console.warn("Telegram update was not JSON.");
      return accepted;
    }

    const callbackQuery = update.callback_query;
    const message = update.message || update.edited_message;

    // Auth gate 2: only you. The bot's username is discoverable, so this is
    // what actually stops strangers from driving the pipeline.
    const fromId = String(callbackQuery?.from?.id ?? message?.chat?.id ?? "");
    if (fromId !== app.telegram.chatId()) {
      if (fromId) console.warn(`Ignoring update from unauthorised id ${fromId}.`);
      return accepted;
    }

    if (callbackQuery) {
      await handleCallback(callbackQuery);
    } else if (message?.text?.trim()) {
      await handleMessage(message.text.trim());
    }
  } catch (err) {
    // Never rethrow: Netlify would retry this whole invocation twice.
    console.error("Telegram handler error:", err);
    await sendMessage(`Something went wrong: ${err.message}`).catch(() => {});
  }

  return accepted;
};

export const config = { path: "/telegram", background: true };
