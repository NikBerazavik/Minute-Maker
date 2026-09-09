# Instant Tier — Implementation Plan

Planning document for the Instant tier. Everything in §0–§7 is **plan only, not
yet built**.

Two things here *are* built and tested, because they were needed to answer
questions the plan depended on: the **`/space` command** (§8) and an
**event-selectable `scripts/sign.js`** (§9). See §11 for the exact diff.

---

## 0. Read this first: four premises that don't match the code

The brief describes a system slightly ahead of where the repo actually is. None
of these change the *goal*; they change the *size*, and two of them change the
design. Reviewing these before anything else is the point of this section.

### 0.1 There are no Haiku and Sonnet tiers to add a third one alongside

The brief says Instant goes "alongside the existing Haiku and Sonnet tiers" and
that `Extracted By` should hold a literal string "consistent with how
Haiku/Sonnet store exact model IDs." Neither exists:

| Brief assumes | Repo actually has |
|---|---|
| Inline keyboard: Instant / Haiku / Sonnet | Yes / No — [lib/telegram.js:39](lib/telegram.js:39) |
| Callback routing per tier | `yes:` / `no:` only — [netlify/functions/telegram.js:93](netlify/functions/telegram.js:93) |
| Per-tier model selection | One global `LLM_EXTRACT_MODEL` env var — [lib/config.js:22](lib/config.js:22) |
| `Extracted By` property storing a model id | Property does not exist; schema is Name / Date / Source Meeting ID / Status — [lib/config.js:80](lib/config.js:80), asserted in [scripts/verify.js:60](scripts/verify.js:60) |

So the work splits into two phases. **Phase 0 builds the tier substrate**
(multi-tier keyboard, per-tier model threading, `Extracted By`). **Phase 1 is
the actual Instant feature and its race fix.** Phase 1 is meaningless without
Phase 0 — "Instant" is only a *choice* if there is something to choose it
against.

Phase 0 is genuinely small (roughly: one config block, one keyboard function,
one callback parser, one parameter threaded through two functions), but it must
be scoped and reviewed as work, not assumed as background.

### 0.2 The weekly sweep will hijack Instant stubs and silently spend LLM tokens

This is the most consequential finding, and it directly contradicts decision 7
("the existing Friday 5pm sweep ... doesn't need to change for this feature").

[`findSweepablePages()`](lib/notion.js:173) selects on the **`Status`**
property — Pending, or Processing older than
`staleProcessingMinutes` (30). It has no knowledge of a new `Extraction State`
property. So a page sitting in `Extraction State = Pending Instant`, whatever
its `Status`, gets picked up:

- If the Instant stub leaves `Status = Pending` → the Friday sweep grabs it,
  calls `triggerPromotions` → `promoteMeeting` → **a full LLM extraction**.
  The user asked for a zero-LLM Instant recap and silently gets a paid Sonnet
  one. An unrelated manual `/sweep` does the same thing, any day of the week.
- If the stub sets `Status = Processing` → same hijack, but after 30 minutes
  instead of up to a week.

There is no `Status` value that both marks the page as legitimately in-flight
and keeps the existing sweep away from it. **`findSweepablePages` must exclude
`Extraction State = Pending Instant`.** That is a required change, not an
optional one.

And once it's excluded, the consequence: if `meeting.summarized` never arrives,
nothing completes the page — ever. So the 24-hour backstop that decision 7
describes as already existing has to actually be built. It doesn't exist today
in any form: the sweep is `0 10 * * 5` (weekly Friday 17:00 Bangkok,
[netlify/functions/sweep.js:37](netlify/functions/sweep.js:37)) with no
24-hour logic anywhere in the repo.

Net effect on scope: the sweep changes in two ways (an exclusion and a new
backstop pass), where the brief budgeted zero.

### 0.3 The "stub page" already exists — this is patching, not creating

Decisions 2, 5 and 6 are written as though tapping Instant creates a Notion
page. It doesn't. `meeting.transcribed` already created one, minutes earlier:
[`createStubPage()`](lib/notion.js:216) writes the row with
`Status = Pending` and an "Awaiting recap decision" paragraph, and the Telegram
prompt the user is tapping is attached to *that* page. `handleCallback` already
resolves it via `findMeetingByFirefliesId`
([netlify/functions/telegram.js:100](netlify/functions/telegram.js:100)).

Three simplifications follow:

- **Decision 5 (idempotency: "check for an existing page first, don't create
  duplicates")** — duplicate pages are already structurally impossible on this
  path. The page is pre-existing and looked up by `meeting_id`. The real
  double-tap risk is *re-running the work on one page*, which is a state guard,
  not a lookup. Covered in §3.4.
- **Decision 6 (tier-switching "would otherwise produce two pages for one
  meeting")** — it wouldn't. It would produce one page with a stale
  `Extraction State`. The fix is clearing that property when another tier
  claims the page: a one-line write, not a cancellation protocol.
- **Decision 2's "stored (non-user-facing) `meeting_id` field"** — this already
  exists as `Source Meeting ID` (rich_text). It is already the idempotency key
  and already indexed by `findMeetingByFirefliesId`. **Do not add a second
  `meeting_id` property.** Two fields holding the same Fireflies id is two
  sources of truth that will drift. One new property (`Extraction State`), not
  two.

### 0.4 A Haiku tier will 400 on its first call as currently configured

[lib/llm/anthropic.js:86](lib/llm/anthropic.js:86) applies
`thinking: { type: config.llm.thinking }` to **every** request, and
`config.llm.thinking` defaults to `"adaptive"`. The config comment at
[lib/config.js:29](lib/config.js:29) already documents that Haiku 4.5 rejects
`adaptive` with a 400. Today that's fine because there's one global model. The
moment a Haiku tier can be selected per-meeting while Sonnet remains the
default, one global `LLM_THINKING` value cannot serve both.

Fix in Phase 0: make thinking a per-tier property resolved alongside the model,
rather than a single global. Small, but it is a hard blocker on the Haiku
button working at all.

---

## 1. Design shape after the above

One Notion page per meeting, created by `meeting.transcribed`, moved through
states by whichever tier the user taps.

```
meeting.transcribed ──▶ page created, Status=Pending, keyboard sent
                                  │
      ┌───────────────────────────┼───────────────────────────┐
      │ tap Haiku / Sonnet        │ tap Instant               │ tap Skip
      ▼                           ▼                           ▼
  clear Extraction State     claim: Extraction State      Status=Skipped
  Status=Processing            = Pending Instant
  LLM extraction               Status=Processing
  Status=Done                       │
  Extracted By=<model id>      one Fireflies summary query
                                    │
                        ┌───────────┴───────────┐
                    summary present         summary empty
                        ▼                       ▼
                 complete now            leave claimed,
                 clear Extraction State  tell user "not ready yet"
                 Status=Done                     │
                 Extracted By=                   ▼
                  fireflies-deterministic  meeting.summarized arrives
                                           ──▶ find Pending Instant
                                               by meeting_id ──▶ complete
                                                    │
                                              (never arrives)
                                                    ▼
                                           24h backstop pass in sweep
```

### 1.1 Claim before query, not after — recommended deviation from decision 1/2

Decisions 1 and 2 specify: query Fireflies first, write the stub only on a
miss. That ordering has a live race:

1. Instant tapped → Fireflies query returns empty.
2. `meeting.summarized` fires *right now* → handler looks for a
   `Pending Instant` page → finds none (not written yet) → no-ops, per
   decision 4.
3. Handler writes the `Pending Instant` claim.
4. Nothing will ever complete it. The summarized event was the only one coming.
   The page sits until the 24h backstop.

The window is small (one Notion write) but it is exactly the window where
summarization completing is *most* likely — the query just told us it was
imminent.

**Recommendation: claim first, then query.** Write `Extraction State = Pending
Instant` before the Fireflies call; if the query then returns a summary,
complete immediately and clear the claim in the same finishing write. Costs one
extra Notion write on the happy path (~200ms, no quota concern) and closes the
race completely. It also gives the double-tap guard something to read (§3.4)
and makes a mid-run function crash recoverable rather than invisible.

This is the one place I'd change a stated decision on ordering grounds. If you
prefer the brief's order, the race above is the accepted cost and the backstop
becomes load-bearing rather than a safety net.

### 1.2 Where the completion work runs

`meeting.summarized` lands on `/fireflies`, which is **synchronous** with a
10-second Fireflies ack budget. Completing a page inline there is ~6 sequential
HTTP calls (Notion query, Fireflies summary, delete children, append blocks,
patch properties, Telegram send). Probably under 10s; not reliably so on a cold
start.

**Recommendation:** the summarized branch does one Notion query to find the
claimed page, then fires the existing background-function pattern
(`triggerPromotions`-style POST to `/promote` with an instant mode) and returns
200 immediately. This is the architecture the repo already established for
exactly this reason — see the comment block at
[netlify/functions/promote-background.js:5](netlify/functions/promote-background.js:5).

The Telegram tap path needs no such treatment: `/telegram` is already a
background function with 15 minutes
([netlify/functions/telegram.js:189](netlify/functions/telegram.js:189)), so
Instant runs inline there.

---

## 2. Notion property changes

### 2.1 New properties

| Property | Type | Options / notes |
|---|---|---|
| `Extraction State` | **Select** | Single option needed: `Pending Instant`. Empty/cleared is the normal state. |
| `Extracted By` | **Text** (rich_text) | Free-form model id string. Not a Select — model ids change with every release and a Select would accumulate dead options. |

**Name-collision check: both are clear.** The live schema is asserted to be
exactly `Name`, `Date`, `Source Meeting ID`, `Status`
([scripts/verify.js:60](scripts/verify.js:60)), and grepping the repo for
`Extraction State` / `Extracted By` returns nothing. Note `verify.js` checks
that expected properties are *present*, not that no others exist, so if the
database has extra properties added by hand they wouldn't show up in that
assertion — worth eyeballing the database directly during the manual-changes
walkthrough (§7).

**Select, not Status, for `Extraction State`.** `Status` in Notion is the
special three-group (To-do/In progress/Complete) type; `Extraction State` has
no lifecycle grouping and one meaningful value. Using Select also means Notion
auto-creates the option on first write, so a typo fails soft rather than 400ing
— matching the note at [scripts/verify.js:86](scripts/verify.js:86). The
existing `statusKind()` dual Select/Status detection
([lib/notion.js:88](lib/notion.js:88)) should **not** be generalised to this
property; fix it as Select and assert that in `verify.js`.

### 2.2 Properties explicitly NOT added

- **A second `meeting_id` field.** `Source Meeting ID` already is it (§0.3).
- **`Input Tokens` / `Output Tokens`.** Out of scope per the brief. Note for
  whoever picks that up later: `Extracted By` and the token fields are
  naturally written by the same call, so the two changes will touch the same
  lines in `patchMeeting`. Not a reason to merge them now, just a heads-up that
  a merge conflict is likely if both are in flight at once.

---

## 3. File-by-file changes

### Phase 0 — tier substrate (prerequisite)

**`lib/config.js`**
- Add to `props`: `extractionState: "Extraction State"`, `extractedBy: "Extracted By"`.
- Add `extractionState: { pendingInstant: "Pending Instant" }` alongside the
  existing `status` block, same pattern.
- Add a `tiers` block — the single source of truth for what each button does:
  each tier needs a callback key, a button label, a model id (or `null` for
  Instant), a thinking mode (§0.4), and the literal written to `Extracted By`.
  Instant's is `fireflies-deterministic` per decision 9.
- Model ids: Sonnet stays `claude-sonnet-5` (current default,
  [lib/config.js:20](lib/config.js:20)); Haiku is `claude-haiku-4-5-20251001`
  with thinking off.
- Keep `LLM_EXTRACT_MODEL` working as an override so the existing escape hatch
  and `scripts/test-llm.js` don't break.

**`lib/telegram.js`**
- Replace `sendYesNoPrompt` with a tier prompt. Recommend a 2×2 keyboard:
  Instant / Haiku on row one, Sonnet / Skip on row two.
- **Keep a Skip button.** The brief lists three tier buttons and no Skip, but
  dropping it deletes a working capability — recording that a meeting happened
  without recapping it — and orphans `config.status.skipped`,
  `config.text.skipped`, and [`skipMeeting()`](lib/promote.js:162). Flagging
  rather than assuming: if you genuinely want Skip gone, that's a separate
  deliberate removal.
- `callback_data` budget is fine: Telegram's cap is 64 bytes,
  `"instant:" + 26-char Fireflies id` is 34.

**`netlify/functions/telegram.js`**
- `handleCallback` parses `<tier>:<meetingId>` against the config tier table
  instead of hardcoded `yes`/`no`. Unknown action keeps its current fallback
  message.
- Instant gets its own branch (§3.2); Haiku/Sonnet share the existing promote
  branch with a tier argument.
- Update `HELP` text — it currently says "Tap Yes or No"
  ([netlify/functions/telegram.js:36](netlify/functions/telegram.js:36)).

**`lib/promote.js` / `lib/extract.js`**
- `promoteMeeting(pageId, { tier })` resolves model + thinking from the tier
  table and passes them down; `extractMeeting(transcript, { model, thinking })`
  forwards to `chat()`.
- On success, `patchMeeting` also writes `Extracted By = <exact model id>` and
  clears `Extraction State` (this is decision 6's tier-switch cancellation —
  it falls out for free here, because any tier completing a page clears the
  claim as part of its normal finishing write).
- `chat()` in [lib/llm.js:40](lib/llm.js:40) needs to accept and forward the
  per-request thinking mode rather than reading the global.

**`lib/notion.js`**
- `flattenMeeting`: surface `extraction_state` and `extracted_by`.
- `patchMeeting`: accept both new fields, including an explicit *clear* of
  `Extraction State` (Notion clears a Select with `{ select: null }` — distinct
  from omitting the key, and the current `if (name)`-style truthiness guards
  would swallow a clear, so this needs a sentinel, not a falsy value).

### Phase 1 — Instant tier and the race fix

**`lib/fireflies.js` — new `getSummary(id)`**
- One GraphQL query: `transcript(id) { id title date summary { overview action_items } }`.
- Deliberately does **not** request `sentences` — fetching the full transcript
  would defeat the point of the cheap tier.
- Requesting `title` and `date` in the same query is free and lets the completed
  Instant page get its real title, matching what the LLM path does at
  [lib/promote.js:114](lib/promote.js:114). Without it, Instant pages keep the
  "Meeting — Sep 1, 14:15" timestamp label forever.
- **Shape now VERIFIED against your account** (introspection + one real
  meeting, 2026-09-09) — `summary.action_items` and `summary.overview` are both
  **String**, not arrays. The real formats:

  `overview` — markdown bullet lines with a bold label:
  ```
  - **Canva Integration:** free and pro versions, 230 THB/month, 12-month contract
  - **Pricing & Discounts:** wholesale 110 THB, 50% combined discount
  ```

  `action_items` — owner headers, then one action per line with a `(MM:SS)`
  timestamp, groups separated by a blank line, every line ending in a markdown
  hard break (two spaces):
  ```
  **Napon Pouvaranukoah**
  Coordinate with IT for API integration (05:00)
  Negotiate the discount with Canva (10:00)

  **IT and Product team**
  Build the one-to-one activation link (16:00)
  ```

  So the parser must: strip trailing hard-break spaces; treat a `**...**`-only
  line as an owner header; attach following lines to that owner; strip `- ` and
  `**` from overview lines. It must degrade rather than throw on an unexpected
  shape — a summary is not schema-validated the way the LLM extraction is.
- Quota note: Instant adds one Fireflies request per tap plus one per
  completion. Against 50/day total shared with `/join` and `getTranscript`,
  that's comfortable at personal volume but worth knowing.

#### Instant pages will be in the meeting's language, not English

Worth deciding on before you use this in anger. `lib/extract.js` instructs the
model to "Write everything in English, even when the meeting was conducted in
another language" ([lib/extract.js:85](lib/extract.js:85)). **Fireflies' own
summary does no such thing** — the real meeting checked on 2026-09-09 came back
entirely in Thai.

So Haiku/Sonnet pages are English and Instant pages are whatever was spoken.
For "a meeting so low-importance I could just skip it" that is very probably
fine, and translating would need an LLM call, which would defeat the tier
entirely. But it means the Notion database becomes mixed-language, which
affects the chat loop: `search_meetings` matches on the **title** only
([lib/notion.js:196](lib/notion.js:196)) so search still works, but
`read_meeting` will hand the model Thai text to answer English questions about.
Claude handles that fine; flagging it because it is invisible until it happens.

No action recommended — just don't be surprised.

**`lib/render.js` — `renderInstantBlocks({ overview, actionItems })`**
- Belongs here, not in a new file: render.js's stated charter is deterministic
  content → Notion blocks with no model involvement
  ([lib/render.js:3](lib/render.js:3)), which is exactly what this is.
- Reuses `heading2` / `paragraph` / `bullet` and the existing
  `config.text.summaryHeading` / `actionsHeading` so an Instant page is
  visually identical in structure to an LLM one.
- Needs a small `parseFirefliesActionItems` helper: split on newlines, drop
  empties, strip `**Owner**` header markers into plain text. Keep it forgiving —
  it must not throw on an unexpected shape, only degrade.

**`lib/instant.js` — new, the orchestration**
- `claimInstant(pageId)` — sets `Extraction State = Pending Instant` and
  `Status = Processing`.
- `completeInstant(pageId, meetingId)` — the **single shared completion path**
  used by all three entry points (tap-with-summary-present, `meeting.summarized`,
  24h backstop). Fetches the summary, renders, `replaceBody`, then patches
  title / date / `Status = Done` / `Extracted By = fireflies-deterministic` /
  `Extraction State` cleared. Returns a result object, never throws — same
  contract as `promoteMeeting` and for the same reason
  ([lib/promote.js:16](lib/promote.js:16)).
- Body-then-status ordering must match `promoteMeeting`
  ([lib/promote.js:109](lib/promote.js:109)) so a half-write leaves a
  re-runnable page rather than a page marked Done with a partial body.

**`lib/notion.js` — new queries**
- `findPendingInstant(meetingId)` — filter `and: [Source Meeting ID equals,
  Extraction State equals "Pending Instant"]`. This is decision 4's lookup.
- `findStaleInstantStubs({ olderThanHours })` — `Extraction State = Pending
  Instant` and `last_edited_time` before the cutoff. Uses the same
  `timestamp: "last_edited_time"` filter shape already proven at
  [lib/notion.js:180](lib/notion.js:180).
- **`findSweepablePages`: add `Extraction State != "Pending Instant"`** to
  every arm of the existing `or`. This is the §0.2 fix. Without it the LLM
  sweep hijacks Instant stubs.

**`netlify/functions/fireflies.js` — event branching**

Placement matters and the brief asks about it explicitly. The correct order is
**unchanged from today**, with the branch replacing the current early-return:

1. Method check (line 30)
2. Read raw body (line 34)
3. **Signature verification (line 35)** — must stay first among the security
   checks; nothing may read `payload` before this
4. JSON parse (line 41)
5. **← the event branch goes here**, replacing lines 47–52
6. `meeting_id` presence check (line 54) — hoist above the branch, since both
   events need it

Three arms: `meeting.transcribed` → today's logic unchanged;
`meeting.summarized` → `findPendingInstant`, and if found trigger the
background completion, if not found log and 200 (decision 4's no-op, which
covers "user chose another tier" and "already done" identically); anything else
→ keep the existing acknowledge-and-ignore arm so an unsubscribed event never
causes a Fireflies retry.

**Useful de-risking fact for decision 8:** the current handler *already*
acknowledges unknown events with a 200
([netlify/functions/fireflies.js:49](netlify/functions/fireflies.js:49)).
Subscribing `meeting.summarized` against today's deployed code would be a
harmless no-op, not an error. Deploy-before-subscribe is still the right order
and should still be followed — but it's a preference, not a cliff, which is
worth knowing if the deploy and the dashboard change end up out of sequence.

**`netlify/functions/sweep.js` — 24h backstop pass**
- After the existing promotion pass, query `findStaleInstantStubs({ olderThanHours: 24 })`.
- **Open question for you (§6.1):** what the backstop should *do* with them.
- Scheduled functions get 30 seconds, so this pass must only *trigger* work,
  never perform it — same constraint as the existing pass
  ([netlify/functions/sweep.js:10](netlify/functions/sweep.js:10)).
- Cadence: `schedule` changes from `0 10 * * 5` to **`0 15 * * 2,5`** — Tuesday
  and Friday at 22:00 Bangkok (§6.2). Worst-case wait for a stranded stub drops
  from ~7 days to ~3½. Update the comment block at the top of the file and the
  routing note in [netlify.toml](netlify.toml), both of which name the old
  Friday-17:00 schedule.
- Backstop behaviour is §6.1 option (a): re-query, complete if the summary
  arrived, else `Status = Failed` + alert. Still zero LLM.

**`netlify/functions/promote-background.js`**
- Accept a `mode` (or `tier`) in the POST body and route to `completeInstant`
  vs `promoteMeeting`. Auth and the never-throw discipline stay exactly as they
  are.

**`scripts/verify.js`**
- Extend the expected-property list and the type map with the two new
  properties, and assert the `Pending Instant` Select option. Without this, a
  forgotten Notion UI step surfaces as a silent runtime failure days later —
  which is precisely what this script exists to prevent
  ([scripts/verify.js:4](scripts/verify.js:4)).

**`scripts/test-flow.js`**
- New cases, all runnable against the existing in-memory fakes with no network:
  Instant tap with summary present → page Done in one pass;
  Instant tap with summary absent → claimed, not Done;
  `meeting.summarized` → completes a claimed page;
  `meeting.summarized` → no-ops when no claimed page exists;
  double-tap Instant → second tap does nothing (§3.4);
  tier switch → claim cleared, no orphan;
  **sweep does not pick up a `Pending Instant` page** (the §0.2 regression guard —
  this is the single most valuable new test).

**`README.md`**
- Property table (line 174), the Yes/No description (lines 5, 26), the tier
  keyboard, the `meeting.summarized` subscription, and the Fireflies setup
  steps.

### 3.2 The Instant tap path, in order

1. `answerCallbackQuery` immediately (existing requirement,
   [netlify/functions/telegram.js:97](netlify/functions/telegram.js:97)).
2. `findMeetingByFirefliesId` → no page → existing "No Notion page found" reply.
3. **State guard** (§3.4) — bail if already Done / Skipped / claimed.
4. `editMessageText` to strip the keyboard (existing double-tap defence).
5. `claimInstant` (§1.1).
6. `getSummary` — one query, no retry, no wait, no polling (decision 1).
7. Summary present → `completeInstant` → "Recap saved" with the page URL,
   matching the existing success message shape
   ([lib/promote.js:125](lib/promote.js:125)).
8. Summary absent → leave the claim, reply "Fireflies hasn't finished
   summarising this one yet — I'll post it as soon as it's ready." Return.
   Nothing waits, nothing retries.

### 3.3 The `meeting.summarized` path

`findPendingInstant(meeting_id)` → found: trigger background `completeInstant`,
then a **follow-up** Telegram message (a new send, not an edit — the original
prompt message may be hours old and `editMessageText` on it would be confusing).
Not found: log, return 200, do nothing.

### 3.4 Double-tap and the "already done" edge case

You asked specifically that a repeat tap on a meeting already transcribed and
summarized into Notion does nothing. The existing keyboard-removal
([netlify/functions/telegram.js:105](netlify/functions/telegram.js:105)) is a
UI defence only — it doesn't survive Telegram redelivery, a stale message in
scrollback, or a second device. So the guard must be server-side, reading state
before spending anything:

| Page state on tap | Behaviour |
|---|---|
| `Status = Done` | Do nothing. Reply "That meeting already has a recap" + page URL. **No Fireflies query** — the guard sits before step 6 above so the quota is never spent. |
| `Status = Skipped` | Do nothing; reply saying so. |
| `Extraction State = Pending Instant` | Already claimed. Reply "already waiting on Fireflies" — do not re-claim, do not re-query. |
| `Status = Processing`, not stale | Another tier is mid-run; reply and stop. |
| `Status = Processing`, stale (>30 min) | Treat as abandoned and proceed — mirrors [`eligibility()`](lib/promote.js:30). |

The cleanest implementation extends `eligibility()` rather than writing a
parallel checker, so the Instant and LLM paths cannot drift on what "already
done" means. `eligibility()` needs one addition: `Extraction State = Pending
Instant` is not eligible for a *new* claim, but *is* eligible for
`completeInstant` — so it takes an intent argument, or Instant gets a thin
wrapper around it.

---

## 4. Deployment order

Unchanged from decision 8, with §3 of the plan noting it's a preference rather
than a cliff:

1. Add the two Notion properties by hand (§7) — code reading a missing property
   gets `undefined`, but writing to one 400s.
2. `npm test` then `npm run verify` locally — verify.js now checks the new
   properties, so this is the gate.
3. Deploy Phase 0 + Phase 1 together. Confirm live: `meeting.transcribed` still
   works end to end on a real meeting, and the tier keyboard renders.
4. **Only then** subscribe `meeting.summarized` in the Fireflies dashboard.
5. Test Instant on a fresh meeting, deliberately tapping it early enough to
   miss the summary, and confirm the follow-up lands.

---

## 5. What is explicitly not in this plan

- ~~`minutes_consumed` storage-cap empirical test~~ — **pulled in deliberately**
  and now built as `/space`. See §8.
- `Input Tokens` / `Output Tokens` — planned separately, per the brief. §2.2
  notes the likely overlap point.
- Any change to how Haiku/Sonnet extraction itself works. Phase 0 only routes a
  model id; it does not touch the prompt, schema, or `normalizeExtraction`.

---

## 6. Decisions (resolved 2026-09-09)

| # | Question | Decision |
|---|---|---|
| 6.1 | 24-hour backstop behaviour | **Option (a)** — re-query Fireflies, complete as Instant if the summary is now there; if still empty, `Status = Failed` + Telegram alert. Stays zero-LLM. |
| 6.2 | Sweep cadence | **Tuesdays and Fridays, 22:00 Bangkok** → `0 15 * * 2,5` (Bangkok is UTC+7, and Netlify cron is UTC). Replaces today's `0 10 * * 5`. |
| 6.3 | Keyboard | **2×2 grid** — Instant / Haiku on row one, Sonnet / Skip on row two. Skip is kept. |
| 6.4 | Real title on Instant pages | **Yes** — `getSummary` fetches `title` and `date` in the same query, so the page stops being "Meeting — Sep 1, 14:15". |
| 6.5 | Backfill `Extracted By` | **No.** Left empty on existing pages. |

### 6.6 Should `Extraction State` get more options? — No

You asked whether to add `Done` or `N/A`. Recommend neither, and the properties
as you created them are already correct.

- A `Done` option would duplicate `Status = Done`. Two fields expressing the
  same fact is two fields that drift, and the whole reason `Extraction State`
  is separate is that it answers a *different* question ("is Fireflies still
  owed a summary for this page?").
- Empty is a perfectly good "no, nothing pending" — and it is what every page
  written before this feature already has, so no migration is needed.

**One implementation detail this makes load-bearing.** Notion's `does_not_equal`
on a Select does not reliably match rows where the property is *empty*. Since
almost every page will have an empty `Extraction State`, the sweep exclusion
from §0.2 must be written as an explicit `or`:

```
or: [ { property: "Extraction State", select: { does_not_equal: "Pending Instant" } },
      { property: "Extraction State", select: { is_empty: true } } ]
```

Getting this wrong fails silently in the worst direction — the sweep would
match *nothing* and quietly stop recapping everything. It needs a test.

---

## 7. Manual changes outside the codebase — needs a walkthrough before implementation

None of these can be done by the implementing session. All should be reviewed
together before Sonnet starts writing code.

### 7.1 Notion — Meetings database ✅ DONE

You added `Extraction State` (Select, single option `Pending Instant`) and
`Extracted By`. That is exactly right — see §6.6 for why no further options are
wanted.

Two things still to confirm, both cheap:

- **`Extracted By` must be Text, not Select.** Model ids change every release
  and a Select would silently accumulate dead options.
- **Spelling is matched literally by the API** — `Extraction State`,
  `Extracted By`, `Pending Instant`, exact case and spacing. `npm run verify`
  will assert all of this once §3 extends it, so run it after Phase 0 lands.
  Until then a typo would surface as a confusing runtime 400.

No integration permission change needed — the existing integration already has
update capability on this database.

### 7.2 Fireflies dashboard — event subscription (do this LAST)

At **app.fireflies.ai → Integrations → Webhooks V2**
(`https://app.fireflies.ai/integrations/api/webhook`):

- Add `meeting.summarized` to the **existing** webhook's subscribed events.
  Same URL (`https://<site>.netlify.app/fireflies`), same signing secret. Do
  **not** create a second webhook endpoint (decision 3).
- Only after the branching handler is confirmed live (§4). Today's code would
  no-op it harmlessly (§3), but the ordering is still correct.
- Worth confirming during the walkthrough: that the dashboard actually offers
  `meeting.summarized` as a subscribable event on the current plan, and whether
  it delivers for meetings summarized *before* the subscription was added.
  Neither is documented in this repo.

### 7.3 Netlify

- **No new environment variables required.** Everything new lives in
  `config.js` as literals — model ids, tier labels, the
  `fireflies-deterministic` string. If you'd rather have the tier model ids be
  env-overridable, say so now; it's a small change but it means new dashboard
  vars and a `.env.example` update.
- **No function config changes** unless §6.2 lands on a daily sweep, in which
  case the `schedule` in
  [netlify/functions/sweep.js:37](netlify/functions/sweep.js:37) changes — that
  is a code change, not a dashboard one, since schedules are declared in-file.
- **No new function paths.** `/fireflies` gains a branch; `/promote` gains a
  mode. Both keep their existing routes.

### 7.4 Telegram

Nothing. `allowed_updates` already includes `callback_query`
([scripts/setup-webhook.js:45](scripts/setup-webhook.js:45)), which is what
carries every tier tap. No re-registration needed.

### 7.5 Verification against a real meeting ✅ DONE

Completed 2026-09-09 — the shapes are in §3 (`lib/fireflies.js`) and the
language finding is the subsection just below it. Nothing left to do here; the
parser can be written against known formats rather than assumptions.

Cost of that investigation: 3 Fireflies requests of the 50/day (two schema
introspections and one real summary), plus 1 for the `/space` test.

### 7.6 Fireflies storage — the one thing only you can do

`/space` reports 164 of 400 minutes used across 4 transcripts. To settle
whether that meter is cumulative (§8.1), delete a transcript in Fireflies and
run `/space` again. Everything about whether the command survives as built
depends on that one observation.

---

## 8. `/space` — Fireflies storage meter (BUILT)

Implemented, tested, and passing. One Fireflies API call; **zero Notion calls,
zero LLM tokens** — asserted by a test, not just claimed (§10).

```
/space
──▶ Fireflies storage: 164 of 400 minutes used (40%).
    236 minutes left, across 4 transcript(s).
```

Past the threshold it appends:

```
    That is past the 320-minute mark — clear some transcripts in Fireflies soon.
    Anything already recapped into Notion is safe to delete there.
```

**What was verified against your live account** (GraphQL introspection, so the
field list is authoritative rather than guessed):

`User` exposes `minutes_consumed: Float` and `num_transcripts: Float`, plus
`user_id`, `email`, `name`, `recent_meeting`, `recent_transcript`, `is_admin`,
`is_calendar_in_sync`, `integrations`, `user_groups`. There is **no** field for
a plan cap, a quota ceiling, or remaining space — so the 400 is necessarily a
constant on our side, not something Fireflies tells us. It lives in
`config.fireflies.minutesAllowance`, overridable via
`FIREFLIES_MINUTES_ALLOWANCE`, with the warn point at
`FIREFLIES_MINUTES_WARN_AT` (default 320, your number).

Edge cases covered by tests: at/below/above the threshold, over 100% of cap
(clamps to "0 minutes left", never negative), Fireflies rate-limited, Fireflies
returning non-JSON. Percentage uses `floor`, so 398/400 reads "99%" rather than
"100%" beside "2 minutes left".

### 8.1 The cumulative question — how to settle it

Unresolved by design; it can only be answered empirically, exactly as you said.

**Baseline recorded 2026-09-09: `minutes_consumed` = 163.76, across 4
transcripts.**

The test: delete one or more transcripts in Fireflies, then run `/space`.

- **Number goes down** → it measures *stored* minutes. `/space` is correct as
  built and needs nothing further.
- **Number stays at 163.76** → it is a lifetime counter. `/space` then reports
  usage-since-signup, not remaining space, and becomes actively misleading once
  you start purging.

If it turns out cumulative, the workaround you sketched (a manual "I cleared
Fireflies" reset) needs somewhere to persist the baseline, and this project has
no key-value store. Cheapest option that adds no new dependency: keep the
baseline as an env var and expose the current reading so you can update it —
but that means a Netlify dashboard edit per purge, which is clunky for
something you would press regularly. The alternative is one Notion page acting
as a settings row. **Not designed further until the test says it is needed** —
which is your own sequencing, and avoids building a mechanism that may be
unnecessary.

Note `num_transcripts` is the better signal if the meter turns out cumulative:
it unambiguously reflects what is *currently stored*, and `/space` already
reports it.

---

## 9. Testing Instant without the Fireflies dashboard

You have not subscribed `meeting.summarized`, and per §4 you should not until
the branching handler is live. That is fine — the event is fully testable
without it, and `scripts/sign.js` has been extended to make that possible.

Previously it hardcoded `event: "meeting.transcribed"` and could not produce a
summarized payload at all. Now:

```bash
npm run sign -- <meeting_id> meeting.summarized
```

It prints a correctly HMAC-signed `curl` you can fire at `netlify dev` or at the
deployed site, which exercises the real handler through the real signature
check. The payload also omits `client_reference_id` for summarized events,
mirroring Fireflies' actual behaviour, so a fake payload cannot pass where a
real one would fail. Both old argument forms still work; the event and the URL
are detected by shape, not position.

**Suggested manual sequence** once Phase 1 is built — no dashboard change, no
LLM spend, and a low-importance meeting is the right subject:

1. `npm run sign -- <real_meeting_id>` → fire it → stub page + tier keyboard.
2. Tap **Instant** on a meeting Fireflies has *not* finished summarising →
   expect "not ready yet" and `Extraction State = Pending Instant`.
3. `npm run sign -- <same_id> meeting.summarized` → fire it → expect the page to
   complete and a follow-up Telegram message.
4. Fire the same summarized curl **again** → expect a clean no-op (decision 4),
   no second write, no duplicate message.
5. Tap **Instant** again on the now-Done page → expect "already has a recap"
   and, critically, **no Fireflies call at all** (§3.4).

Step 4 and step 5 are the two that would actually cost you something if they
regress, so they are worth doing by hand even though tests cover them.

---

## 10. Cost and quota verification

You asked to be sure Instant spends no tokens and does not hammer Notion. The
answer has two halves, and the first correction is to the premise.

### 10.1 Notion has no allowance to eat

Notion's documented limit is a **rate** limit — roughly 3 requests/second,
100 blocks per append, 2000 characters per text object
([README.md:266](README.md:266)). There is no monthly request quota and no
call budget to exhaust. A burst is throttled, never billed, and
[`notionRequest`](lib/notion.js:15) already retries 429s with backoff. So
"eating my Notion allowance" is not a risk that exists.

The budgets that *are* finite:

| Budget | Ceiling | What Instant costs |
|---|---|---|
| Anthropic tokens | pay-per-use | **zero** |
| Fireflies API | 50 requests/day | **1** per tap, **1** per completion |
| Fireflies storage | 400 minutes | zero — Instant reads, never records |
| Notion | rate limit only, no quota | ~6–7 requests per completed page |

### 10.2 Proving zero tokens rather than asserting it

The `/space` tests already demonstrate the pattern, and it should be reused for
Instant. `scripts/test-flow.js` now carries a `store.notionRequests` counter
alongside the existing `chatRequests`, so a test can assert *exact* costs:

```
equal(store.usageFetches, 1,        "/space must make exactly one Fireflies request");
equal(store.chatRequests.length, 0, "/space must never call the model");
equal(store.notionRequests, before, "/space must never call Notion");
```

For Instant the equivalent assertions belong in the Phase 1 tests:

- `chatRequests.length === 0` across the whole Instant path — tap, completion,
  and backstop. This is the guarantee that matters, and it is mechanical: the
  fake model API throws if called unexpectedly, so a stray LLM call fails the
  suite loudly rather than silently costing money.
- Fireflies request count is exactly 1 per tap and 1 per completion — no
  polling, no retry, per decision 1.
- A repeat tap on a `Done` page makes **zero** Fireflies requests, because the
  state guard sits before the query (§3.4).

That last one is the assertion worth writing first: it is the case you
specifically asked about, and the only way to get it wrong is to put the guard
in the wrong place.

---

## 11. What is already built (diff summary)

Everything below is committed to the working tree, syntax-checked, and covered
by `npm test` (all tests passing, including the pre-existing suite).

| File | Change |
|---|---|
| [lib/fireflies.js](lib/fireflies.js) | `getUsage()` — one GraphQL query for `minutes_consumed` / `num_transcripts` |
| [lib/config.js](lib/config.js) | `fireflies.minutesAllowance` (400) and `minutesWarnAt` (320) |
| [netlify/functions/telegram.js](netlify/functions/telegram.js) | `handleSpace()`, `/space` route, HELP entry |
| [scripts/sign.js](scripts/sign.js) | selectable event, shape-detected args, summarized payload shape |
| [scripts/test-flow.js](scripts/test-flow.js) | usage query fake, `notionRequests` counter, two `/space` tests |
| [.env.example](.env.example) | the two optional overrides |
| [README.md](README.md) | `/space` in the flow diagram, storage cap in the limits table |

**Not touched:** every file the Instant tier will need to change. Phase 0 and
Phase 1 remain entirely unstarted, so the Sonnet session gets a clean slate.
