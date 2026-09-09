# Minute Maker

Telegram → Fireflies → Claude → Notion. You ask the Fireflies bot to join a
meeting; when the transcript is ready the bot asks whether you want a recap;
tapping Yes writes a structured recap into Notion as a permanent record.

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
                 ──▶ Telegram Yes/No prompt

You tap Yes ──▶ /telegram ──▶ fetch transcript ──▶ Claude extraction
                          ──▶ recap written to the page, Status: Done
You tap No  ──▶ page body becomes "Skipped", Status: Skipped, page KEPT

Friday 17:00 ──▶ sweep ──▶ /promote (one background run per meeting)
/sweep       ──▶ same promotion logic, on demand, and retries failures
/space       ──▶ Fireflies storage meter (one API call, no LLM, no Notion)

Anything else you type ──▶ tool-use loop over your meeting notes
```

All four promotion triggers — a Yes tap, the weekly sweep, `/sweep`, and a
redelivered webhook — go through one function, `promoteMeeting()` in
[lib/promote.js](lib/promote.js), which refuses to act on a meeting that is
already recapped, already skipped, or currently being processed.

### Files

| Path | Purpose |
|---|---|
| `lib/config.js` | Env vars, Notion property names, status values, model choice |
| `lib/dates.js` | Timezone-correct date maths (Bangkok, fixed +07:00) |
| `lib/llm.js` + `lib/llm/*.js` | Provider-neutral model calls — see below |
| `lib/fireflies.js` | GraphQL client: `addToLiveMeeting`, `transcript` |
| `lib/notion.js` | REST client, data-source resolution, queries, block writes |
| `lib/extract.js` | Extraction schema, prompt, and result validation |
| `lib/render.js` | Extraction JSON → Notion blocks (deterministic, no model) |
| `lib/promote.js` | The shared "promote if still pending" function |
| `lib/agent.js`, `lib/tools.js` | The conversational loop and its three tools |
| `netlify/functions/telegram.js` | Telegram webhook (background, 15 min) |
| `netlify/functions/fireflies.js` | Fireflies webhook (synchronous, must be fast) |
| `netlify/functions/promote-background.js` | One meeting's promotion, own invocation |
| `netlify/functions/sweep.js` | Friday 17:00 Bangkok scheduled sweep |
| `scripts/verify.js` | Preflight check — run before deploying |
| `scripts/test-render.js`, `scripts/test-flow.js` | Offline tests, no credentials |

---

## Four things worth understanding before you deploy

**1. Why the Telegram function is a Background Function.** Extracting an
80-minute transcript takes well over a minute. Netlify's synchronous functions
get 10 seconds (26 with a paid extension), so the Yes tap could never finish
inline. Background functions return `202` immediately and then run for up to 15
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

**3. Timezones.** Netlify cron runs in **UTC**. `0 10 * * 5` is 10:00 UTC =
17:00 Friday in Bangkok. If you change `TIMEZONE`, change the cron in
`netlify/functions/sweep.js` to match.

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

`LLM_EXTRACT_MODEL` overrides the model for transcript extraction only, so you
can run a stronger model on recaps and a cheaper one on chat.

Requests send `thinking: {type: "adaptive"}`, which is a Claude-5-family
parameter. If you point `LLM_MODEL` at an older model (e.g. `claude-haiku-4-5`)
it will reject that with a 400 — set `LLM_THINKING=off` in that case.

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

   A Notion *Status* property works too — the code detects which one you built
   and adapts. With a Status property the five options must exist before the
   first run; with a Select, Notion creates them on first write.
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
npm run verify            # live: every token, the DB schema, the Status options
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
pointing at `https://<your-site>.netlify.app/fireflies`, subscribed to
`meeting.transcribed` only, with the same signing secret.

Confirm the Fireflies endpoint before waiting on a real meeting:

```bash
npm run sign -- SOMEMEETINGID https://your-site.netlify.app
```

That prints a signed `curl`. Run it, then run it again with one character of
the signature changed — the second must come back `401`.

### 8. First real meeting

Use a short, throwaway meeting. There is no way to re-extract a transcript
you've already deleted from Fireflies, so treat the first few as test data.

---

## Costs and limits

| Thing | Limit |
|---|---|
| Fireflies API, free plan | 50 requests/day total |
| Fireflies storage, free plan | 400 stored minutes — check with `/space` |
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

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Bot silent | `npm run webhook:info` — shows Telegram's last delivery error |
| Yes/No taps do nothing | `webhook:info` again: `callback_query` must be in `allowed_updates` |
| Any runtime error | Netlify → site → **Logs** (pick the right function) |
| Fireflies webhook 401 | The signing secret in Netlify differs from the one in Fireflies |
| Notion 404 | The integration isn't connected to the database |
| Notion 400 on write | A Status option doesn't exist; `npm run verify` compares them |
| Extraction 400 on the tool schema | Set `LLM_STRICT_TOOLS=0` and redeploy |
| 400 mentioning `thinking` after changing `LLM_MODEL` | That model predates adaptive thinking; set `LLM_THINKING=off` |
| A page stuck in Processing | It clears itself after 30 minutes and the next sweep retries it |
| A page in Failed | `/sweep` retries it; the scheduled sweep deliberately does not |
