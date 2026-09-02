import { config } from "./config.js";

const TELEGRAM_LIMIT = 4096;

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    console.error(`Telegram ${method} failed:`, res.status, json.description || "");
  }
  return json;
}

/**
 * Sends a plain-text message to your chat, chunked to Telegram's 4096 limit.
 * Plain text on purpose: Telegram's Markdown parser rejects the whole message
 * on an unescaped "_" or "*", which meeting titles contain often enough.
 * An inline keyboard, if given, is attached to the LAST chunk only.
 */
export async function sendMessage(text, { replyMarkup, chatId = config.telegram.chatId() } = {}) {
  const chunks = splitMessage(String(text || "").trim() || "(empty response)");
  let last;
  for (let i = 0; i < chunks.length; i++) {
    const body = { chat_id: chatId, text: chunks[i], disable_web_page_preview: true };
    if (replyMarkup && i === chunks.length - 1) body.reply_markup = replyMarkup;
    last = await api("sendMessage", body);
  }
  return last?.result;
}

/**
 * Yes/No prompt for a freshly transcribed meeting. callback_data is capped at
 * 64 bytes by Telegram; "yes:" + a 26-char Fireflies id is well inside that.
 */
export async function sendYesNoPrompt(meetingId, label) {
  return sendMessage(`Transcript ready: ${label}\n\nCreate a recap in Notion?`, {
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "Yes — make recap", callback_data: `yes:${meetingId}` },
          { text: "No — skip", callback_data: `no:${meetingId}` },
        ],
      ],
    },
  });
}

/** Must be called for every callback_query or the client shows a spinner. */
export async function answerCallbackQuery(callbackQueryId, text) {
  return api("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

/** Editing without reply_markup removes the inline keyboard — prevents double taps. */
export async function editMessageText(chatId, messageId, text) {
  return api("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: String(text).slice(0, TELEGRAM_LIMIT),
    disable_web_page_preview: true,
  });
}

export async function getMe() {
  return api("getMe");
}

/** Break on newlines where possible so a bullet isn't cut in half. */
export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
