# Minute Maker

Telegram → Fireflies → Claude → Notion. You ask the Fireflies bot to join a
meeting; when the transcript is ready the bot asks how you want it recapped —
in your Claude or ChatGPT app (on your subscription), with a cheap Haiku API
call, or not at all — and the result lands in Notion as a permanent record.

The point is **migration**, not task automation. Fireflies' free tier caps
transcript storage at ~400 minutes and never purges on its own, so transcripts
pile up until you clear them by hand. Once a meeting is in Notion you can
delete it from Fireflies without losing anything.

Zero runtime dependencies — everything uses native `fetch`. Hosted on Netlify.

---

## Flow

```
/join <link> <title>
   └─ Telegram ──▶ Fireflies addToLiveMeeting          (deterministic, no model)

... the meeting happens, Fireflies transcribes ...

Fireflies webhook (meeting.transcribed)
   └─ /fireflies ──▶ verify X-Hub-Signature
                 ──▶ stub page in Notion (Status: Pending)
                 ──▶ Telegram prompt: [Claude][ChatGPT] / [Haiku][Skip] / [Copy prompt]
                     + how many of your 400 Fireflies minutes are left

Claude / ChatGPT ──▶ opens the app with the recap prompt prefilled (no bot call)
                 ──▶ the chat's meeting-recap skill fills the SAME page, Status: Done
Haiku  ──▶ /telegram ──▶ fetch transcript ──▶ extraction on claude-haiku-4-5
                     ──▶ recap written to the page, Status: Done
Sonnet, Notes — retired from the keyboard; still routed for old prompts:
Sonnet ──▶ /telegram ──▶ fetch transcript ──▶ extraction on claude-sonnet-5
Notes  ──▶ /telegram ──▶ fetch Fireflies' OWN summary, no model at all
                     ──▶ if it's ready: same page shape, Status: Done
                     ──▶ if not: Extraction State = Pending Notes, and:
Fireflies webhook (meeting.summarized)
       └─ /fireflies ──▶ /promote (mode: notes) ──▶ finishes the page
Skip   ──▶ page body becomes "Skipped", Status: Skipped, page KEPT

Tue+Fri 22:00 ──▶ sweep ──▶ Telegram list of meetings with no recap (NO model call)
                        ──▶ 24h backstop for stranded Notes stubs (no model)
/sweep        ──▶ same list, on demand (Failed meetings included)
/space        ──▶ Fireflies storage meter (one API call, no LLM, no Notion)

Anything else you type ──▶ tool-use loop over your meeting notes
```

Every model-tier trigger — a Haiku or Sonnet tap and a redelivered webhook — goes through one function,
`promoteMeeting()` in [lib/promote.js](lib/promote.js). Every Notes-tier
trigger goes through `completeNotes()` in [lib/notes.js](lib/notes.js). Both
ask the same `eligibility()` function whether the meeting has already been
handled, so the tiers cannot drift apart on what "already done" means.

### The buttons

| Button | Model | Thinking | Cost | Writes `Extracted By` |
|---|---|---|---|---|
| **Claude** / **ChatGPT** | whatever the chat runs | — | your chat subscription, zero API tokens | the chat's model name (set by the skill) |
| **Haiku** | `claude-haiku-4-5-20251001` | off — Haiku 4.5 rejects `adaptive` with a 400 | cheap tokens | the model id |
| **Skip** | none | — | nothing | — |
| **Copy prompt** | — | — | — | — |

Retired from new prompts but still routed, so a button in scrollback keeps
working: **Sonnet** (`claude-sonnet-5`, `adaptive`) and **Notes** (Fireflies'
own summary, no model). A tier's `offered` flag in
[lib/config.js](lib/config.js) is what decides whether it gets a button.

### The chat hand-off (Claude / ChatGPT)

These are Telegram **URL buttons**, not callbacks: the bot never hears about
the tap. Each opens `https://claude.ai/new?q=…` or `https://chatgpt.com/?q=…`
with this prompt filled in:

```
Recap my Fireflies meeting "<title>" (Fireflies transcript ID: <id>) into my Notion Meetings database.
```

The chat's own meeting-recap skill (Fireflies + Notion connectors) does the
rest. It looks the page up by `Source Meeting ID`, fills the existing stub, and
sets `Status = Done`. That `Done` is the only signal the pipeline needs, and it
keeps the sweep off the page.

- **The title** comes from one extra Fireflies request at prompt time, run
  alongside the storage probe with the same 4s timeout. If that request fails,
  the prompt uses the timestamp label instead. The id is always there, so the
  skill still finds the right meeting.
- **App vs browser.** Telegram only allows `https://` and `tg://` on a URL
  button, so there is no `claude://` deep link. Whether the link opens the app
  or the website depends on the phone and on Telegram's in-app browser setting.
  If the app opens without the prompt, tap **Copy prompt** and paste it.
- **Nothing recaps automatically.** A meeting that is still `Pending` at the
  Tue/Fri 22:00 sweep is only *listed* in Telegram, so you can recap it in
  Claude or ChatGPT on your subscription, or tap Skip. `/sweep` shows the same
  list on demand.
- Override the wording with `CHAT_RECAP_PROMPT` (`{title}`, `{id}`) and the
  links with `CLAUDE_CHAT_URL` / `CHATGPT_CHAT_URL` (`{prompt}`).

**Haiku is the default tier**, but only for a tap: it is what a legacy `yes:`
callback from a prompt still sitting in your scrollback resolves to. No
scheduled or unattended job calls a model any more.

The tier table in [lib/config.js](lib/config.js) is the only place a tier is
defined; the keyboard, the callback router and `promoteMeeting` all read it.
Set `LLM_MODEL_HAIKU` / `LLM_MODEL_SONNET` to point a tier somewhere else —
including at OpenRouter-namespaced ids — without touching code.

### The Notes tier

`Notes` copies Fireflies' own summary and renders it deterministically: prose
summary, the action-item rollup with owners and timestamps, then one heading
per topic with its bullets. Same page skeleton as a model recap, so both read
and search the same way — but written by no model, in the meeting's own
language rather than forced to English.

Fireflies produces its summary some minutes *after* the transcript, so tapping
`Notes` early finds nothing. The page is then **claimed** — `Extraction State =
Pending Notes` — and finished by whichever of these arrives first:

1. the `meeting.summarized` webhook,
2. the sweep's 24-hour backstop, which either completes it or marks it `Failed`
   and releases the claim,
3. you, tapping `Haiku` or `Sonnet` on that meeting instead — an explicit tap
   takes the page over and clears the claim, so you are never stuck waiting.

A claimed page is left out of the sweep's list, since it is already being handled.

### Files

| Path | Purpose |
|---|---|
| `lib/config.js` | Env vars, Notion property names, status values, **the extraction tier table** |
| `lib/notes.js` | The Notes tier: claim, complete, and the 24h give-up |
| `lib/usage.js` | The Fireflies storage meter, shared by `/space` and the prompt |
| `lib/dates.js` | Timezone-correct date maths (Bangkok, fixed +07:00) |
| `lib/llm.js` + `lib/llm/*.js` | Provider-neutral model calls — see below |
| `lib/fireflies.js` | GraphQL client: `addToLiveMeeting`, `transcript`, `summary`, usage |
| `lib/notion.js` | REST client, data-source resolution, queries, block writes |
| `lib/extract.js` | Extraction schema, prompt, and result validation |
| `lib/render.js` | Extraction JSON *and* Fireflies summaries → Notion blocks (no model) |
| `lib/promote.js` | The shared "promote if still pending" function, and `eligibility()` |
| `lib/agent.js`, `lib/tools.js` | The conversational loop and its three tools |
| `netlify/functions/telegram.js` | Telegram webhook (background, 15 min) |
| `netlify/functions/fireflies.js` | Fireflies webhook (synchronous, must be fast) |
| `netlify/functions/promote-background.js` | One meeting's promotion, own invocation |
| `netlify/functions/sweep.js` | Tue+Fri 22:00 Bangkok sweep, plus the Notes backstop |
| `scripts/verify.js` | Preflight check — run before deploying |
| `scripts/test-render.js`, `scripts/test-flow.js` | Offline tests, no credentials |

---

## Four things worth understanding before you deploy

**1. Why the Telegram function is a Background Function.** Extracting an
80-minute transcript takes well over a minute. Netlify's synchronous functions
get 10 seconds (26 with a paid extension), so a Haiku or Sonnet tap could never
finish inline. Background functions return `202` immediately and then run for up to 15
minutes, which is all Telegram needs. Two consequences are handled in the code
and matter if you edit it: the `Response` you return is ignored, so the auth
checks gate the *work* rather than the status code; and a thrown error makes
Netlify re-run the whole invocation twice, so nothing in that handler may throw.

**2. Notion databases vs data sources.** As of API version `2025-09-03` a
*database* contains one or more *data sources*, and the data source holds the
rows. Queries hit `/v1/data_sources/{id}/query` and pages are parented to a
`data_source_id`. The id in your Notion URL is the *database* id — they are not
interchangeable. `lib/notion.js` resolves one to the other at runtime and caches
it. Don't bump `Notion-Version` without reading Notion's upgrade guide.

**3. Timezones.** Netlify cron runs in **UTC**. `0 15 * * 2,5` is 15:00 UTC =
22:00 Tuesday and Friday in Bangkok. If you change `TIMEZONE`, change the cron
in `netlify/functions/sweep.js` to match. The twice-weekly cadence exists for
the Notes backstop: a stranded stub's worst-case wait drops from about seven
days to about three and a half.

**4. The recap is permanent and the transcript is not.** The whole point of
this system is that you delete transcripts from Fireflies afterwards, so there
is no second chance at extraction. That is why a bad extraction fails loudly
(Status `Failed` plus a Telegram alert) instead of writing a thin page, and why
the first few real meetings should be treated as disposable test data.

---

## The /join grammar

```
/join <link> "<title>" <language>
```

Quotes are the safe form — everything inside them is the title, and the single
word after them is the language. Both parts are optional:

| You type | Title | Language |
|---|---|---|
| `/join <link> "Weekly sync" thai` | Weekly sync | `th` |
| `/join <link> "Weekly sync"` | Weekly sync | falls back to `FIREFLIES_LANGUAGE` |
| `/join <link> "Learn Thai"` | Learn Thai | falls back — quotes protect the title |
| `/join <link> Weekly sync thai` | Weekly sync | `th` |
| `/join <link> Weekly sync` | Weekly sync | falls back |
| `/join <link> "Sync" --lang zh-CN` | Sync | `zh-CN` |

Accepted languages are the friendly words in `LANGUAGE_ALIASES`
([lib/join.js](lib/join.js) — `thai`, `english`, `auto`, plus their codes) or
any well-formed code up to 5 characters, which is Fireflies' limit.

Two deliberate differences between the quoted and bare forms:

- **Quoted**: the title's boundary is explicit, so a trailing word is
  unambiguously a language. An unrecognised one is an **error** rather than
  something folded back into the title — rejecting costs you a retype, while
  guessing wrong costs one of only 3 joins per 20 minutes *and* transcribes a
  meeting you cannot re-record in the wrong language.
- **Bare**: only the alias table applies, never the general code shape. A bare
  title can legitimately end in a two-letter word ("Roadmap for AI", "Plan B"),
  and silently reading that as a language would be worse than ignoring it.

The join confirmation always names the language it used, so a mis-parse is
visible while the meeting is still running.

## Swapping the model, or the provider

Every model call goes through `lib/llm.js`, which exposes one neutral shape and
picks an adapter from `LLM_PROVIDER`. `extract.js` and `agent.js` never see a
vendor. To try a different Claude model:

```bash
LLM_MODEL=claude-opus-5
```

To trial other models through OpenRouter for cost or quality comparison:

```bash
LLM_PROVIDER=openrouter
LLM_MODEL=anthropic/claude-sonnet-5   # OpenRouter ids are vendor/model
OPENROUTER_API_KEY=...
```

`LLM_EXTRACT_MODEL` is a hard override across **both** model tiers at once —
the one-knob escape hatch, kept because `npm run test:llm` depends on it. For
per-tier control use `LLM_MODEL_HAIKU` and `LLM_MODEL_SONNET`.

Thinking is **per tier**, not global. `thinking: {type: "adaptive"}` is a
Claude-5-family parameter and Haiku 4.5 rejects it with a 400, so the Haiku tier
sends no `thinking` key at all while the Sonnet tier sends `adaptive`.
`LLM_THINKING` still sets the default for the chat loop and the Sonnet tier.

A tier only ever resolves to a *model string*; `chat()` picks the adapter from
`LLM_PROVIDER` exactly as before. So an OpenRouter trial is still an env change
and nothing else: set `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and point
`LLM_MODEL_HAIKU` / `LLM_MODEL_SONNET` at namespaced ids. `thinking` has no
OpenAI-compatible equivalent and the OpenRouter adapter ignores it.

> **The OpenRouter adapter is written but has never been run against the live
> API.** Before trusting it with a real meeting, run `npm run test:llm` with
> those variables set. It exercises the three things most likely to differ
> between providers: a forced tool call, parsed tool arguments, and replaying
> an assistant turn plus tool results into a second turn.

---

## Setup

### 1. Notion

1. **notion.so/my-integrations** → New integration. This is a **second,
   separate** integration from any you already have — scoping it to one
   database is the whole point. Capabilities: read, update, insert content.
   Copy the token → `NOTION_API_KEY`.
2. Create a **Meetings** database with exactly these properties:

   | Property | Type | Options |
   |---|---|---|
   | Name | Title | — |
   | Date | Date | — |
   | Source Meeting ID | Text | — |
   | Status | Select | Pending, Processing, Done, Skipped, Failed |
   | Extraction State | Select | Pending Notes |
   | Extracted By | Text | — |

   A Notion *Status* property works too for **Status** — the code detects which
   one you built and adapts. With a Status property the five options must exist
   before the first run; with a Select, Notion creates them on first write.

   `Extraction State` must be a **Select**, not a Status property: no lifecycle
   grouping is wanted, and a Select auto-creates a missing option on write so a
   typo fails soft. Empty means "nothing pending", which is the normal state of
   almost every page — no backfill is needed. If you already created the option
   under a different name, either rename it in Notion or set `NOTES_STATE_LABEL`
   to match; `npm run verify` prints which literal is in use and flags strays.

   `Extracted By` must be **Text**, never a Select — model ids change every
   release and dead Select options would accumulate forever. Existing pages
   keep it empty.
3. Open the database as a full page → `···` → **Connections** → add the
   integration. The token alone grants nothing.
4. Copy the database id from the URL → `NOTION_MEETINGS_DB_ID`.

### 2. Telegram

1. **@BotFather** → `/newbot` → token → `TELEGRAM_BOT_TOKEN`.
2. **@userinfobot** → your numeric id → `TELEGRAM_CHAT_ID`. This is what
   restricts the bot to you; bot usernames are discoverable.
3. `openssl rand -hex 32` → `TELEGRAM_WEBHOOK_SECRET`.

### 3. Fireflies

1. **app.fireflies.ai** → Integrations → API key → `FIREFLIES_API_KEY`.
2. **Developer Settings** → webhook signing secret (16–32 chars) →
   `FIREFLIES_WEBHOOK_SECRET`.
3. Leave the webhook URL until after the first deploy (step 6).
4. `FIREFLIES_LANGUAGE` (optional, default `auto`) sets the transcription language passed to `addToLiveMeeting`. `auto` lets Fireflies detect it per meeting — better than Fireflies' own default (English) for a mixed-language team. See "The /join grammar" below for per-meeting overrides.

### 4. Anthropic

**console.anthropic.com** → API Keys → `ANTHROPIC_API_KEY`. Billed separately
from any Claude.ai subscription.

### 5. Local check

```bash
cp .env.example .env      # fill it in, then:
openssl rand -hex 32      # -> INTERNAL_SECRET
npm test                  # offline: rendering, chunking, signatures, full flow
                          # (the flow suite runs TWICE — once with Status as a
                          #  Select, once as a Notion Status property, because
                          #  the two have different write and filter shapes)
npm run verify            # live: every token, the DB schema, the options, the tier table
```

`npm test` needs no credentials and no network. `npm run verify` costs one
Fireflies API request (the free plan allows 50 a day).

### 6. Deploy

```bash
git init && git add . && git commit -m "initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

On **netlify.com** → Add new site → Import an existing project. Then **Site
configuration → Environment variables**: add everything from `.env` except
`DEPLOY_URL`. Deploy.

### 7. Register both webhooks

```bash
npm run webhook:set
```

with `DEPLOY_URL` set to your Netlify URL in `.env`. Then register the
Fireflies webhook at **app.fireflies.ai → Developer Settings → Webhooks V2**,
pointing at `https://<your-site>.netlify.app/fireflies`, with the same signing
secret, subscribed to **two** events:

| Event | What it does |
|---|---|
| `meeting.transcribed` | Creates the page and sends the prompt. Required. |
| `meeting.summarized` | Finishes a page the `Notes` button is waiting on. Optional — the 24-hour backstop covers the same ground, just slower. |

**Order matters, mildly.** Deploy the branching handler *before* subscribing
`meeting.summarized`. Subscribing early is not a cliff — the deployed handler
already answers `200` to any event it does not recognise — but it does mean
those deliveries are silently discarded until the new code is live. Use **one**
subscription with both events, not a second endpoint.

Confirm the Fireflies endpoint before waiting on a real meeting:

```bash
npm run sign -- SOMEMEETINGID https://your-site.netlify.app
```

That prints a signed `curl`. Run it, then run it again with one character of
the signature changed — the second must come back `401`.

The same helper fires the summary event, which is how you exercise the whole
Notes completion path without waiting for (or subscribing) a real one:

```bash
npm run sign -- SOMEMEETINGID meeting.summarized https://your-site.netlify.app
```

### 8. First real meeting

Use a short, throwaway meeting. There is no way to re-extract a transcript
you've already deleted from Fireflies, so treat the first few as test data.

---

## Costs and limits

| Thing | Limit |
|---|---|
| Fireflies API, free plan | 50 requests/day total |
| Fireflies storage, free plan | 400 stored minutes — reported on every prompt, and by `/space` |
| `addToLiveMeeting` | 3 requests / 20 minutes |
| Fireflies webhook response | must be 2xx within 10 s |
| Notion | ~3 requests/s, 100 blocks per append, 2000 chars per text object |
| Netlify synchronous function | 10 s (26 s on a paid extension) |
| Netlify background function | 15 minutes |
| Netlify scheduled function | 30 seconds |
| Telegram `callback_data` | 64 bytes |

A recap costs a few cents of tokens. Everything else is inside the free tiers.

---

## Known limitations

- **`/join` cannot be retried from a button.** Telegram caps `callback_data` at
  64 bytes and a Teams link is far longer, so there is nowhere to keep the
  link. On a rate-limit error the bot tells you to send the same `/join` again.
- **A skipped meeting keeps its timestamp label** as its title, permanently —
  the real title only ever arrives with the transcript.
- **No conversation memory.** Each Telegram message is independent, so "and
  what about that one" will not resolve.
- **Single user.** Both auth gates assume one chat id.
- **Multi-data-source databases** aren't supported; the first is used and a
  warning is logged.
- **Notes pages are in the meeting's own language.** Fireflies summarises in
  whatever was spoken; model tiers are forced to English. The database ends up
  mixed-language. Translating would need a model call, which is the one thing
  this tier exists to avoid. `search_meetings` matches on title only, so search
  is unaffected.
- **`meeting.summarized` may not fire for meetings summarised before you
  subscribed to it.** Fireflies does not document this either way. The 24-hour
  backstop covers it regardless.
- **No per-tier provider.** `LLM_PROVIDER` is global, so Haiku-on-Anthropic and
  Sonnet-on-OpenRouter at the same time is not possible today.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Bot silent | `npm run webhook:info` — shows Telegram's last delivery error |
| Button taps do nothing | `webhook:info` again: `callback_query` must be in `allowed_updates` |
| Any runtime error | Netlify → site → **Logs** (pick the right function) |
| Fireflies webhook 401 | The signing secret in Netlify differs from the one in Fireflies |
| Notion 404 | The integration isn't connected to the database |
| Notion 400 on write | A Status option doesn't exist; `npm run verify` compares them |
| Extraction 400 on the tool schema | Set `LLM_STRICT_TOOLS=0` and redeploy |
| 400 mentioning `thinking` after changing `LLM_MODEL` | That model predates adaptive thinking; set `LLM_THINKING=off` |
| 400 mentioning `thinking` from a tier | A tier model that rejects `adaptive`; `npm run verify` prints each tier's mode |
| A page stuck on `Pending Notes` | Fireflies never summarised it. Recap it in Claude or ChatGPT, or tap Haiku, to take it over, or wait for the 24h backstop |
| No storage line on the prompt | The usage probe failed or timed out; it is deliberately non-fatal. Netlify logs say why |
| The sweep suddenly lists nothing | The `Extraction State` exclusion; `npm run verify` checks it against the live database |
| Notion 400 saying a property does not exist | `Extraction State` or `Extracted By` was never added. Both are now required on every write — add them (see Setup step 1) and re-run `npm run verify` |
| A page stuck in Processing | It clears itself after 30 minutes and the next sweep lists it |
| A page in Failed | `/sweep` and the scheduled sweep list it; tap a button on its prompt (or recap in chat) to retry |
