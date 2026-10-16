// ---------------------------------------------------------------------------
// Parsing for the /join command. Pure functions, no I/O, so the whole grammar
// is unit-testable offline (scripts/test-render.js) rather than only through a
// mocked HTTP round trip.
//
// Grammar, in the order it is tried:
//
//   /join <link> "Weekly sync" thai     quoted  — unambiguous, recommended
//   /join <link> "Weekly sync"          quoted, language defaults
//   /join <link> Weekly sync thai       bare    — trailing alias word only
//   /join <link> Weekly sync            bare, language defaults
//   ... plus an explicit --lang <code> in either form.
//
// Quoted and bare titles deliberately resolve the trailing language token
// differently. See resolveLanguage().
// ---------------------------------------------------------------------------

/** Friendly words -> the code Fireflies wants. Add languages you meet in here. */
export const LANGUAGE_ALIASES = {
  auto: "auto",
  detect: "auto",
  en: "en",
  eng: "en",
  english: "en",
  th: "th",
  thai: "th",
};

// Fireflies caps `language` at 5 characters and documents ISO-639-1 style
// codes ("th", "en-US"). A longer value cannot be sent at all — and must never
// be truncated, since "multi-language" would silently become "multi".
export const MAX_LANGUAGE_LENGTH = 5;
const CODE_SHAPE = /^[a-z]{2}(-[a-z0-9]{2,3})?$/i;

// Telegram on iOS/macOS silently converts " into smart quotes, so a parser
// that only knows about ASCII quotes would reject what the user actually sees
// themselves typing.
const QUOTE_PAIRS = {
  '"': '"',
  "'": "'",
  "“": "”", // “ ”
  "‘": "’", // ‘ ’
  "«": "»", // « »
};

const LANGUAGE_HELP = 'Use "thai", "english", or a code like th, en, ja, zh-CN.';

/**
 * Resolves one token to a Fireflies language code.
 * @returns {{code: string} | {error: string}}
 */
export function resolveLanguage(token) {
  const raw = String(token ?? "").trim();
  if (!raw) return { error: `No language given. ${LANGUAGE_HELP}` };

  const alias = LANGUAGE_ALIASES[raw.toLowerCase()];
  if (alias) return { code: alias };

  // Pass through any well-formed code so languages absent from the alias table
  // still work. Case is preserved because region subtags are conventionally
  // upper-case ("zh-CN") and Fireflies may or may not normalise them.
  if (CODE_SHAPE.test(raw)) {
    if (raw.length > MAX_LANGUAGE_LENGTH) {
      return { error: `Fireflies allows at most ${MAX_LANGUAGE_LENGTH} characters for a language code, and "${raw}" is longer.` };
    }
    return { code: raw };
  }

  return { error: `I don't recognise "${raw}" as a language. ${LANGUAGE_HELP}` };
}

/** Pulls an explicit "--lang <code>" out of a token list, mutating it. */
function takeLangFlag(tokens) {
  const at = tokens.indexOf("--lang");
  if (at === -1) return null;
  const value = tokens[at + 1];
  tokens.splice(at, value === undefined ? 1 : 2);
  return resolveLanguage(value);
}

/**
 * @returns {{link: string, title: string, language: string|null, quoted: boolean} | {error: string}}
 *          `language: null` means "not specified" — the caller falls back to
 *          config.fireflies.defaultLanguage.
 */
export function parseJoinCommand(argText) {
  const trimmed = String(argText ?? "").trim();
  if (!trimmed) {
    return { error: 'Usage: /join <meeting link> "<title>" [language]' };
  }

  // The link is the first whitespace-delimited token; everything after it is
  // the title (and possibly a language), kept as raw text so quotes survive.
  const firstSpace = trimmed.search(/\s/);
  const linkPart = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  let link;
  try {
    link = new URL(linkPart);
    if (link.protocol !== "http:" && link.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    return { error: `That doesn't look like a meeting link: ${linkPart}` };
  }

  const closing = QUOTE_PAIRS[rest[0]];

  // ---- Quoted title: the title's boundary is explicit, so anything after the
  // closing quote is unambiguously a language and a bad value is an error
  // rather than something to fold back into the title.
  if (closing) {
    const end = rest.indexOf(closing, 1);
    if (end === -1) {
      return { error: `You opened a quote but never closed it. Try: /join <link> "Weekly sync" thai` };
    }

    const title = rest.slice(1, end).trim();
    const after = rest.slice(end + 1).trim();
    if (!after) return { link: link.href, title, language: null, quoted: true };

    const tokens = after.split(/\s+/);
    let token;
    if (tokens[0] === "--lang") {
      if (tokens.length !== 2) return { error: '"--lang" needs exactly one language after it.' };
      token = tokens[1];
    } else if (tokens.length === 1) {
      token = tokens[0];
    } else {
      return {
        error: `I couldn't tell what "${after}" means. After the quoted title, write only a language. ${LANGUAGE_HELP}`,
      };
    }

    const resolved = resolveLanguage(token);
    if (resolved.error) return { error: resolved.error };
    return { link: link.href, title, language: resolved.code, quoted: true };
  }

  // ---- Bare title: no explicit boundary, so be conservative.
  const tokens = rest ? rest.split(/\s+/) : [];

  const flagged = takeLangFlag(tokens);
  if (flagged) {
    if (flagged.error) return { error: flagged.error };
    return { link: link.href, title: tokens.join(" ").trim(), language: flagged.code, quoted: false };
  }

  // Only the alias table applies here — never the general code shape. A bare
  // title can legitimately end in a two-letter word ("Sync AI", "Plan B"), and
  // silently reading that as a language would be worse than ignoring it.
  if (tokens.length > 0) {
    const alias = LANGUAGE_ALIASES[tokens.at(-1).toLowerCase()];
    if (alias) {
      tokens.pop();
      return { link: link.href, title: tokens.join(" ").trim(), language: alias, quoted: false };
    }
  }

  return { link: link.href, title: tokens.join(" ").trim(), language: null, quoted: false };
}

// ---------------------------------------------------------------------------
// Joining from a screenshot. The chat agent reads the calendar event and calls
// the join_meeting tool; these pure functions turn what it read into a link
// Fireflies accepts, and into the confirmation card the Send button acts on.
//
// The card is the state. Telegram's callback_data is capped at 64 bytes, far
// too small for a Teams link, and the bot keeps no store between messages, so
// the Send button re-reads the details from the card's own text — which
// Telegram hands back with every callback. formatJoinCard and parseJoinCard
// must therefore stay exact inverses; scripts/test-render.js holds them to it.
// ---------------------------------------------------------------------------

export const JOIN_PLATFORMS = ["teams", "zoom", "google_meet", "webex", "other"];

/** Fireflies' cap on meeting_password; mirrored here so a card never offers one it would refuse. */
const MAX_PASSCODE_LENGTH = 32;

/**
 * A join link from either a visible URL or a meeting ID (+ passcode).
 *
 * Teams: Outlook and Teams calendar events usually show only "Meeting ID" and
 * "Passcode" in the body, with the real link hidden behind "Join the meeting
 * now". Teams accepts https://teams.microsoft.com/meet/<id>?p=<passcode> for
 * exactly that pair, so the link is built rather than guessed.
 *
 * @returns {{link: string, password: string|null} | {error: string}}
 */
export function buildJoinLink({ platform, meeting_link, meeting_id, passcode } = {}) {
  const password = String(passcode ?? "").trim() || null;
  if (password && password.length > MAX_PASSCODE_LENGTH) {
    return { error: `That passcode is longer than the ${MAX_PASSCODE_LENGTH} characters Fireflies accepts.` };
  }

  if (meeting_link) {
    let url;
    try {
      url = new URL(String(meeting_link).trim());
    } catch {
      return { error: `"${meeting_link}" is not a valid link.` };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { error: `"${meeting_link}" is not a web link Fireflies can join.` };
    }
    return { link: url.href, password };
  }

  const id = String(meeting_id ?? "").trim();
  if (!id) return { error: "I need either the join link or the meeting ID to send Fireflies." };

  switch (platform) {
    case "teams": {
      const digits = id.replace(/\s+/g, "");
      if (!/^\d{9,15}$/.test(digits)) return { error: `"${id}" doesn't look like a Teams meeting ID (9-15 digits).` };
      const query = password ? `?p=${encodeURIComponent(password)}` : "";
      return { link: `https://teams.microsoft.com/meet/${digits}${query}`, password };
    }
    case "zoom": {
      const digits = id.replace(/[\s-]+/g, "");
      if (!/^\d{9,11}$/.test(digits)) return { error: `"${id}" doesn't look like a Zoom meeting ID (9-11 digits).` };
      return { link: `https://zoom.us/j/${digits}`, password };
    }
    case "google_meet": {
      const letters = id.toLowerCase().replace(/[\s-]+/g, "");
      if (!/^[a-z]{10}$/.test(letters)) return { error: `"${id}" doesn't look like a Google Meet code (xxx-xxxx-xxx).` };
      return { link: `https://meet.google.com/${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`, password: null };
    }
    default:
      return { error: "I can only build a link from a meeting ID for Teams, Zoom and Google Meet. Send the full join link instead." };
  }
}

const CARD_HEADING = "Send Fireflies to this meeting?";
const CARD_FIELDS = { title: "Title", link: "Link", password: "Passcode", language: "Language", starts: "Starts" };

/**
 * The confirmation card. Plain text, one "Label: value" per line, so the
 * values survive the round trip through Telegram untouched.
 */
export function formatJoinCard({ link, title, password, language, starts }, { note } = {}) {
  const line = (key, value) => (value ? `${CARD_FIELDS[key]}: ${String(value).replace(/\s*\n\s*/g, " ")}` : null);
  return [
    CARD_HEADING,
    "",
    line("title", title),
    line("link", link),
    line("password", password),
    line("language", language || "auto"),
    line("starts", starts),
    "",
    "Check the link and passcode against your screenshot before you tap Send.",
    ...(note ? ["", note] : []),
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** Reads a card back. Null when the text is not a card or has no link. */
export function parseJoinCard(text) {
  const body = String(text ?? "");
  if (!body.startsWith(CARD_HEADING)) return null;
  const read = (key) => body.match(new RegExp(`^${CARD_FIELDS[key]}: (.+)$`, "m"))?.[1].trim() || null;
  const link = read("link");
  if (!link) return null;
  const language = read("language");
  return {
    link,
    title: read("title"),
    password: read("password"),
    language: language && language !== "auto" ? language : null,
    starts: read("starts"),
  };
}
