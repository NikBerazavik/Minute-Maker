// ---------------------------------------------------------------------------
// Central configuration. Everything environment-dependent lives here so you
// never have to hunt through the codebase to change a property name or model.
// Secrets are read lazily (functions) so importing this module never throws
// in a context that doesn't need a given secret (e.g. scripts/test-render.js).
// ---------------------------------------------------------------------------

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  llm: {
    // "anthropic" (direct API) today. "openrouter" is a documented slot — see
    // lib/llm/openrouter.js — for trialling other models later without
    // touching extract.js or agent.js.
    provider: process.env.LLM_PROVIDER || "anthropic",
    model: process.env.LLM_MODEL || "claude-sonnet-5",
    // Extraction can run on a different model than chat, e.g. to A/B recap quality.
    extractModel: () => process.env.LLM_EXTRACT_MODEL || config.llm.model,
    extractMaxTokens: 16000,
    // Strict tool schemas guarantee the extraction validates against the
    // schema. Set LLM_STRICT_TOOLS=0 if a provider or model rejects the
    // schema (extract.js validates the result either way).
    strictTools: process.env.LLM_STRICT_TOOLS !== "0",
    chatMaxTokens: 4096,
    // Extended thinking for the CHAT loop and as the fallback for any request
    // that does not carry its own. "adaptive" is a Claude-5-family parameter —
    // older models (e.g. claude-haiku-4-5) reject it with a 400. Extraction no
    // longer reads this: each tier below carries its own thinking mode, which
    // is what lets Haiku and Sonnet be selectable on the same deployment.
    thinking: process.env.LLM_THINKING || "adaptive",
    anthropic: {
      apiKey: () => required("ANTHROPIC_API_KEY"),
      apiVersion: "2023-06-01",
    },
    openrouter: {
      apiKey: () => required("OPENROUTER_API_KEY"),
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
    },
  },

  // Extraction tiers — one per button on the Telegram keyboard. This table is
  // the single source of truth: the keyboard, the callback router and
  // promoteMeeting all read it, and nothing about a tier is defined elsewhere.
  //
  //   model:       Anthropic model id, or an OpenRouter-namespaced id when
  //                LLM_PROVIDER=openrouter, or null for the no-LLM Notes tier.
  //   thinking:    per-tier, not global, because Haiku 4.5 rejects "adaptive"
  //                with a 400 (see llm.thinking above). This is the whole
  //                reason a per-request thinking mode had to exist.
  //   extractedBy: literal written to the Notion "Extracted By" property, or
  //                null to write the resolved model id instead.
  //
  //   offered:     whether the tier gets a button on NEW prompts. A tier that
  //                is not offered stays fully routable, so a Sonnet or Notes
  //                button still sitting in Telegram scrollback keeps working,
  //                and so do Notes claims already waiting on Fireflies.
  //
  // The FIRST entry is the default tier: it is what /sweep, the scheduled
  // sweep, and a legacy "yes:" callback all resolve to.
  extractTiers: [
    {
      key: "haiku",
      label: "Haiku",
      model: process.env.LLM_MODEL_HAIKU || "claude-haiku-4-5-20251001",
      thinking: "off",
      extractedBy: null,
      offered: true,
    },
    {
      key: "sonnet",
      label: "Sonnet",
      model: process.env.LLM_MODEL_SONNET || "claude-sonnet-5",
      thinking: process.env.LLM_THINKING || "adaptive",
      extractedBy: null,
      offered: false, // replaced by the Claude / ChatGPT chat buttons
    },
    {
      key: "notes",
      label: "Notes",
      model: null, // no LLM at all — Fireflies' own summary, rendered verbatim
      thinking: null,
      extractedBy: "fireflies-notes",
      offered: false, // replaced by the Claude / ChatGPT chat buttons
    },
  ],

  // Chat hand-off — the Claude and ChatGPT buttons. These are URL buttons, not
  // callbacks: tapping one opens the app (or its website, if the app does not
  // claim the link) with the recap prompt already filled in, and the recap runs
  // on your chat SUBSCRIPTION through the Fireflies + Notion connectors. The bot
  // never hears about the tap, and does not need to: the chat skill fills the
  // existing stub page and sets Status = Done, which is what keeps the sweep
  // off it. `{prompt}` is replaced with the URL-encoded prompt.
  chatApps: [
    { key: "claude", label: "Claude", url: process.env.CLAUDE_CHAT_URL || "https://claude.ai/new?q={prompt}" },
    { key: "chatgpt", label: "ChatGPT", url: process.env.CHATGPT_CHAT_URL || "https://chatgpt.com/?q={prompt}" },
  ],
  // `{title}` and `{id}` are filled per meeting. The Fireflies id is what makes
  // the skill pick the right meeting without asking; the title is for you.
  chatPrompt:
    process.env.CHAT_RECAP_PROMPT ||
    'Recap my Fireflies meeting "{title}" (Fireflies transcript ID: {id}) into my Notion Meetings database.',

  notion: {
    apiKey: () => required("NOTION_API_KEY"),
    // DATABASE id from the Notion URL; resolved to a data source id at runtime.
    meetingsDbId: () => required("NOTION_MEETINGS_DB_ID"),
    // Pinned deliberately. Notion ships breaking changes between versions.
    apiVersion: "2025-09-03",
  },

  telegram: {
    botToken: () => required("TELEGRAM_BOT_TOKEN"),
    chatId: () => required("TELEGRAM_CHAT_ID"),
    webhookSecret: () => required("TELEGRAM_WEBHOOK_SECRET"),
  },

  fireflies: {
    apiKey: () => required("FIREFLIES_API_KEY"),
    webhookSecret: () => required("FIREFLIES_WEBHOOK_SECRET"),
    endpoint: "https://api.fireflies.ai/graphql",
    // ISO 639-1-ish code, max 5 chars ("th", "en-US", ...), or "auto" to let
    // Fireflies detect the meeting's language itself. Fireflies defaults to
    // English when no language is passed at all, which is wrong often enough
    // for a mixed Thai/English team that "auto" is the better default here.
    defaultLanguage: process.env.FIREFLIES_LANGUAGE || "auto",
    // Free-plan storage meter, reported by /space. `minutes_consumed` from the
    // Fireflies user query is measured against `minutesAllowance`. The warning
    // threshold sits well below the cap on purpose: the point is to clear
    // transcripts BEFORE a meeting is refused, not to find the ceiling by
    // hitting it.
    minutesAllowance: Number(process.env.FIREFLIES_MINUTES_ALLOWANCE) || 400,
    minutesWarnAt: Number(process.env.FIREFLIES_MINUTES_WARN_AT) || 320,
  },

  // Guards the /promote background function, whose URL is public.
  internalSecret: () => required("INTERNAL_SECRET"),

  // Netlify injects URL (the site's primary URL) at runtime. DEPLOY_URL is the
  // local fallback so `netlify dev` and scripts work the same way.
  siteUrl: () => process.env.URL || process.env.DEPLOY_URL || "http://localhost:8888",

  // Thailand is UTC+7 with no daylight saving, so a fixed offset is correct.
  timezone: process.env.TIMEZONE || "Asia/Bangkok",
  utcOffset: process.env.UTC_OFFSET || "+07:00",

  // Notion property names — matched exactly by the API.
  props: {
    name: "Name",
    date: "Date",
    sourceId: "Source Meeting ID",
    status: "Status",
    // Added by hand in Notion. "Extraction State" is a Select (NOT Notion's
    // Status type: no lifecycle grouping wanted, and a Select auto-creates a
    // missing option on write so a typo fails soft). "Extracted By" is Text,
    // never a Select — model ids change every release and dead Select options
    // would pile up forever.
    extractionState: "Extraction State",
    extractedBy: "Extracted By",
  },

  // Status select options — must exist in Notion with this exact spelling.
  status: {
    pending: "Pending",
    processing: "Processing",
    done: "Done",
    skipped: "Skipped",
    failed: "Failed",
  },

  // The only "Extraction State" option. Empty means nothing is pending, which
  // is the normal state of almost every page and needs no migration. Matched
  // LITERALLY against Notion, so if the option was created with a different
  // spelling either rename it there or set NOTES_STATE_LABEL to match.
  extractionState: {
    pendingNotes: process.env.NOTES_STATE_LABEL || "Pending Notes",
  },

  // How long a Notes stub waits for Fireflies' summary before the sweep gives
  // up on it, marks it Failed and releases the claim so /sweep can retry it
  // with a model.
  notesBackstopHours: Number(process.env.NOTES_BACKSTOP_HOURS) || 24,

  // A page left in Processing longer than this is treated as abandoned
  // (function crashed mid-run) and becomes eligible for the sweep again.
  staleProcessingMinutes: 30,

  // Fixed body text / headings. render.js and notion.js both reference these.
  text: {
    awaiting: "Awaiting recap decision — choose a recap tier in Telegram.",
    skipped: "Skipped — no recap requested.",
    summaryHeading: "Summary",
    actionsHeading: "Action items",
    postMeetingHeading: "Post-meeting notes",
  },
};

/**
 * A tier key from a callback, resolved to its table entry. Anything unknown —
 * including the legacy "yes:" callback from a prompt still sitting in Telegram
 * scrollback from before the tiers shipped — falls back to the default tier.
 */
export function resolveTier(key) {
  return config.extractTiers.find((t) => t.key === key) || config.extractTiers[0];
}

/**
 * True for a key that routes to a tier (so "yes"/"no" are excluded). Includes
 * tiers that are no longer offered — old prompts in scrollback still send them.
 */
export function isTierKey(key) {
  return config.extractTiers.some((t) => t.key === key);
}
