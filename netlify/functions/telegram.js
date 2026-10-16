import { config as app, resolveTier, isTierKey } from "../../lib/config.js";
import { sendMessage, answerCallbackQuery, editMessageText, downloadFile, JOIN_KEYBOARD } from "../../lib/telegram.js";
import { findMeetingByFirefliesId, findSweepablePages } from "../../lib/notion.js";
import { promoteMeeting, skipMeeting, formatUnsummarised } from "../../lib/promote.js";
import { notesRecap } from "../../lib/notes.js";
import { addToLiveMeeting, getUsage, FirefliesError } from "../../lib/fireflies.js";
import { formatReport } from "../../lib/usage.js";
import { parseJoinCommand, parseJoinCard, formatJoinCard } from "../../lib/join.js";
import { runAgent } from "../../lib/agent.js";

// ---------------------------------------------------------------------------
// Telegram webhook.
//
// A BACKGROUND function: Netlify returns 202 the moment it is invoked, which
// is all Telegram needs, and the handler then gets up to 15 minutes. That is
// what makes it possible to run a full transcript extraction inline on a Haiku
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
  "Or send a screenshot of the calendar event (Teams/Outlook) showing the join",
  "  link, or the Meeting ID and Passcode. I'll show what I read, and Fireflies",
  "  joins when you tap Send.",
  "/sweep — list meetings that have no recap yet (nothing is recapped for you)",
  "/space — how much Fireflies transcription storage is left",
  "/help — this message",
  "",
  "When a transcript is ready I'll ask how to recap it, and tell you how much",
  "Fireflies storage is left. The buttons:",
  "  Claude / ChatGPT — open the app with the recap prompt filled in. The",
  "           recap runs on your subscription, not the API, and lands on the",
  "           same Notion page. Copy prompt is there if the app opens empty.",
  "  Haiku  — an API recap, cheap. Only runs when you tap it; nothing recaps",
  "           automatically. /sweep and the Tue/Fri reminder just list what's",
  "           still waiting.",
  "  Skip   — no recap; the page stays as a record that the meeting happened.",
  "",
  "Anything else you type, I answer from your meeting notes:",
  '- "what did we decide about the 5G report?"',
  '- "what happened in the UAT meeting last week?"',
  '- "add a note to the UAT meeting: Joao agreed to send the policy draft"',
].join("\n");

/**
 * The one place Fireflies is asked to join, shared by /join and the Send
 * button on a screenshot's join card. Never throws.
 * @returns {{ ok: boolean, rateLimited?: boolean, text: string }}
 */
async function dispatchJoin({ link, title, language, password }) {
  try {
    const result = await addToLiveMeeting({ meeting_link: link, title: title || undefined, language, meeting_password: password });
    if (result?.success === false) {
      return { ok: false, text: `Fireflies refused to join: ${result.message || "no reason given"}` };
    }
    // Echo the resolved language back: it is the only way to notice that a
    // title was mis-read as a language, or vice versa, before the meeting ends.
    const used = language || app.fireflies.defaultLanguage;
    const languageNote = used === "auto" ? "auto-detecting the language" : `language: ${used}`;
    return {
      ok: true,
      text: `Fireflies is joining${title ? ` "${title}"` : ""} (${languageNote}). I'll ask about a recap when the transcript is ready.`,
    };
  } catch (err) {
    if (err instanceof FirefliesError && err.isRateLimited) {
      return { ok: false, rateLimited: true, text: "Fireflies is rate limited — it allows 3 join requests per 20 minutes." };
    }
    return { ok: false, text: `Could not ask Fireflies to join: ${err.message}` };
  }
}

async function handleJoin(argText) {
  const parsed = parseJoinCommand(argText);
  if (parsed.error) return sendMessage(parsed.error);

  const result = await dispatchJoin(parsed);
  // No retry button for /join: callback_data is capped at 64 bytes and a Teams
  // link is far longer, so there is nowhere to keep the link.
  return sendMessage(result.rateLimited ? `${result.text} Wait a few minutes and send the same /join again.` : result.text);
}

/**
 * Send / Cancel on a screenshot's join card. The details come back out of the
 * card's own text (see lib/join.js), so the bot needs no storage.
 */
async function handleJoinCallback(callbackQuery, choice) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (choice === "cancel") {
    await answerCallbackQuery(callbackQuery.id, "Cancelled");
    return editMessageText(chatId, messageId, "Cancelled — Fireflies was not sent.");
  }

  const details = parseJoinCard(callbackQuery.message?.text);
  if (choice !== "send" || !details) {
    await answerCallbackQuery(callbackQuery.id, "Can't read this card");
    return editMessageText(chatId, messageId, "I couldn't read the meeting details back from this card. Send the screenshot again.");
  }

  await answerCallbackQuery(callbackQuery.id, "Sending Fireflies");
  // Removes the buttons first, so a double tap cannot spend a second join.
  await editMessageText(chatId, messageId, `Sending Fireflies to ${details.title ? `"${details.title}"` : "the meeting"}...`);

  const result = await dispatchJoin(details);
  if (result.rateLimited) {
    // Unlike /join, the card still holds the link, so the button can come back.
    return editMessageText(chatId, messageId, formatJoinCard(details, { note: `${result.text} Tap Send again in a few minutes.` }), {
      replyMarkup: JOIN_KEYBOARD,
    });
  }
  return editMessageText(chatId, messageId, result.text);
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

  return sendMessage(formatUnsummarised(pending));
}

async function handleCallback(callbackQuery) {
  const [rawAction, meetingId] = String(callbackQuery.data || "").split(":");
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (rawAction === "join") return handleJoinCallback(callbackQuery, meetingId);

  // A prompt sitting in scrollback from before the tiers shipped still sends
  // "yes:". Map it to the default tier rather than answering "Unrecognised".
  const action = rawAction === "yes" ? app.extractTiers[0].key : rawAction;
  const tier = isTierKey(action) ? resolveTier(action) : null;

  // Always answer, or the client shows a spinner until it times out.
  await answerCallbackQuery(
    callbackQuery.id,
    tier ? `Working on it — ${tier.label}` : action === "no" ? "Skipping" : undefined
  );

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
          `Recap it in Claude or ChatGPT if you'd rather not wait.`
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

  return replyWithAgent(text);
}

async function replyWithAgent(input) {
  const { text: reply, usage } = await runAgent(input);
  console.log(`Handled message. Tokens in=${usage.input} out=${usage.output}`);
  // Empty only when a join card already went out and there is nothing to add.
  if (reply) await sendMessage(reply);
}

// The formats the model API reads. Telegram converts a PHOTO to JPEG itself;
// an image sent as a FILE arrives in whatever format it was saved in.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// The model API's per-image limit.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * A photo, or an image sent as a file (which keeps full resolution — better
 * for the small print of a meeting ID), goes to the agent with its caption.
 */
async function handleImage(message) {
  const photo = message.photo?.at(-1); // Telegram lists sizes smallest first
  const file = photo
    ? { id: photo.file_id, size: photo.file_size, mediaType: "image/jpeg" }
    : { id: message.document.file_id, size: message.document.file_size, mediaType: documentType(message.document) };

  if (!IMAGE_TYPES.has(file.mediaType)) {
    return sendMessage(
      `I can read JPEG, PNG, GIF or WebP images, and this file is ${file.mediaType || "an unknown type"}. Send it as a photo instead and Telegram converts it.`
    );
  }
  const tooBig = "That image is over 5 MB. Send it as a photo rather than a file, or crop it to the meeting details.";
  if (file.size > MAX_IMAGE_BYTES) return sendMessage(tooBig);

  let downloaded;
  try {
    downloaded = await downloadFile(file.id);
  } catch (err) {
    return sendMessage(`I couldn't download that image from Telegram: ${err.message}`);
  }
  if (downloaded.bytes > MAX_IMAGE_BYTES) return sendMessage(tooBig);

  const caption = message.caption?.trim();
  return replyWithAgent({
    text: caption || "(The user sent this image with no caption.)",
    images: [{ mediaType: file.mediaType, data: downloaded.data }],
  });
}

const EXTENSION_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic" };
/** Telegram usually reports a file's MIME type, but not always; fall back to the extension. */
const documentType = (doc) => doc.mime_type || EXTENSION_TYPES[(doc.file_name || "").split(".").pop().toLowerCase()];

const isImageFile = (doc) => Boolean(doc && documentType(doc)?.startsWith("image/"));

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
    // Edits are deliberately ignored: re-running an edited /join would spend
    // another of the 3 joins per 20 minutes, and an edited question would get
    // a second answer under the old one.
    const message = update.message;

    // Auth gate 2: only you. The bot's username is discoverable, so this is
    // what actually stops strangers from driving the pipeline.
    const fromId = String(callbackQuery?.from?.id ?? message?.chat?.id ?? "");
    if (fromId !== app.telegram.chatId()) {
      if (fromId) console.warn(`Ignoring update from unauthorised id ${fromId}.`);
      return accepted;
    }

    if (callbackQuery) {
      await handleCallback(callbackQuery);
    } else if (message?.photo?.length || isImageFile(message?.document)) {
      await handleImage(message);
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
