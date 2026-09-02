# Fireflies Meeting Pipeline — Project Plan

Personal automation: Telegram → Fireflies (transcription) → Claude Sonnet (structured extraction) → Notion (permanent record). Separate system from Friday (the existing Telegram → Claude Haiku → Notion task agent), hosted on Netlify instead of Vercel, with its own bot, its own Notion integration, and its own repo.

**Design principle carried over from Friday:** deterministic where possible, LLM calls only where reasoning genuinely adds value. Stateless handlers — no persistent session state across invocations; correlation between steps happens via IDs carried in Telegram callback payloads or Notion page lookups, never a database of pending state.

---

## 1. Why this exists

Fireflies' free tier caps transcript storage at ~400 minutes. That's not a retention timer — transcripts sit indefinitely until manually cleared. This pipeline's real job is **migration**: get each meeting out of that capped, manually-managed bucket and into Notion (cheap, effectively permanent) so transcripts can be freely deleted from Fireflies without losing the underlying knowledge. The output is a personal, browsable meeting knowledge base — not a task-automation system (no auto-created tasks, no MoM export, no RAG).

---

## 2. End-to-end flow

```
You: "/join <meet link> <title>"
   │
   └─ Telegram webhook (deterministic, no LLM)
        └─ calls Fireflies addToLiveMeeting(meeting_link, title)
             (rate-limited 3 req/20min — synchronous error handling,
              inline-keyboard retry only for rate-limit errors)

... meeting happens, Fireflies bot transcribes ...

Fireflies webhook: meeting.transcribed (Webhooks V2)
   │  payload = { event, timestamp, meeting_id, client_reference_id }
   │  (NOTE: no title, no duration in payload — see §4)
   │
   ├─ verify X-Hub-Signature using FIREFLIES_WEBHOOK_SECRET — reject if invalid
   ├─ idempotency check: does a page with this Source Meeting ID already
   │  exist AND already contain a real recap (not a stub)? → skip if so
   ├─ derive a timestamp label from `timestamp` (e.g. "Meeting — Sep 1, 2:15pm")
   ├─ write STUB page to Notion immediately:
   │     Name: <timestamp label>
   │     Date: <derived from timestamp>
   │     Source Meeting ID: <meeting_id>
   │     Body: "Awaiting recap decision — reply Yes/No in Telegram."
   └─ send Telegram Yes/No prompt (inline keyboard, callback_data = meeting_id)

You tap Yes/No (fires immediately, independent of any schedule)
   │
   ├─ YES → fetch full transcript via Fireflies API (meeting_id)
   │         (this call also returns the real title — no separate metadata
   │          call needed pre-prompt; title arrives "for free" here)
   │        → forced-tool-use Sonnet call → structured extraction
   │        → PATCH the existing stub page:
   │             Name: <real title>
   │             Body: real recap (summary, topics, notes, action-item rollup)
   │        → retry up to 2x on failure, then Telegram alert naming the meeting
   │
   └─ NO  → PATCH stub page body to "Skipped — no recap requested."
            Name stays as the timestamp label permanently (accepted trade-off).
            Page is KEPT, not deleted — serves as a log that the meeting
            happened and was deliberately skipped. (Revisit only if this
            becomes actual clutter — first fix would be a Notion view filter,
            not deletion.)

Weekly scheduled sweep (Friday, 5pm) — Plan B safety net only
   │  Finds any page still in "Awaiting recap decision" state → promotes
   │  it through the same YES path above. Has ZERO effect on anything
   │  you've already tapped — sweep and callback are independent triggers
   │  converging on one shared "promote if still pending" function.

/sweep command — same promotion logic, run on demand instead of waiting
   for Friday.

Anything else you type (no slash command match)
   │
   └─ Falls through to a conversational tool-use loop (model-routed,
      Haiku for simple lookups / Sonnet for cross-meeting synthesis):
        ├─ search_meetings — Q&A over the Notion Meetings DB
        └─ add_note_to_meeting — append a note to an existing meeting page
             for content that happened OUTSIDE the recorded meeting
             (e.g. your lead following up in the hallway afterward)
```

**Multi-trigger idempotency note:** four different triggers can attempt to promote the same pending meeting — a Yes tap, the Friday sweep, `/sweep`, and (rarely) a redelivered Fireflies webhook. All four must call one shared "promote if still pending" function with a guard at the top (check the page isn't already a real recap or already Skipped) to avoid double-processing.

---

## 3. Notion — Meetings database

Three properties only, matching the "deliberately minimal" pattern from the Tasks/Projects DBs:

| Property | Type | Notes |
|---|---|---|
| Name | Title | Timestamp label at creation; overwritten with real title on Yes |
| Date | Date | Derived from the webhook's `timestamp` field |
| Source Meeting ID | Text | Fireflies `meeting_id` — idempotency key |

**No Project relation property** (decided against — a naming convention in `Name` is sufficient at this scale; revisit only if native Notion rollups become genuinely wanted).

Page body content (summary, topic headings, notes, action-item rollup) is written entirely via the API as typed Notion blocks in the same call that sets properties — never a second call, never free-form page generation. See §5 for why structured extraction, not free-form generation, is the load-bearing decision here.

**Second, separate Notion integration** — not reused from Friday. Scoped only to this database via `···` → Connections, same setup pattern as Tasks/Projects. Chosen deliberately for blast-radius isolation, matching how separated the rest of this system already is (separate bot, separate host, separate repo).

---

## 4. Fireflies integration details

- **Webhooks V2**, subscribed to `meeting.transcribed` only (not `meeting.summarized` — that's Fireflies' own built-in summarizer, unused here; not `meeting.bot_joined` — no use for it).
- **Webhook payload is minimal**: `event`, `timestamp`, `meeting_id`, `client_reference_id`. No title, no duration. Confirmed by checking Fireflies' docs directly rather than assumed.
- **`client_reference_id` does not help here** — it's documented for the `uploadAudio` mutation specifically ("set during upload"), not `addToLiveMeeting`. `addToLiveMeeting`'s response is just `{ success, message }` — no ID returned at join time either. There is no way to correlate the title typed at `/join` time with the later webhook without a stored lookup or a follow-up call — hence the timestamp-label design in §2.
- **Signing secret is mandatory** — HMAC-SHA256 verification via `X-Hub-Signature`, same security posture as the Telegram webhook secret check. Configured on the [Webhooks V2 setup page](https://app.fireflies.ai/integrations/api/webhook).
- **Rate limit**: `addToLiveMeeting` is capped at 3 requests / 20 minutes (already known from Friday's neighboring context — not a new constraint, just carried forward).
- `addToLiveMeeting` also accepts an optional `duration` param (est. meeting length, 15–120 min, default 60) — this is a scheduling estimate, not a measured outcome, so it has no bearing on the (deliberately dropped) short-meeting filtering discussed in §6.

---

## 5. Extraction schema (forced Sonnet tool use)

**Why a schema at all, not free-form page generation:** Notion's API never accepts prose — it accepts typed block objects either way. The real choice is whose schema: a custom intermediate one (below), or Claude emitting raw Notion blocks directly. The custom schema wins because (a) the action-item rollup must appear in two places (inline + top summary) and free generation can't guarantee those stay consistent with each other, where a single `is_action_item` flag filtered twice, deterministically, cannot drift; (b) schema validation catches a malformed/incomplete extraction as a loud API error instead of a silently-bad permanent page; (c) the 2000-char Notion rich-text chunking (reusing `splitMessage()`'s break-on-newline logic) needs known content boundaries, which a fixed note-per-bullet shape gives for free.

**Enforcement:** forced tool use (`tool_choice: {type: "tool", name: "extract_meeting"}`), same primitive as `lib/tools.js`, not raw-JSON prompting — eliminates prose-wrapping and code-fence parsing failure modes entirely.

```
Meeting (top-level tool input):
  summary: string        — a few lines, what happened overall
  topics:  array          — soft-guided 1–8 topics, NOT hard-capped
                             (a hard maxItems risks outright validation
                             failure on a real 8+ topic meeting — worse
                             than an occasionally long page)

Topic:
  title: string
  notes: array            — soft-guided ~3–12 notes per topic

Note:
  content:         string  — the FULL natural recap bullet, written the way
                             a human would write it, attribution woven in
                             where it reads naturally
                             e.g. "Nik mentioned that we currently do not
                             have any policies, need to talk to Joao about
                             future plan for policies."
  speaker:         string  — structured attribution for Q&A filtering only;
                             NOT directly rendered (content already reads
                             naturally on its own)
  is_action_item:  boolean — default false; ONLY true for genuine
                             commitments, not every future-tense mention.
                             Most notes are plain discussion — presenting
                             a concept, a calculation, an update — and
                             is_action_item should be false for all of them.
  action_owner:    string  — "TBA" when unstated (never null); can be a
                             person, multiple people as one string
                             ("Alice, Bob"), or a team name
  action_due:      string | null — null when unstated
```

**No `title` field** — comes from Fireflies transcript metadata on Yes (or the timestamp label if never fetched), never from extraction.
**No attendee list** — nothing downstream consumes it; `speaker` on individual notes already covers "who raised/answered X."
**No topic-level summary field** — redundant with its own notes array, a second place to drift from the detail underneath it.

**Rendering (deterministic code, not model output):**
- Topic body: `- {content}` for every note, regardless of `is_action_item`. Owner/due are never shown here.
- Rollup section (top of page): `notes.filter(n => n.is_action_item)` across all topics, each rendered as `- {content} — {action_owner}{, due {action_due} if not null}`.
- Zero action items in a meeting → omit the rollup heading entirely, don't render it empty.
- A meeting that doesn't decompose into distinct topics → Claude has explicit permission to emit a single `"General"` topic rather than forcing artificial structure.

**Accepted edge case, no special handling:** a meeting with a garbled/unusable transcript still gets forced-tool-use output — worst case a thin, low-value recap, not a broken one. Not worth schema complexity or extra logic for something this rare.

---

## 6. Rejected / dropped approaches (kept here so they aren't re-litigated)

- **Duration-based short-meeting precheck** (originally: skip Sonnet entirely under ~3 minutes) — dropped. Duration isn't in the webhook payload and isn't worth a second call to obtain; the Yes/No pause is a strictly better filter (actual judgment vs. a proxy for it); token cost difference between a quiet and substantial meeting is fractions of a cent either way — never a real reason to filter.
- **Metadata-fetch call before the Yes/No prompt** — rejected by design choice. Traded for a timestamp-only label until Yes is tapped, at which point the title arrives for free via the transcript fetch that was always going to happen.
- **25-second in-request auto-yes timer** — technically infeasible. Netlify synchronous functions default to a 10s timeout, 26s max on paid plans (not 30s, and not automatic) — nowhere near enough to wait AND do a multi-call extraction in one invocation. Replaced by the scheduled sweep + manual `/sweep` design in §2.
- **15-minute / daily sweep cadence** — considered, superseded by weekly. Once it was clear the sweep only catches meetings you never respond to at all (Yes/No taps are always immediate and independent of the sweep), a tight interval bought nothing — Fireflies storage has no purge timer, so the only real exposure is manually clearing Fireflies storage before answering, which is fully within your own awareness either way.
- **Auto-delete of "Skipped" stub pages** — rejected for now. They're not blank (Name + Date + "Skipped" body), and deleting them destroys the one thing this system exists to preserve (a durable trace that the meeting happened). If clutter becomes a real problem, a Notion view filter is the first fix, not deletion.
- **`/ai` command for Q&A** — rejected. Any non-command message already falls through to the conversational loop; requiring a trigger word just adds friction Friday's own design never needed.
- **Attendee list, topic-level summary, separate action-item object** — see §5, all rejected as redundant fields with no consuming logic.

---

## 7. Telegram commands

| Command | Behavior |
|---|---|
| `/start`, `/help` | Static help text, zero LLM cost, handled before any Claude call (mirrors Friday's `api/telegram.js` pattern) |
| `/join <link> <title>` | Deterministic — parses link + title, calls `addToLiveMeeting` |
| `/sweep` | Manual trigger for the same promotion logic as the Friday cron |
| *(callback_query: Yes/No tap)* | Handled separately from message text — see §2 |
| *(anything else)* | Falls through to the conversational tool-use loop: `search_meetings` (Q&A) or `add_note_to_meeting` (post-meeting note append) |

**`add_note_to_meeting` tool** (new capability, for content that happens outside the recorded meeting — e.g. a hallway follow-up):
```
add_note_to_meeting:
  meeting_reference: string  — e.g. "today", a fuzzy title match, or
                                omitted → defaults to most recent meeting
  note:               string
  is_action_item:     boolean (optional)
  action_owner:        string (optional)
  action_due:          string (optional)
```
Reuses the fuzzy-match-then-most-recent pattern already proven in `findProjectId()`. Appends a new block to the page (visually separated from the extracted content, e.g. under a "Post-meeting notes" heading) rather than mixing it into Sonnet's original output. If no matching page exists yet (transcript still processing), the tool should say so plainly and let you retry — no staging mechanism for this, consistent with the project's stateless-by-default approach.

Both `search_meetings` and `add_note_to_meeting` are model-routed: Haiku for single-meeting lookups and simple appends, Sonnet for cross-meeting synthesis. Two tools total in this conversational loop — same "keep the tool surface small" discipline as Friday's four.

---

## 8. Scheduling

- **Weekly sweep**: Friday, 5pm — Netlify Scheduled Function. Confirmed Scheduled Functions get a 30-second execution limit regardless of plan (separate, more generous allowance than synchronous functions). At weekly cadence, no per-page age math is needed — the sweep just checks "still in Awaiting-recap state?" and promotes if so.
- **Edge case to design around during build**: if several meetings are simultaneously overdue (e.g. a week of ignored prompts), the sweep should only *identify and trigger* promotions, not perform the full transcript-fetch + Sonnet + Notion-write chain synchronously for each — that risks bumping the 30s ceiling. Trigger each promotion as its own invocation (fire-and-forget or Background Function) rather than looping heavy work inline.

---

## 9. Platform notes (Netlify vs. Vercel — don't assume parity)

- Default function path is `/.netlify/functions/<name>`, not `/api/<name>` — either accept this or add a `netlify.toml` redirect; no functional difference either way.
- Standard synchronous functions: 10s timeout default, 26s max on paid plans (must be explicitly requested from Netlify, not automatic).
- Scheduled Functions: 30s execution limit, separate allowance from synchronous functions.
- Background Functions: up to 15 minutes, invoked asynchronously (202 response, runs separately) — candidate for the per-meeting promotion work under §8's edge case.
- Free tier cost check (done rather than assumed): both a weekly sweep and Notion's query load are trivially within free limits on both platforms — not a constraint worth designing around at this usage volume.
- `netlify.toml` is committed to git — never put secrets in it. Env vars go through the Netlify dashboard (Site configuration → Environment variables) or `netlify env:set` via CLI after `netlify link`.

---

## 10. Environment variables

```
# Telegram (this project's bot — @FirefliesForNik_bot, separate from Friday's)
TELEGRAM_BOT_TOKEN          — from BotFather
TELEGRAM_CHAT_ID            — reused from Friday (same numeric ID, identifies you)
TELEGRAM_WEBHOOK_SECRET     — freshly generated (openssl rand -hex 32), NOT shared with Friday

# Fireflies
FIREFLIES_API_KEY           — from Fireflies account → Integrations
FIREFLIES_WEBHOOK_SECRET    — signing secret from the Webhooks V2 setup page,
                               verifies X-Hub-Signature on incoming events (mandatory)

# Anthropic
ANTHROPIC_API_KEY           — can reuse Friday's key (same account); separate only
                               if you want distinct usage tracking per project

# Notion (second, separate integration — NOT Friday's)
NOTION_API_KEY               — new integration token, scoped only to the Meetings DB
NOTION_MEETINGS_DB_ID        — from the database URL, once created (§3)
```

No `CRON_SECRET` equivalent needed — Netlify Scheduled Functions are invoked by Netlify itself, not a public URL requiring its own auth gate (unlike Vercel Cron's bearer-token pattern in Friday's `api/nightly.js`).

---

## 11. Build-session checklist (setup steps, roughly in order)

1. Get credentials: BotFather token for `@FirefliesForNik_bot`, fresh webhook secret, Fireflies API key + webhook signing secret.
2. Create the Notion Meetings database (§3 schema) and connect the new integration to it via `···` → Connections.
3. Create the Netlify site (Import an existing project, once the repo exists).
4. Set all env vars from §10 in Netlify (dashboard or CLI) and in a local `.env` (git-ignored) for local testing.
5. Build with Claude Code, using this document as the planning input.
6. Deploy; confirm the actual function path and synchronous timeout behavior (§9) rather than assuming.
7. Register the Fireflies webhook (Webhooks V2 setup page) pointing at the deployed Netlify function URL.
8. Register the Telegram webhook, same pattern as Friday's `setup-webhook.js`.
9. Test end-to-end with a short real meeting before trusting it with anything you actually care about — no transcript re-extraction is possible later, so the first few real meetings should be treated as disposable test data.
