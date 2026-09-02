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
    anthropic: {
      apiKey: () => required("ANTHROPIC_API_KEY"),
      apiVersion: "2023-06-01",
    },
    openrouter: {
      apiKey: () => required("OPENROUTER_API_KEY"),
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
    },
  },

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
  },

  // Status select options — must exist in Notion with this exact spelling.
  status: {
    pending: "Pending",
    processing: "Processing",
    done: "Done",
    skipped: "Skipped",
    failed: "Failed",
  },

  // A page left in Processing longer than this is treated as abandoned
  // (function crashed mid-run) and becomes eligible for the sweep again.
  staleProcessingMinutes: 30,

  // Fixed body text / headings. render.js and notion.js both reference these.
  text: {
    awaiting: "Awaiting recap decision — reply Yes/No in Telegram.",
    skipped: "Skipped — no recap requested.",
    summaryHeading: "Summary",
    actionsHeading: "Action items",
    postMeetingHeading: "Post-meeting notes",
  },
};
