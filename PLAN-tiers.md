# Extraction Tiers — Implementation Plan (draft for review)

**Supersedes an earlier draft, `PLAN.md`**, which was deleted once this document
replaced it — recover it with `git show 0271589:PLAN.md` if you ever want the
reasoning behind a decision restated below. Same underlying feature, re-scoped
around the final decision: a **four-button keyboard** — `Haiku`, `Sonnet`, `Notes`, `Skip` — with
**Haiku as the default tier**. "Notes" was called "Instant" in the earlier draft: a
zero-LLM recap built from Fireflies' own meeting summary.

Everything in Part I was **plan only, not yet built** when written, except the
pieces that had already shipped (`/space`, the event-selectable `scripts/sign.js`, the
`notionRequests` / `usageFetches` test counters). Those stay as they are.

This document is written to be read cold. Every decision that was settled in the
earlier draft is restated here in full, so nothing depends on that file.

---

## 1. Goal

One Notion page per meeting, created by the `meeting.transcribed` webhook exactly
as today. When the transcript is ready, the Telegram prompt offers four choices:

| Button | Callback key | What it does | Cost |
|---|---|---|---|
| **Haiku** | `haiku:` | LLM extraction on `claude-haiku-4-5-20251001`, thinking **off** | Anthropic tokens (cheap) |
| **Sonnet** | `sonnet:` | LLM extraction on `claude-sonnet-5`, thinking `adaptive` | Anthropic tokens |
| **Notes** | `notes:` | No LLM. Pulls Fireflies' own `summary { overview action_items }`, renders it deterministically | 1–2 Fireflies API calls, zero tokens |
| **Skip** | `no:` | `Status = Skipped`, page kept as a record | none |

**Haiku is the default**: it is `extractTiers[0]`, it is what the `/sweep` and the
scheduled sweep use (no interactive prompt there), and it is what a legacy `yes:`
callback maps to.

Non-goals, unchanged from the earlier draft:

- No change to the LLM extraction prompt, schema, or `normalizeExtraction`
  (`lib/extract.js`). Tiers route a model id + thinking mode; they do not touch
  how extraction works.
- No `Input Tokens` / `Output Tokens` properties.
- The OpenRouter path must keep working — see §6.

---

## 2. Current state of the repo, before any of this was built

| Concern | Today |
|---|---|
| Keyboard | `sendYesNoPrompt` — two buttons, `yes:<id>` / `no:<id>` — [lib/telegram.js:39](lib/telegram.js:39) |
| Callback routing | hardcoded `yes` / `no` in `handleCallback` — [netlify/functions/telegram.js:129](netlify/functions/telegram.js:129) |
| Model selection | one global `LLM_EXTRACT_MODEL` → falls back to `LLM_MODEL` → `"claude-sonnet-5"` — [lib/config.js:16](lib/config.js:16) |
| Thinking | one global `config.llm.thinking` = `"adaptive"`, applied to **every** Anthropic request — [lib/llm/anthropic.js:86](lib/llm/anthropic.js:86) |
| Provider switch | `config.llm.provider` (`"anthropic"` \| `"openrouter"`), adapter picked in `lib/llm.js` — [lib/llm.js:33](lib/llm.js:33) |
| Extraction entry | `extractMeeting(transcript)` reads `config.llm.extractModel()` itself — [lib/extract.js:171](lib/extract.js:171) |
| Promotion | `promoteMeeting(pageId, { allowFailed, notify })` — the single shared "promote if still pending" path, never throws — [lib/promote.js:62](lib/promote.js:62) |
| Sweep eligibility | `findSweepablePages()` filters on `Status` only (Pending, or Processing > 30 min stale) — [lib/notion.js:169](lib/notion.js:169) |
| Scheduled sweep | `0 10 * * 5` — Friday 17:00 Bangkok — [netlify/functions/sweep.js](netlify/functions/sweep.js) |
| Fireflies webhook | `/fireflies`, synchronous, only acts on `meeting.transcribed`; unknown events get a harmless 200 — [netlify/functions/fireflies.js:49](netlify/functions/fireflies.js:49) |
| Notion schema | `Name`, `Date`, `Source Meeting ID`, `Status`, **plus** `Extraction State` and `Extracted By` added by hand (see §3) |

Four premises still hold and drive the design below:

- **P1 — the sweep will hijack Notes stubs.** `findSweepablePages` knows nothing
  about `Extraction State`, so a page waiting on a Fireflies summary gets grabbed
  by `/sweep` or the Friday job and silently given a *paid LLM* recap. The sweep
  filter **must** exclude `Extraction State = Pending Notes`. Required, not optional.
- **P2 — the stub page already exists.** `meeting.transcribed` created it. Tapping
  a button patches that page; it never creates one. No duplicate-page risk on this
  path; the real risk is re-running work on one page (state guard, §7).
- **P3 — a Haiku tier 400s on the first call as currently wired.** `adaptive`
  thinking is a Claude-5-family parameter; Haiku 4.5 rejects it with a 400
  ([lib/config.js:29](lib/config.js:29) already says so). The moment Haiku is
  selectable per-meeting, one global `LLM_THINKING` cannot serve both tiers.
  Thinking has to become per-tier. Hard blocker.

---

## 3. Notion properties — already added, confirm only

Both were added by hand in Notion:

| Property | Type | Notes |
|---|---|---|
| `Extraction State` | **Select** | One option: `Pending Notes`. Empty = normal. **Not** Notion's Status type — no lifecycle grouping, and Select auto-creates the option on first write so a typo fails soft. |
| `Extracted By` | **Text** (rich_text) | Free-form model id. Never a Select — model ids change every release and dead options would accumulate. |

> The earlier draft used the label **`Pending Instant`**, and that is the option
> that exists in Notion today. The code matches this string **literally**, so
> either rename the option to `Pending Notes` in the Notion UI **or** set
> `NOTES_STATE_LABEL=Pending Instant`. `verify.js` reports which literal is in
> use and flags the stray on every run. See Part II §G.

**No further `Extraction State` options.** A
`Done` option would duplicate `Status = Done` and the two would drift. Empty is a
fine "nothing pending" and needs no migration.

**No backfill.** Existing pages keep
`Extracted By` empty.

---

## 4. `lib/config.js` — the tier table

Add one block that is the single source of truth for what each button does:

```js
// Extraction tiers. The keyboard, the callback router, and promoteMeeting all
// read this — nothing about a tier is defined anywhere else.
//   model:      Anthropic model id, or an OpenRouter-namespaced id when
//               LLM_PROVIDER=openrouter, or null for the no-LLM Notes tier.
//   thinking:   per-tier, because Haiku 4.5 400s on "adaptive" (see the
//               thinking note above). Ignored by the OpenRouter adapter.
//   extractedBy: literal written to the Notion "Extracted By" property.
extractTiers: [
  {
    key: "haiku",
    label: "Haiku",
    model: process.env.LLM_MODEL_HAIKU || "claude-haiku-4-5-20251001",
    thinking: "off",
    extractedBy: null, // → write the resolved model id
  },
  {
    key: "sonnet",
    label: "Sonnet",
    model: process.env.LLM_MODEL_SONNET || "claude-sonnet-5",
    thinking: process.env.LLM_THINKING || "adaptive",
    extractedBy: null, // → write the resolved model id
  },
  {
    key: "notes",
    label: "Notes",
    model: null, // no LLM
    thinking: null,
    extractedBy: "fireflies-notes",
  },
],

// Kept working as a hard override for both LLM tiers at once: if set, Haiku and
// Sonnet both resolve to this model. The existing escape hatch and
// scripts/test-llm.js keep working. Does not affect the Notes tier.
extractModel: () => process.env.LLM_EXTRACT_MODEL || null,
```

Also add to `props`:

```js
extractionState: "Extraction State",
extractedBy: "Extracted By",
```

and, matching the existing `status` block:

```js
extractionState: { pendingNotes: "Pending Notes" }, // or "Pending Instant" — §3
```

**Skip button** stays wired to the existing `config.status.skipped` /
`config.text.skipped` / `skipMeeting()` path — no change there.

**Default tier** = `extractTiers[0]` (`haiku`). A single helper resolves a tier by
key and falls back to that default:

```js
export function resolveTier(key) {
  return config.extractTiers.find((t) => t.key === key) || config.extractTiers[0];
}
```

---

## 5. File-by-file changes

### 5.1 `lib/telegram.js` — the keyboard

Replace `sendYesNoPrompt` with `sendTierPrompt(meetingId, label)`. **2×2 grid**,
LLM tiers on top, cheap options below:

```
[ Haiku ] [ Sonnet ]
[ Notes ] [ Skip   ]
```

Buttons are generated from `config.extractTiers` + a literal Skip, so adding or
renaming a tier never touches this file again. `callback_data` budget is fine:
`"sonnet:" + 26-char Fireflies id` = 33 bytes against Telegram's 64.

Keep `sendYesNoPrompt` as a thin alias (or delete it and update the one caller in
`netlify/functions/fireflies.js:75`). Message text changes from "Create a recap in
Notion?" to something like "Transcript ready: <label> — recap it how?".

### 5.2 `netlify/functions/telegram.js` — callback routing

`handleCallback` currently splits `action:meetingId` and branches on `yes`/`no`.
New shape:

- `no` → unchanged (`skipMeeting`).
- `yes` → **back-compat alias** → treat as `haiku` (a stale prompt still in
  scrollback keeps working after deploy).
- any key in `config.extractTiers`:
  - `notes` → the Notes branch (§5.6).
  - `haiku` / `sonnet` → `editMessageText` to strip the keyboard, then
    `promoteMeeting(page_id, { tier: key })`. The toast and the edited message
    name the model: `"Building the recap with Haiku…"`.
- unknown key → keep the existing `Unrecognised action "…"` fallback.

Update `HELP` (`netlify/functions/telegram.js:36`) — it currently says "Tap Yes or
No."

### 5.3 `lib/promote.js` — thread the tier

`promoteMeeting(pageId, { allowFailed = false, notify = true, tier = "haiku" } = {})`:

- `const t = resolveTier(tier);`
- `const model = config.extractModel() || t.model;`
- `const thinking = t.thinking;`
- pass `{ model, thinking }` into `extractMeeting`.
- on success, `patchMeeting` also writes `Extracted By = (t.extractedBy ?? model)`
  **and clears `Extraction State`** — the tier-switch cleanup falls out for free,
  because any tier finishing a page clears the claim.
- success message names the tier: `"Recap saved (Haiku): <title>\n<url>"`.

`/sweep` and the scheduled sweep call `promoteMeeting` with no `tier` → default
Haiku. **This is a behaviour change** (today the global default is Sonnet) and it
is intended — cheaper unattended recaps. Call it out in the README.

### 5.4 `lib/extract.js` — accept the override

`extractMeeting(transcript, { model, thinking } = {})`:

- `const chosenModel = model || config.llm.extractModel?.() || config.llm.model;`
  (keep today's fallback so any other caller is unaffected).
- pass `thinking` through to `chat()`.

### 5.5 `lib/llm.js` + `lib/llm/anthropic.js` — per-request thinking

- `lib/llm.js` `chat(request)` — forward `request.thinking` to the adapter
  alongside `model`.
- `lib/llm/anthropic.js` `chat()` — replace the global read
  ([lib/llm/anthropic.js:86](lib/llm/anthropic.js:86)):

  ```js
  const think = thinking ?? config.llm.thinking; // per-request wins
  if (think && think !== "off") body.thinking = { type: think };
  ```

- `lib/llm/openrouter.js` — **no change needed.** It destructures only the params
  it supports; an extra `thinking` argument is ignored. Its header comment already
  documents that thinking has no OpenAI-compatible equivalent.

### 5.6 The Notes tier (was "Instant")

> **Superseded by Part II §B.** The paragraph below records what was believed
> when Part I was written: that `summary.overview` and `summary.action_items` are
> both **strings**, not arrays. `action_items` held up exactly. `overview` did
> not — it is a bold-bullet list on this account, not prose — and a much better
> structured-recap field exists. Read §B before this section.

The Notes tier renders Fireflies' own summary with no model call.

**`lib/fireflies.js` — new `getSummary(id)`**
- One GraphQL query: `transcript(id) { id title date summary { overview action_items } }`.
- Does **not** request `sentences` — fetching the full transcript would defeat the
  cheap tier.
- `title` + `date` come back in the same query for free, so a completed Notes page
  gets its real title instead of the `"Meeting — Sep 1, 14:15"` stub label.

**`lib/render.js` — `renderNotesBlocks({ overview, actionItems })`**
- Belongs in `render.js` (its charter is deterministic content → Notion blocks, no
  model). Reuses `heading2` / `paragraph` / `bullet` and
  `config.text.summaryHeading` / `actionsHeading` so a Notes page is structurally
  identical to an LLM one.
- `parseFirefliesActionItems` helper: strip trailing hard-break spaces, treat a
  `**…**`-only line as an owner header, attach following lines to that owner, strip
  `- ` / `**` from overview lines. **Must degrade, never throw** — a Fireflies
  summary is not schema-validated the way the LLM extraction is.
- Language note: Fireflies summaries come back in the meeting's
  language (Thai for the verified meeting), whereas LLM pages are forced to
  English. Accepted — translating would need an LLM call. The DB becomes
  mixed-language; `search_meetings` matches on title only so search still works.

**`lib/notes.js` — new, the orchestration** (the earlier draft called it `lib/instant.js`)
- `claimNotes(pageId)` — sets `Extraction State = Pending Notes`, `Status = Processing`.
- `completeNotes(pageId, meetingId)` — the **single shared completion path** for
  all three entry points (tap-with-summary-present, `meeting.summarized`, 24h
  backstop). Fetch summary → render → `replaceBody` → patch
  title/date/`Status = Done`/`Extracted By = fireflies-notes`/clear
  `Extraction State`. Returns a result object, **never throws** — same contract as
  `promoteMeeting` and for the same reason.
- Body-then-status ordering must match `promoteMeeting`
  ([lib/promote.js:109](lib/promote.js:109)) so a half-write leaves a re-runnable
  page.

**`lib/notion.js`**
- `flattenMeeting`: surface `extraction_state` and `extracted_by`.
- `patchMeeting`: accept both new fields **and an explicit clear** of
  `Extraction State`. Notion clears a Select with `{ select: null }`, which is
  distinct from omitting the key — and today's `if (name)`-style truthiness guards
  would swallow it. Needs a sentinel value, not a falsy one.
- `findPendingNotes(meetingId)` — `and: [Source Meeting ID equals, Extraction
  State equals "Pending Notes"]`.
- `findStaleNotesStubs({ olderThanHours })` — `Extraction State = Pending Notes`
  and `last_edited_time` before cutoff. Same `timestamp: "last_edited_time"` shape
  already used at [lib/notion.js:180](lib/notion.js:180).
- **`findSweepablePages` — exclude Notes stubs.** This is the P1 fix. Notion's
  `does_not_equal` on a Select does **not** match empty rows, and almost every
  page has an empty `Extraction State`, so it must be an explicit `or` on every
  arm:

  ```
  or: [ { property: "Extraction State", select: { does_not_equal: "Pending Notes" } },
        { property: "Extraction State", select: { is_empty: true } } ]
  ```

  Getting this wrong fails silent in the worst direction — the sweep matches
  nothing and quietly stops recapping everything. Needs a dedicated test.

**`netlify/functions/fireflies.js` — event branching**
- Order stays: method check → raw body → **signature verify (must stay first)** →
  JSON parse → **event branch** → hoist the `meeting_id` presence check above the
  branch (both events need it).
- Three arms: `meeting.transcribed` → today's logic unchanged; `meeting.summarized`
  → `findPendingNotes`, and if found fire background completion (below), else log +
  200; anything else → keep the acknowledge-and-ignore arm.
- `meeting.summarized` lands on the **synchronous** `/fireflies` with a 10-second
  Fireflies ack budget. Do **not** complete inline. Do one Notion query to find
  the claimed page, then POST to `/promote` with a `mode: "notes"` and return 200
  immediately — the pattern the repo already uses
  ([netlify/functions/promote-background.js:5](netlify/functions/promote-background.js:5)).

**`netlify/functions/promote-background.js`**
- Accept `mode` (or `tier`) in the POST body; route to `completeNotes` vs
  `promoteMeeting`. Auth and the never-throw discipline unchanged.

**`netlify/functions/sweep.js` — 24h backstop**
- After the existing promotion pass, `findStaleNotesStubs({ olderThanHours: 24 })`.
- Backstop behaviour: re-query Fireflies, complete as Notes if the summary is now
  there; if still empty, `Status = Failed` + Telegram alert. Stays zero-LLM.
- Scheduled functions get 30 seconds — this pass only **triggers**, never performs.
- Cadence: `0 10 * * 5` → **`0 15 * * 2,5`** (Tue + Fri
  22:00 Bangkok). Worst-case wait for a stranded stub drops from ~7 days to ~3½.
  Update the file's top comment and the routing note in `netlify.toml`.

---

## 6. Keeping the OpenRouter path alive

The reviewer flagged this explicitly. The tier work must not close the door on
`LLM_PROVIDER=openrouter`.

What protects it:

- **Tiers never mention a provider.** `promoteMeeting` resolves a `model` string
  and hands it to `chat()`, which picks the adapter from `config.llm.provider`
  exactly as it does today ([lib/llm.js:33](lib/llm.js:33)). No tier code imports
  an adapter.
- **Tier model ids are env-overridable** — `LLM_MODEL_HAIKU`, `LLM_MODEL_SONNET`
  (§4). For an OpenRouter trial: set `LLM_PROVIDER=openrouter`,
  `OPENROUTER_API_KEY=…`, and point the tiers at namespaced ids
  (`anthropic/claude-haiku-4-5`, `google/gemini-2.5-pro`, …). No code change.
- **`LLM_EXTRACT_MODEL` still hard-overrides both LLM tiers** at once, so the
  current one-knob escape hatch and `scripts/test-llm.js` are untouched.
- **`thinking` is Anthropic-only and already handled** — the OpenRouter adapter
  ignores the param and its comment says why. The per-request change in §5.5 is
  additive.
- **`.env.example`** gains `LLM_MODEL_HAIKU` / `LLM_MODEL_SONNET` (both optional,
  commented) next to the existing `LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRACT_MODEL`
  / `LLM_THINKING` entries.

A **per-tier provider** (Haiku via Anthropic, Sonnet via OpenRouter at the same
time) would be a bigger change — `chat()` would take a provider argument instead
of reading the global — and was ruled out of scope; see Part II §A decision 5.

---

## 7. Double-tap / already-done guard

The keyboard-removal on tap is a UI defence only — it does not survive Telegram
redelivery, a stale message in scrollback, or a second device. The guard must be
server-side, **before any Fireflies or LLM call**:

| Page state on tap | Behaviour |
|---|---|
| `Status = Done` | Do nothing. Reply "already has a recap" + URL. **No Fireflies query** — guard sits before the summary fetch, so quota is never spent. |
| `Status = Skipped` | Do nothing; reply saying so. |
| `Extraction State = Pending Notes` | Already claimed. Reply "already waiting on Fireflies"; do not re-claim, do not re-query. |
| `Status = Processing`, not stale | Another tier mid-run; reply and stop. |
| `Status = Processing`, stale (>30 min) | Treat as abandoned; proceed. Mirrors `eligibility()` — [lib/promote.js:22](lib/promote.js:22). |

Cleanest implementation extends `eligibility()` rather than writing a parallel
checker, so the LLM and Notes paths cannot drift on what "already done" means.
`eligibility()` needs one addition: `Extraction State = Pending Notes` is not
eligible for a *new* claim but *is* eligible for `completeNotes` — so it takes an
intent argument, or Notes gets a thin wrapper.

Claim-before-query for the Notes tap: write `Extraction State =
Pending Notes` **before** calling `getSummary`. If the query then returns a
summary, complete immediately and clear the claim in the same finishing write.
Costs one extra Notion write on the happy path and closes the race where
`meeting.summarized` fires during the tap handler.

---

## 8. Manual changes outside the code

| Where | Change | When |
|---|---|---|
| **Notion** | `Extraction State` (Select, one option) + `Extracted By` (Text) — **done**. `npm run verify` confirms both types and reports the option spelling in use. | before deploy |
| **Fireflies dashboard** | Add `meeting.summarized` to the **existing** Webhooks V2 subscription — same URL, same signing secret. Do **not** create a second endpoint. | **after** the branching handler is live (§9) |
| **Notion** | `Extraction State` needs **one** option and only one. There is deliberately no `Done` option: it would duplicate `Status = Done` and the two would drift. Empty means "nothing pending". | before deploy |
| **Netlify env** | Optional: `LLM_MODEL_HAIKU`, `LLM_MODEL_SONNET` for OpenRouter trials. Nothing required. | any time |
| **Telegram** | Nothing — `allowed_updates` already includes `callback_query` ([scripts/setup-webhook.js:45](scripts/setup-webhook.js:45)). | — |

Note: today's deployed handler already 200s unknown events, so
subscribing `meeting.summarized` early is a harmless no-op, not a failure. Deploy
before subscribe is still the right order — a preference, not a cliff.

Still unconfirmed, and only answerable against the live dashboard: whether the
Fireflies plan offers `meeting.summarized` as subscribable at all, and whether it
fires for meetings summarised *before* the subscription was added. Neither is
documented. The 24-hour backstop covers both cases either way, which is why
neither blocks the deploy.

---

## 9. Deployment order

1. Confirm the two Notion properties by hand (§8).
2. `npm test` then `npm run verify` locally — `verify.js` now checks the new
   properties and the Select option, so this is the gate.
3. Deploy everything (LLM tiers + Notes tier) together. Confirm live:
   `meeting.transcribed` still works end to end, and the 4-button keyboard renders.
4. **Only then** subscribe `meeting.summarized` in the Fireflies dashboard.
5. Test Notes on a fresh meeting, tapping early enough to miss the summary, and
   confirm the follow-up message lands when `meeting.summarized` arrives. The
   `scripts/sign.js -- <id> meeting.summarized` helper (already built) exercises
   this without the dashboard.

---

## 10. Tests (`scripts/test-flow.js`, all against the in-memory fakes)

LLM tiers:

- Tap `haiku:` → `chat` called with `model: "claude-haiku-4-5-20251001"` and **no
  `thinking`** in the request body; page `Done`; `Extracted By =
  claude-haiku-4-5-20251001`.
- Tap `sonnet:` → `model: "claude-sonnet-5"`, `thinking: { type: "adaptive" }`
  present; `Extracted By = claude-sonnet-5`.
- Tap `yes:` (legacy alias) → behaves exactly as `haiku:`.
- `LLM_EXTRACT_MODEL` set → both `haiku:` and `sonnet:` resolve to that model.
- Existing `no:` / skip case unchanged.

Notes tier:

- Tap `notes:` with summary present → page `Done` in one pass, `chatRequests.length
  === 0`, exactly 1 Fireflies summary fetch.
- Tap `notes:` with summary absent → `Extraction State = Pending Notes`, not
  `Done`, no second write.
- `meeting.summarized` → completes a claimed page; fires a **new** Telegram message
  (not an edit — the prompt may be hours old).
- `meeting.summarized` → clean no-op when no claimed page exists.
- Double-tap `notes:` on a `Done` page → **zero** Fireflies requests (guard before
  query, §7).
- Tier switch (`notes:` then `sonnet:`) → claim cleared, no orphan `Extraction
  State`.
- **`findSweepablePages` does not return a `Pending Notes` page** — the P1
  regression guard, the single most valuable new test. Also assert it still
  returns a normal empty-`Extraction State` page (the `is_empty` arm).

`scripts/verify.js`: extend the expected-property list + type map with the two new
properties; assert the Select option exists; print the tier table in the env
check.

`README.md`: property table, the Yes/No description, the 4-tier keyboard, the
`meeting.summarized` subscription, the sweep cadence change, and that unattended
sweeps now use Haiku.

---

## 11. Open decisions for the review — ALL RESOLVED, see Part II §A

1. **Select option label** — `Pending Notes` vs keeping `Pending Instant` as
   already created in Notion (§3). Pick the literal; `verify.js` will enforce it.
2. **`Extracted By` literal for the Notes tier** — `fireflies-notes` (proposed) vs
   the earlier draft's `fireflies-deterministic` vs something else.
3. **Keyboard layout** — 2×2 `Haiku/Sonnet` over `Notes/Skip` (proposed) vs a
   single row of four vs `Notes` first. Telegram renders a single row of four
   narrow buttons acceptably on desktop, less so on mobile.
4. **Default-tier behaviour change is acceptable** — `/sweep` and the Friday job
   move from Sonnet to Haiku. Confirm.
5. **Per-tier provider** (Haiku on Anthropic + Sonnet on OpenRouter at the same
   time) — out of scope here; confirm that's fine or pull it in (§6).
6. **`LLM_EXTRACT_MODEL` semantics** — keep it as a both-tiers hard override
   (proposed), or retire it now that per-tier `LLM_MODEL_*` exist.

---

## 12. Files touched (summary)

| File | LLM tiers | Notes tier |
|---|---|---|
| `lib/config.js` | tier table, `resolveTier`, `props` additions | `extractionState` literal |
| `lib/telegram.js` | `sendTierPrompt` (4 buttons) | — |
| `netlify/functions/telegram.js` | tier-key routing, `yes:`→`haiku` alias, HELP | `notes:` branch, guard |
| `lib/promote.js` | `{ tier }` → model + thinking, `Extracted By`, clear claim | — |
| `lib/extract.js` | `{ model, thinking }` params | — |
| `lib/llm.js` | forward `thinking` | — |
| `lib/llm/anthropic.js` | per-request thinking wins over global | — |
| `lib/llm/openrouter.js` | *(no change — verify only)* | — |
| `lib/notion.js` | `flattenMeeting` + `patchMeeting` new fields, sentinel clear | `findPendingNotes`, `findStaleNotesStubs`, `findSweepablePages` exclusion |
| `lib/fireflies.js` | — | `getSummary(id)` |
| `lib/render.js` | — | `renderNotesBlocks`, `parseFirefliesActionItems` |
| `lib/notes.js` | — | new — `claimNotes`, `completeNotes` |
| `netlify/functions/fireflies.js` | — | event branch |
| `netlify/functions/promote-background.js` | — | `mode` routing |
| `netlify/functions/sweep.js` | default tier now Haiku (via `promoteMeeting`) | 24h backstop pass, cadence |
| `scripts/verify.js` | tier table print, property asserts | option assert |
| `scripts/test-flow.js` | tier assertions | Notes-path + sweep-guard tests |
| `.env.example` | `LLM_MODEL_HAIKU` / `LLM_MODEL_SONNET` | — |
| `README.md` | keyboard, sweep-uses-Haiku | `meeting.summarized`, cadence |
| `netlify.toml` | — | sweep cadence comment |

---
---

# Part II — Settled implementation plan

Part I above is the review draft. This part records the decisions taken, two
findings from the **live Fireflies account** that change §5.6, and the
**minutes-remaining report** that was not in the draft at all. Where Part II
disagrees with Part I, Part II wins.

---

## A. The six open decisions (§11), resolved

| # | Decision | Rationale |
|---|---|---|
| 1 | Select option literal is **`Pending Notes`**, overridable with `NOTES_STATE_LABEL` | Not a correctness cliff either way — the same literal is written and queried, so a stray `Pending Instant` option in Notion is only cosmetic. `verify.js` now prints the literal in use and flags a stray `Pending Instant` so it can be deleted. |
| 2 | `Extracted By` for the Notes tier is **`fireflies-notes`** | Reads as a source, not a model id, which is what it is. |
| 3 | Keyboard is the **2×2 grid** | `Haiku`/`Sonnet` on top, `Notes`/`Skip` below. Four buttons in one row are too narrow on mobile. |
| 4 | Unattended sweeps **move to Haiku** — confirmed | Cheaper, and the sweep is exactly the case where nobody chose. Called out in the README. |
| 5 | **Per-tier provider stays out of scope** | `chat()` keeps reading the global `config.llm.provider`. §6's protections are implemented as written. |
| 6 | `LLM_EXTRACT_MODEL` **stays a both-tiers hard override** | It is the existing escape hatch and `scripts/test-llm.js` depends on it. |

**One decision reversed from Part I §7.** A page already claimed
`Pending Notes` *is* eligible for an explicit `Haiku`/`Sonnet` tap, which takes
the page over and clears the claim in the same write that sets `Processing`. Part I
would have refused it. The reversal is deliberate:

- The likeliest rollout failure is `meeting.summarized` never arriving (not
  subscribed yet, or not offered on the plan). Under Part I's rule the page is
  then stuck for a full 24 hours with no way out. That is the wrong answer to
  the most probable problem.
- Nothing is lost. Clearing the claim as the LLM tier starts means a
  `meeting.summarized` that lands mid-run finds no claim and no-ops — see the
  `complete-notes` guard in §C.
- A second **`Notes`** tap on a claimed page is still refused, with no Fireflies
  query. That was the actual point of the guard: not spending quota re-asking
  for a summary we already know is not ready.

**One rule added.** *Any terminal write on a Notes page clears
`Extraction State` — `Failed` as well as `Done`.* Without it, a stub that the
24-hour backstop gives up on stays claimed forever, and `findSweepablePages`
(which now excludes claimed pages) would never show it to `/sweep` again. The
page would be invisible to every recovery path in the system.

---

## B. Live Fireflies findings — §5.6 is rewritten around them

Part I §5.6 designs the Notes tier around `summary { overview action_items }`.
Both assumptions were checked against the live account on 2026-09-09 by reading
three real meetings. Findings:

**1. `overview` is not prose.** On this account it comes back as a bold-bullet
list, not the paragraph Part I assumed:

```
- **UAT เริ่มด้วย 3 user ทีมพี่ชู ใช้ลิงก์ TrueConnect เดิม เก็บ feedback**
- **AI ตอบคำถามตาม policy พร้อมสาเหตุและ citation ...**
```

`short_summary` is the field that holds real prose, and it is what an LLM page's
`Summary` section looks like. **The Summary section reads `short_summary`
first**, falling back to `overview` then `gist`.

**2. There is a far better field than either.** The summary object also carries a
full structured recap — `## headings` with nested, timestamped bullets:

```
## ปัญหาเนื้อหาและ UI

- คำตอบ AI บางครั้งข้อมูลเยอะและอ่านยาก (14:09)
    - ควรทำ infographic สรุปข้อมูลให้กระชับ (34:32)
```

That is the same shape as the LLM tier's `topics[] -> notes[]`, which means the
Notes tier can produce a page **structurally identical** to an LLM page —
`Summary`, `Action items`, then one `heading_2` per topic — rather than the
two-section stub Part I described. This is what "Instant copies Fireflies' notes"
should have meant all along, and it is what gets built.

**3. `action_items` is confirmed exactly as Part I described it** — a single
string, owner headers in `**bold**`, tasks below with trailing hard-break
spaces and a `(mm:ss)` or `(hh:mm:ss)` timestamp:

```
**Thanachai Chuklin**  
ประสานทีมจัดการประชุมแก้ไข feedback (04:14)  
ติดตามแก้ไข logic AI (24:58)  

**tanawoot**  
แจก user ทีม Call Center เล่น UAT (05:47)  
```

Timestamps are **kept** in the bullet text — they are the only way back to the
moment in the recording. Rendering reuses `actionLine()` so a Notes action bullet
and an LLM action bullet cannot drift apart in format.

**4. Field names are read defensively.** The live shapes were read through the
Fireflies MCP server, which relabels fields; the GraphQL spelling of the
structured-recap field is `notes` on some schema versions and `outline` on
others, and guessing wrong 400s the *entire query* and kills the tier on the
first real meeting. So `getSummary` asks for a superset, and on a
`Cannot query field "x" on type "Summary"` validation error it drops the named
field and retries — at most three attempts, with the working field list cached in
module scope so the cost is paid once per cold start, never per meeting. A
missing structured-recap field degrades the page to Summary + Action items; it
does not fail it.

Everything else in §5.6 stands: no `sentences` in the query, `title`/`date` ride
along for free, the parser degrades and never throws, and the page keeps the
meeting's own language.

---

## C. Eligibility, restated as one table

`eligibility(meeting, { allowFailed, intent })` is the single definition of
"already handled" for every tier. Three intents:

| Page state | `intent: "extract"` (Haiku/Sonnet) | `intent: "notes"` | `intent: "complete-notes"` |
|---|---|---|---|
| `Done` | refuse — already has a recap | refuse | refuse |
| `Skipped` | refuse | refuse | refuse |
| `Failed` | only with `allowFailed` | only with `allowFailed` | refuse |
| claimed `Pending Notes` | **allow** — takes over, clears the claim | refuse, no Fireflies query | **allow** — this is the one intent that wants it |
| `Processing`, fresh | refuse | refuse | refuse (not claimed) |
| `Processing`, stale >30 min | allow | allow | refuse (not claimed) |
| `Pending` / no status | allow | allow | refuse — nothing claimed it |

`complete-notes` refusing an unclaimed page is what makes a late or redelivered
`meeting.summarized` safe: if an LLM tier took the page over, or the backstop
already gave up, the claim is gone and the completion no-ops instead of
overwriting a finished recap.

---

## D. New feature — minutes remaining after every transcription

Not in Part I. The requirement: after a meeting is transcribed, say how many of
the 400 minutes are left.

**Where it goes.** One line appended to the `meeting.transcribed` Telegram
prompt — the four-button message. That is "after transcription is done" in the
literal sense, it fires exactly once per meeting whichever tier is later chosen
(or if none is), and it is the moment the number is actually actionable: you are
already looking at the message deciding what to do with the meeting.

It is deliberately *not* also attached to the recap-complete message. Recapping
consumes Anthropic tokens and Notion writes — it consumes no Fireflies minutes,
so the number cannot have changed since the prompt, and reporting it twice would
double this feature's share of the 50-requests-per-day Fireflies quota for no new
information.

**Shape.** `Storage: 236 of 400 minutes left.`, plus the same
past-the-threshold warning `/space` gives, so the warning cannot appear in one
command and not the other.

**Cost.** One Fireflies request per transcribed meeting. Per meeting the pipeline
now spends: 1 usage query + 1 transcript fetch (LLM tiers) or 1 summary fetch
(Notes tier).

**It must never cost the webhook its 200.** `/fireflies` is synchronous against a
10-second Fireflies acknowledgement budget, and `graphql()` currently has **no
timeout at all** — a hung Fireflies request would hang the webhook until the
platform killed it, and Fireflies would treat the delivery as failed and retry.
So:

- `graphql()` gains an optional `timeoutMs` (`AbortController`, the same pattern
  `lib/llm/anthropic.js` already uses).
- The usage probe runs with a **4-second** timeout and is wrapped so that *any*
  failure — timeout, rate limit, malformed response — returns `null` and the
  prompt goes out without the line. A storage read is never worth a failed
  webhook delivery.
- Ordering is unchanged and matters: signature → parse → dedupe → create page →
  usage probe → prompt. The page exists before the probe runs, so even a probe
  that somehow takes the whole budget cannot cost you the page.

**Shared formatting.** `/space` and the prompt line both come from `lib/usage.js`,
so the allowance, the threshold and the wording are defined once.

---

## E. Files touched — delta from Part I §12

Part I §12 stands. Added by Part II:

| File | Why |
|---|---|
| `lib/usage.js` | **new** — `usageReport()` (the `/space` body) and `usageLine()` (the never-throwing one-liner for the prompt) |
| `lib/fireflies.js` | `timeoutMs` on `graphql()`; `getSummary()` with the field-downgrade retry |
| `netlify/functions/fireflies.js` | the usage line on the prompt, in addition to Part I's event branching |
| `netlify/functions/telegram.js` | `/space` now renders from `lib/usage.js` |

---

## F. Verification matrix

Everything below is an automated assertion in `npm test`, except the four marked
*manual*. Part I §10's list is included; the rest are gaps found while planning.

**Model selection**

1. `haiku:` sends `model: claude-haiku-4-5-20251001` and **no `thinking` key** in the Anthropic request body.
2. `sonnet:` sends `model: claude-sonnet-5` and `thinking: { type: "adaptive" }`.
3. `yes:` (legacy prompts still in scrollback) behaves exactly as `haiku:`.
4. `LLM_EXTRACT_MODEL` collapses both LLM tiers onto that one model.
5. `Extracted By` records the resolved model id.
6. The sweep and the scheduled job run Haiku with no `thinking`.
7. The 2×2 keyboard carries all four callback keys, and the longest (`sonnet:` + a 26-char id) is inside Telegram's 64-byte cap.

**Notes tier**

8. `notes:` with a summary present → `Done` in one pass, **zero** Anthropic calls, exactly one Fireflies fetch.
9. The page renders `Summary`, `Action items` and one heading per topic — the same skeleton as an LLM page.
10. Action bullets keep their `(mm:ss)` timestamp and carry the owner from the `**bold**` header.
11. Nested `    - ` items render as child bullets, not as lost text.
12. `notes:` with no summary yet → claimed `Pending Notes`, still `Processing`, no body written.
13. A second `notes:` tap on a claimed page → refused with **zero** Fireflies requests.
14. `notes:` on a `Done` page → refused with **zero** Fireflies requests.
15. A `sonnet:` tap on a claimed page takes it over and clears the claim.
16. The parser survives empty, malformed and missing fields without throwing.
17. `getSummary` drops a field Fireflies rejects and retries rather than failing the tier.

**Webhooks**

18. `meeting.transcribed` still does exactly what it did — page, prompt, dedupe on redelivery.
19. A bad signature on `meeting.summarized` → 401, and **no** Notion query runs (the signature check stays first).
20. `meeting.summarized` completes a claimed page and sends a **new** message, not an edit.
21. `meeting.summarized` with no claimed page → 200, zero Fireflies requests, zero `/promote` calls. (This fires for *every* meeting once subscribed, so the no-op path is the common one.)
22. `meeting.summarized` delivered twice → completes once.
23. `meeting.summarized` with no `meeting_id` → 200, no work.
24. An unknown event → 200, no work.
25. `/promote` with `mode: "notes"` routes to `completeNotes` and makes zero LLM calls; the wrong internal secret still does nothing.

**Sweep**

26. `findSweepablePages` does **not** return a `Pending Notes` page — the P1 regression guard.
27. It still returns a page whose `Extraction State` is empty (the `is_empty` arm — the failure this test exists to catch is the sweep silently matching *nothing*).
28. A stub claimed more than 24 hours ago is picked up by the backstop; a fresh one is not.
29. The backstop marks a still-summary-less stub `Failed`, **clears the claim**, and alerts — after which `/sweep` can see it again.

**Minutes**

30. The prompt carries `Storage: N of 400 minutes left.`
31. Exactly one usage request per transcribed webhook.
32. A usage query that fails still returns 200, still creates the page, still sends the prompt — just without the line.
33. A usage query that hangs is aborted and does not stall the webhook.
34. Past the threshold, the prompt warns in the same words `/space` uses.
35. `/space` keeps its existing guarantees: one Fireflies request, zero Notion, zero model.

**Schema — `npm run verify`**

36. `Extraction State` exists and is a Select; `Extracted By` exists and is `rich_text` (**not** a Select).
37. The `Pending Notes` option is reported, and a stray `Pending Instant` is flagged.
38. The resolved tier table is printed — model id and thinking mode per tier — so a bad `LLM_MODEL_*` is visible before deploy, not after.

**Manual, at deploy time**

39. *manual* — Fireflies dashboard offers `meeting.summarized` and it is added to the **existing** subscription, same URL and secret.
40. *manual* — `npm run sign -- <id> meeting.summarized` against the deployed site completes a claimed page.
41. *manual* — the same request with one character of the signature changed comes back 401.
42. *manual* — a real meeting end to end: prompt renders four buttons and the minutes line.

---

## G. What the build actually found

Recorded after implementing, because two of these were caught by running rather
than by planning, and both would have reached production.

**1. Notion allows only two levels of `and`/`or` nesting.** §5.6 specified the
sweep exclusion as an `and` wrapping the existing status `or` and a new
not-claimed `or`. That is three levels, and Notion answers it with a 400 listing
every filter type it expected instead. The offline mock evaluated the nesting
happily, so the whole suite passed; only `npm run verify` against the live
database caught it — the check added in §F.27 doing exactly the job it was added
for. The claim exclusion now happens in JS after the query, which is both legal
and exact whatever options the Select ends up carrying. `assertFilterDepth()` in
the mock now enforces Notion's limit so this class of bug stays offline.

**2. The live database's `Status` is a Notion Status property, not a Select** —
and the entire flow suite only ever exercised the Select shape, whose write and
filter shapes differ. `npm run test:flow` now runs the whole suite twice, once
as each. Flipping `statusFilter` to always emit `select:` fails five tests in the
status run and none in the select run, so the second pass is carrying real
weight.

**3. `config.llm.extractModel()` cannot be used to resolve a tier.** It falls
back to `config.llm.model`, so resolving a tier through it would silently run
every recap on the *chat* model whenever `LLM_EXTRACT_MODEL` was unset. The
override is read straight from the environment instead, and a test pins it.

**4. Skipping is terminal and must release a Notes claim.** §A adds the rule for
`Done` and `Failed` but missed `Skipped`. A page skipped while claimed would be
returned by `findStaleNotesStubs` on every sweep forever, each one spending a
`/promote` invocation to rediscover that it is skipped.

**5. `overview` is not the field to build the Summary section from**, and there
is a much better field for the topic sections than Part I knew about — see §B.
The Notes page that resulted is a full structured recap rather than the
two-section stub the draft described.

**Left as it was found:** the `Extraction State` Select on the live database
carries a `Pending Instant` option and no `Pending Notes`. Harmless — the same
literal is written and queried, and Notion creates the option on the first Notes
tap — so it is a one-line choice rather than a migration: delete the stray option
in Notion, or set `NOTES_STATE_LABEL=Pending Instant`. `npm run verify` reports
both facts on every run.
