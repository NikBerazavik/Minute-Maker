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

/** Telegram's cap on a copy_text button's text. */
const COPY_TEXT_LIMIT = 256;
/** Keeps the default prompt well inside COPY_TEXT_LIMIT whatever the title. */
const PROMPT_TITLE_LIMIT = 100;

/** The chat hand-off prompt for one meeting, from config.chatPrompt. */
export function chatPrompt(meetingId, title) {
  const t = title.length > PROMPT_TITLE_LIMIT ? `${title.slice(0, PROMPT_TITLE_LIMIT - 1)}…` : title;
  return config.chatPrompt.replaceAll("{title}", t).replaceAll("{id}", meetingId);
}

/**
 * The prompt for a freshly transcribed meeting:
 *
 *     [ Claude ] [ ChatGPT ]     URL buttons — open the app with the prompt filled in
 *     [ Haiku  ] [ Skip    ]     callbacks — the API recap, or no recap
 *     [    Copy prompt     ]     for when an app drops the prefilled text
 *
 * The chat row comes from config.chatApps and the callback row from the
 * OFFERED tiers in config.extractTiers plus a literal Skip, so changing either
 * never touches this file. callback_data is capped at 64 bytes by Telegram;
 * the longest key a prompt can carry ("sonnet:" + a 26-char Fireflies id) is
 * 33, and scripts/test-flow.js asserts it.
 *
 * `title` is the real meeting title when the webhook could fetch it, else the
 * timestamp label. `extra` is appended below the question — the storage meter
 * uses it, so the minutes reading arrives with the decision it informs.
 */
export async function sendTierPrompt(meetingId, { label, title, extra } = {}) {
  const name = title || label;
  const prompt = chatPrompt(meetingId, name);

  const chat = config.chatApps.map((a) => ({ text: a.label, url: a.url.replace("{prompt}", encodeURIComponent(prompt)) }));
  const tiers = config.extractTiers
    .filter((t) => t.offered)
    .map((t) => ({ text: t.label, callback_data: `${t.key}:${meetingId}` }));
  const callbacks = [...tiers, { text: "Skip", callback_data: `no:${meetingId}` }];

  const rows = [chat];
  for (let i = 0; i < callbacks.length; i += 2) rows.push(callbacks.slice(i, i + 2));
  // Telegram rejects the WHOLE message over an oversized copy_text, so a long
  // custom CHAT_RECAP_PROMPT loses this one button rather than the prompt.
  if (prompt.length <= COPY_TEXT_LIMIT) rows.push([{ text: "Copy prompt", copy_text: { text: prompt } }]);
  else console.warn(`Chat prompt is ${prompt.length} chars; Telegram's copy button allows ${COPY_TEXT_LIMIT}.`);

  const text = [`Transcript ready: ${name}`, "", "How should I recap it?", ...(extra ? ["", extra] : [])].join("\n");
  return sendMessage(text, { replyMarkup: { inline_keyboard: rows } });
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
