// ---------------------------------------------------------------------------
// End-to-end flow test with every outbound HTTP call mocked. No network, no
// credentials, no cost. Exercises the paths that are otherwise only testable
// against a real meeting:
//
//   webhook -> stub page + prompt -> Yes tap -> transcript -> extraction ->
//   recap written -> status Done, and the idempotency guards around all of it.
//
//   npm run test:flow
// ---------------------------------------------------------------------------

process.env.FIREFLIES_WEBHOOK_SECRET = "flow-test-fireflies-secret";
process.env.FIREFLIES_API_KEY = "flow-test-fireflies-key";
process.env.TELEGRAM_WEBHOOK_SECRET = "flow-test-telegram-secret";
process.env.TELEGRAM_BOT_TOKEN = "flow-test-bot-token";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.NOTION_API_KEY = "flow-test-notion-key";
process.env.NOTION_MEETINGS_DB_ID = "db-1";
process.env.ANTHROPIC_API_KEY = "flow-test-anthropic-key";
process.env.INTERNAL_SECRET = "flow-test-internal-secret";
process.env.TIMEZONE = "Asia/Bangkok";
process.env.UTC_OFFSET = "+07:00";

const crypto = await import("node:crypto");

let failures = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  PASS  ${name}`))
    .catch((err) => {
      console.log(`  FAIL  ${name} — ${err.message}`);
      failures++;
    });
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ---------------------------------------------------------------------------
// In-memory fakes for Notion, Fireflies, Telegram and the model API.
// ---------------------------------------------------------------------------

const store = {
  pages: new Map(), // id -> { id, properties, last_edited_time, url }
  children: new Map(), // pageId -> [block]
  nextId: 1,
  telegram: [], // { method, body }
  llmCalls: 0,
  chatRequests: [], // request bodies the chat loop sent
  chatScript: [], // canned responses for the chat loop, consumed in order
  notionRequests: 0, // every outbound Notion call, for the cost assertions
  usageFetches: 0, // how many times /space hit the Fireflies user query
  minutesConsumed: 163.76, // the storage meter /space reports on
  promoteCalls: [], // bodies POSTed to the /promote background function
  transcriptFetches: 0,
  transcriptExists: true,
  lastJoin: null, // variables sent on the last addToLiveMeeting call
  summaryFetches: 0, // Notes-tier summary queries
  summaryFields: null, // the field list the last summary query asked for
  summary: null, // what Fireflies' summary query returns; null = not ready yet
  rejectSummaryFields: [], // fields the fake schema does not have
  usageFails: null, // set to an Error to make the usage query fail
  usageHangs: false, // never resolves, to prove the timeout works
  extractRequests: [], // Anthropic request bodies for extract_meeting
  titleFetches: 0, // title-only queries for the chat hand-off prompt
  titleFails: null, // set to an Error to make the title query fail
  meetingTitle: "UAT for CC AI", // what the title query returns
};

// "Status" is legitimately either a Select or Notion's dedicated Status type
// depending on how the database was built by hand, and the two have different
// write AND filter shapes. The live database this project runs against is the
// Status kind, so the whole suite runs twice — once as each — rather than
// covering only the shape the mock happened to be written with.
const STATUS_TYPE = process.env.FLOW_STATUS_TYPE === "status" ? "status" : "select";
const STATUS_OPTIONS = [{ name: "Pending" }, { name: "Processing" }, { name: "Done" }, { name: "Skipped" }, { name: "Failed" }];

const SCHEMA = {
  Name: { type: "title" },
  Date: { type: "date" },
  "Source Meeting ID": { type: "rich_text" },
  Status: { type: STATUS_TYPE, [STATUS_TYPE]: { options: STATUS_OPTIONS } },
  "Extraction State": { type: "select", select: { options: [{ name: "Pending Notes" }] } },
  "Extracted By": { type: "rich_text" },
};

const readStatus = (page) => page.properties.Status?.select?.name ?? page.properties.Status?.status?.name ?? null;
const readName = (page) => page.properties.Name?.title?.[0]?.plain_text ?? "";
const readState = (page) => page.properties["Extraction State"]?.select?.name || null;
const readExtractedBy = (page) =>
  (page.properties["Extracted By"]?.rich_text || []).map((r) => r.plain_text ?? r.text?.content).join("") || null;
const readSourceId = (page) => (page.properties["Source Meeting ID"]?.rich_text || []).map((r) => r.plain_text ?? r.text?.content).join("");
const readTitle = (page) => (page.properties.Name?.title || []).map((r) => r.plain_text ?? r.text?.content).join("");

/** Normalises written properties into the shape the Notion API reads back. */
function normalizeProps(props) {
  const out = {};
  for (const [key, value] of Object.entries(props)) {
    if (value.title) out[key] = { title: value.title.map((t) => ({ plain_text: t.text.content })) };
    else if (value.rich_text) out[key] = { rich_text: value.rich_text.map((t) => ({ plain_text: t.text.content })) };
    else out[key] = value;
  }
  return out;
}

function matchesFilter(page, filter) {
  if (!filter) return true;
  if (filter.and) return filter.and.every((f) => matchesFilter(page, f));
  if (filter.or) return filter.or.some((f) => matchesFilter(page, f));
  if (filter.timestamp === "last_edited_time") {
    return new Date(page.last_edited_time) < new Date(filter.last_edited_time.before);
  }
  if (filter.property === "Source Meeting ID") return readSourceId(page) === filter.rich_text.equals;
  if (filter.property === "Status") {
    // A Status property filters with `status:`, a Select with `select:`. Reading
    // whichever arrived is what proves statusFilter() picked the right one.
    const clause = filter.status || filter.select;
    if (!clause) throw new Error(`mock: Status filter has neither status nor select: ${JSON.stringify(filter)}`);
    if (STATUS_TYPE === "status" && !filter.status) throw new Error("mock: a Status property must be filtered with `status:`");
    if (STATUS_TYPE === "select" && !filter.select) throw new Error("mock: a Select property must be filtered with `select:`");
    return readStatus(page) === clause.equals;
  }
  if (filter.property === "Extraction State") {
    const value = readState(page);
    const f = filter.select;
    if ("equals" in f) return value === f.equals;
    // Notion's does_not_equal on a Select does NOT match a row whose Select is
    // empty. Modelling that faithfully is the whole point of this branch: get
    // it wrong here and the sweep-exclusion test passes against a mock that is
    // more forgiving than the real API, which is worse than having no test.
    if ("does_not_equal" in f) return value !== null && value !== f.does_not_equal;
    if ("is_empty" in f) return f.is_empty === (value === null);
    if ("is_not_empty" in f) return f.is_not_empty === (value !== null);
    throw new Error(`mock: unhandled Extraction State filter ${JSON.stringify(f)}`);
  }
  if (filter.property === "Name") return readTitle(page).toLowerCase().includes(String(filter.title.contains).toLowerCase());
  if (filter.property === "Date") return true;
  throw new Error(`mock: unhandled filter ${JSON.stringify(filter)}`);
}

/**
 * Notion allows at most TWO levels of and/or nesting and answers a third with a
 * 400. The mock happily evaluated three, so a filter that could never work in
 * production passed every offline test and was only caught by `npm run verify`
 * against the live database. Asserting the limit here keeps that class of bug
 * offline where it belongs.
 */
function assertFilterDepth(filter, depth = 0) {
  if (!filter || typeof filter !== "object") return;
  const compound = filter.and || filter.or;
  if (!compound) return;
  if (depth >= 2) {
    throw new Error(`mock: filter nests and/or ${depth + 1} levels deep; Notion allows 2 and 400s on more`);
  }
  for (const child of compound) assertFilterDepth(child, depth + 1);
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};

  // The sweep fans out over HTTP to its own /promote background function.
  // Route that to the real handler so the whole chain is under test.
  if (u.endsWith("/promote")) {
    store.promoteCalls.push(body);
    return promoteFn(new Request(u, { method, headers: options.headers, body: options.body }));
  }

  // ----- Notion ------------------------------------------------------------
  if (u.startsWith("https://api.notion.com/v1")) {
    store.notionRequests++;
    const path = u.slice("https://api.notion.com/v1".length).split("?")[0];

    if (method === "GET" && path === "/databases/db-1") return json({ data_sources: [{ id: "ds-1", name: "Meetings" }] });
    if (method === "GET" && path === "/data_sources/ds-1") return json({ properties: SCHEMA });

    if (method === "POST" && path === "/data_sources/ds-1/query") {
      assertFilterDepth(body.filter);
      const results = [...store.pages.values()].filter((p) => matchesFilter(p, body.filter));
      return json({ results: results.slice(0, body.page_size || 25), has_more: false, next_cursor: null });
    }

    if (method === "POST" && path === "/pages") {
      const id = `page-${store.nextId++}`;
      const page = {
        id,
        properties: normalizeProps(body.properties),
        last_edited_time: new Date().toISOString(),
        url: `https://notion.so/${id}`,
      };
      store.pages.set(id, page);
      store.children.set(
        id,
        (body.children || []).map((c, i) => {
          const stored = JSON.parse(JSON.stringify(c));
          for (const rt of stored[stored.type]?.rich_text || []) rt.plain_text = rt.text.content;
          return { id: `${id}-b${i}`, ...stored };
        })
      );
      return json(page);
    }

    const pageMatch = path.match(/^\/pages\/(.+)$/);
    if (pageMatch) {
      const page = store.pages.get(pageMatch[1]);
      if (!page) return json({ message: "Not found", code: "object_not_found" }, 404);
      if (method === "GET") return json(page);
      if (method === "PATCH") {
        Object.assign(page.properties, normalizeProps(body.properties));
        page.last_edited_time = new Date().toISOString();
        return json(page);
      }
    }

    const childrenMatch = path.match(/^\/blocks\/(.+)\/children$/);
    if (childrenMatch) {
      const pageId = childrenMatch[1];
      const existing = store.children.get(pageId) || [];
      if (method === "GET") return json({ results: existing, has_more: false, next_cursor: null });
      if (method === "PATCH") {
        assert(body.children.length <= 100, `mock: append of ${body.children.length} blocks exceeds Notion's limit of 100`);
        for (const block of body.children) {
          const inner = block[block.type];
          for (const rt of inner?.rich_text || []) {
            assert(rt.text.content.length <= 2000, `mock: rich-text piece of ${rt.text.content.length} exceeds 2000`);
          }
          // Notion returns plain_text alongside text.content on read; mirror
          // that so the mock cannot pass code that only handles the write shape.
          const stored = JSON.parse(JSON.stringify(block));
          for (const rt of stored[stored.type]?.rich_text || []) rt.plain_text = rt.text.content;
          const id = `${pageId}-b${existing.length}`;
          // Notion stores nested blocks as children of the BLOCK, reachable
          // only through a second request, and reports has_children on the
          // parent. Model that or a nesting bug would pass unnoticed.
          const nested = stored[stored.type]?.children || [];
          if (nested.length) {
            delete stored[stored.type].children;
            store.children.set(
              id,
              nested.map((c, i) => {
                const child = JSON.parse(JSON.stringify(c));
                for (const rt of child[child.type]?.rich_text || []) rt.plain_text = rt.text.content;
                return { id: `${id}-c${i}`, ...child };
              })
            );
          }
          existing.push({ id, has_children: nested.length > 0, ...stored });
        }
        store.children.set(pageId, existing);
        return json({ results: body.children });
      }
    }

    const blockMatch = path.match(/^\/blocks\/([^/]+)$/);
    if (blockMatch && method === "DELETE") {
      for (const [pageId, blocks] of store.children) {
        const idx = blocks.findIndex((b) => b.id === blockMatch[1]);
        if (idx >= 0) {
          blocks.splice(idx, 1);
          store.children.set(pageId, blocks);
          return json({ id: blockMatch[1], archived: true });
        }
      }
      return json({ message: "Not found", code: "object_not_found" }, 404);
    }

    throw new Error(`mock: unhandled Notion call ${method} ${path}`);
  }

  // ----- Fireflies ---------------------------------------------------------
  if (u === "https://api.fireflies.ai/graphql") {
    if (body.query.includes("addToLiveMeeting")) {
      store.lastJoin = body.variables;
      return json({ data: { addToLiveMeeting: { success: true, message: "joining" } } });
    }
    if (body.query.includes("minutes_consumed")) {
      store.usageFetches++;
      if (store.usageHangs) {
        // Never resolves on its own — only the AbortController can end this.
        return new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      if (store.usageFails) throw store.usageFails;
      return json({ data: { user: { minutes_consumed: store.minutesConsumed, num_transcripts: 7 } } });
    }
    if (body.query.includes("query Title(")) {
      store.titleFetches++;
      if (store.titleFails) throw store.titleFails;
      return json({ data: { transcript: { title: store.meetingTitle } } });
    }
    if (body.query.includes("summary {")) {
      store.summaryFetches++;
      const asked = body.query.match(/summary \{([^}]*)\}/)[1].trim().split(/\s+/);
      store.summaryFields = asked;
      const rejected = asked.filter((f) => store.rejectSummaryFields.includes(f));
      if (rejected.length) {
        return json({
          errors: rejected.map((f) => ({ message: `Cannot query field "${f}" on type "Summary".` })),
        });
      }
      const summary = store.summary
        ? Object.fromEntries(asked.filter((f) => f in store.summary).map((f) => [f, store.summary[f]]))
        : null;
      return json({
        data: {
          transcript: {
            id: body.variables.id,
            title: "UAT for CC AI",
            date: Date.parse("2026-09-01T07:15:00Z"),
            summary,
          },
        },
      });
    }
    if (body.query.includes("transcript(")) {
      store.transcriptFetches++;
      if (!store.transcriptExists) {
        return json({ errors: [{ message: "Transcript not found", code: "object_not_found" }] }, 200);
      }
      return json({
        data: {
          transcript: {
            id: body.variables.id,
            title: "UAT for CC AI",
            date: Date.parse("2026-09-01T07:15:00Z"),
            duration: 81.88,
            organizer_email: "nik@example.com",
            participants: ["nik@example.com"],
            sentences: [
              { speaker_name: "Nik", text: "We do not have any policies yet.", start_time: 12 },
              { speaker_name: "Joao", text: "I will send the policy draft on Friday.", start_time: 45 },
            ],
          },
        },
      });
    }
    throw new Error(`mock: unhandled Fireflies query ${body.query.slice(0, 60)}`);
  }

  // ----- Telegram ----------------------------------------------------------
  if (u.startsWith("https://api.telegram.org")) {
    const method_ = u.split("/").pop();
    store.telegram.push({ method: method_, body });
    return json({ ok: true, result: { message_id: 999, chat: { id: 12345 } } });
  }

  // ----- Model API ---------------------------------------------------------
  if (u === "https://api.anthropic.com/v1/messages") {
    // The chat loop sends the three conversational tools; extraction sends one.
    if (body.tools?.[0]?.name !== "extract_meeting") {
      store.chatRequests.push(body);
      const scripted = store.chatScript.shift();
      if (!scripted) throw new Error("mock: chat loop made more calls than the test scripted");
      return json({ id: "msg_c", model: body.model, usage: { input_tokens: 10, output_tokens: 5 }, ...scripted });
    }

    store.llmCalls++;
    store.extractRequests.push(body);
    equal(body.tool_choice?.type, "tool", "mock: extraction must force the tool call");
    return json({
      id: "msg_1",
      model: body.model,
      stop_reason: "tool_use",
      usage: { input_tokens: 1200, output_tokens: 300 },
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        {
          type: "tool_use",
          id: "tu_1",
          name: "extract_meeting",
          input: {
            summary: "The team reviewed policy coverage.",
            topics: [
              {
                title: "Policies",
                notes: [
                  { content: "Nik noted there are no policies in place yet.", speaker: "Nik", is_action_item: false, action_owner: "TBA", action_due: null },
                  { content: "Joao committed to sending the policy draft.", speaker: "Joao", is_action_item: true, action_owner: "Joao", action_due: "Friday" },
                ],
              },
            ],
          },
        },
      ],
    });
  }

  throw new Error(`mock: unexpected call to ${u}`);
};

// ---------------------------------------------------------------------------
// The modules must be imported AFTER the env and fetch stubs are in place.
// ---------------------------------------------------------------------------
const firefliesFn = (await import("../netlify/functions/fireflies.js")).default;
const telegramFn = (await import("../netlify/functions/telegram.js")).default;
const sweepFn = (await import("../netlify/functions/sweep.js")).default;
const promoteFn = (await import("../netlify/functions/promote-background.js")).default;

const MEETING_ID = "01M1B6FRBBDKPF9CWT06KPWH8S";

function firefliesRequest(payload) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${crypto.createHmac("sha256", process.env.FIREFLIES_WEBHOOK_SECRET).update(raw, "utf8").digest("hex")}`;
  return new Request("https://site.test/fireflies", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature": sig },
    body: raw,
  });
}

function telegramRequest(update, secret = process.env.TELEGRAM_WEBHOOK_SECRET) {
  return new Request("https://site.test/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  });
}

const transcribedPayload = {
  event: "meeting.transcribed",
  timestamp: Date.parse("2026-09-01T07:15:00Z"),
  meeting_id: MEETING_ID,
  client_reference_id: null,
};

const lastTelegram = (method) => [...store.telegram].reverse().find((t) => t.method === method);

console.log("\nFireflies webhook");

await test("rejects an unsigned request with 401", async () => {
  const res = await firefliesFn(
    new Request("https://site.test/fireflies", { method: "POST", body: JSON.stringify(transcribedPayload) })
  );
  equal(res.status, 401, "status");
  equal(store.pages.size, 0, "no page should have been created");
});

await test("creates a stub page and sends the chat + tier prompt", async () => {
  const res = await firefliesFn(firefliesRequest(transcribedPayload));
  equal(res.status, 200, "status");
  equal(store.pages.size, 1, "page count");

  const page = [...store.pages.values()][0];
  equal(readStatus(page), "Pending", "status property");
  equal(readSourceId(page), MEETING_ID, "source meeting id");
  equal(readTitle(page), "Meeting — Sep 1, 14:15", "timestamp label in local time");
  equal(page.properties.Date.date.start, "2026-09-01T14:15:00+07:00", "date");
  equal(store.children.get(page.id).length, 1, "stub body block count");

  const prompt = lastTelegram("sendMessage");
  assert(prompt.body.reply_markup, "prompt has no inline keyboard");
  const rows = prompt.body.reply_markup.inline_keyboard;
  equal(rows.length, 3, "chat row, callback row, copy row");

  // Row 1: URL buttons straight into the apps, prompt prefilled.
  equal(rows[0].map((b) => b.text).join(","), "Claude,ChatGPT", "chat row");
  const want = `Recap my Fireflies meeting "UAT for CC AI" (Fireflies transcript ID: ${MEETING_ID}) into my Notion Meetings database.`;
  equal(rows[0][0].url, `https://claude.ai/new?q=${encodeURIComponent(want)}`, "Claude URL");
  equal(rows[0][1].url, `https://chatgpt.com/?q=${encodeURIComponent(want)}`, "ChatGPT URL");
  for (const b of rows[0]) {
    // Telegram only accepts http(s) and tg:// on a URL button — a claude:// or
    // chatgpt:// scheme would reject the whole message.
    assert(/^https:\/\//.test(b.url), `URL button must be https: ${b.url}`);
    assert(!b.callback_data, "a URL button cannot also carry callback_data");
  }

  // Row 2: only the OFFERED tiers — Sonnet and Notes are retired from the keyboard.
  const keys = rows[1].map((b) => b.callback_data.split(":")[0]);
  equal(keys.join(","), "haiku,no", "callback row");
  for (const b of rows[1]) {
    assert(Buffer.byteLength(b.callback_data) <= 64, `callback_data "${b.callback_data}" exceeds Telegram's 64 bytes`);
  }

  // Row 3: the same prompt, copyable, for when an app opens without it.
  equal(rows[2][0].copy_text?.text, want, "copy button carries the same prompt");
  assert(want.length <= 256, "copy_text is capped at 256 characters");

  assert(/^Transcript ready: UAT for CC AI\n/.test(prompt.body.text), `title missing: ${prompt.body.text}`);
  equal(store.titleFetches, 1, "exactly one title query per transcribed webhook");

  // The storage meter rides along on the prompt — this is the "how many of my
  // 400 minutes are left" report, delivered once per transcribed meeting.
  assert(/Storage: 236 of 400 minutes left\./.test(prompt.body.text), `no storage line: ${prompt.body.text}`);
  equal(store.usageFetches, 1, "exactly one usage query per transcribed webhook");
});

await test("a redelivered webhook does not create a second page", async () => {
  const before = store.telegram.length;
  const usageBefore = store.usageFetches;
  const res = await firefliesFn(firefliesRequest(transcribedPayload));
  equal(res.status, 200, "status");
  equal(store.pages.size, 1, "page count");
  equal(store.telegram.length, before, "no second prompt should be sent");
  equal(store.usageFetches, usageBefore, "a duplicate must not spend another usage request");
});

await test("ignores an event it is not subscribed to", async () => {
  const res = await firefliesFn(firefliesRequest({ ...transcribedPayload, event: "meeting.bot_joined" }));
  equal(res.status, 200, "status");
  equal(store.pages.size, 1, "page count");
});

console.log("\nTelegram: Yes tap");

const pageId = () => [...store.pages.keys()][0];

await test("ignores an update from another chat", async () => {
  const before = store.llmCalls;
  await telegramFn(telegramRequest({ message: { chat: { id: 999 }, text: "hello" } }));
  equal(store.llmCalls, before, "no model call should have been made");
});

await test("ignores an update with a bad secret token", async () => {
  const before = store.llmCalls;
  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "hello" } }, "wrong-secret"));
  equal(store.llmCalls, before, "no model call should have been made");
});

await test("the legacy yes: callback still works and runs the default tier", async () => {
  await telegramFn(
    telegramRequest({
      callback_query: {
        id: "cb1",
        from: { id: 12345 },
        data: `yes:${MEETING_ID}`,
        message: { message_id: 999, chat: { id: 12345 } },
      },
    })
  );

  const page = store.pages.get(pageId());
  equal(readStatus(page), "Done", "status");
  equal(readTitle(page), "UAT for CC AI", "title replaced with the real one");
  equal(page.properties.Date.date.start, "2026-09-01T14:15:00+07:00", "date from the transcript");
  equal(store.transcriptFetches, 1, "transcript fetch count");
  equal(store.llmCalls, 1, "model call count");

  // A prompt still in Telegram scrollback from before the tiers shipped sends
  // "yes:". It must resolve to the default tier, not "Unrecognised action".
  const req = store.extractRequests.at(-1);
  equal(req.model, "claude-haiku-4-5-20251001", "legacy yes: must run the default tier");
  equal(readExtractedBy(page), "claude-haiku-4-5-20251001", "Extracted By");

  const blocks = store.children.get(page.id);
  const texts = blocks.map((b) => (b[b.type].rich_text || []).map((r) => r.text.content).join(""));
  assert(!texts.some((t) => t.includes("Awaiting recap decision")), "the stub paragraph should have been removed");
  assert(texts.includes("Summary"), "summary heading missing");
  assert(texts.includes("Action items"), "action rollup missing");
  assert(texts.includes("Joao committed to sending the policy draft. — Joao, due Friday"), "rollup line missing");
  assert(texts.includes("Joao committed to sending the policy draft."), "inline bullet missing");

  assert(store.telegram.some((t) => t.method === "answerCallbackQuery"), "callback query was never answered");
  const edit = lastTelegram("editMessageText");
  assert(edit && !edit.body.reply_markup, "the inline keyboard should have been removed");
});

await test("tapping the same button again does nothing", async () => {
  const before = { llm: store.llmCalls, blocks: store.children.get(pageId()).length };
  await telegramFn(
    telegramRequest({
      callback_query: {
        id: "cb2",
        from: { id: 12345 },
        data: `yes:${MEETING_ID}`,
        message: { message_id: 999, chat: { id: 12345 } },
      },
    })
  );
  equal(store.llmCalls, before.llm, "no second extraction");
  equal(store.children.get(pageId()).length, before.blocks, "the recap must not be duplicated");
  assert(
    store.telegram.some((t) => t.method === "sendMessage" && /already has a recap/.test(t.body.text || "")),
    "expected an 'already has a recap' reply"
  );
});

console.log("\nTelegram: No tap and the sweep");

await test("No marks the page Skipped and keeps it as a record", async () => {
  const second = { ...transcribedPayload, meeting_id: "SECONDMEETING", timestamp: Date.parse("2026-09-02T03:00:00Z") };
  await firefliesFn(firefliesRequest(second));
  const page = [...store.pages.values()].find((p) => readSourceId(p) === "SECONDMEETING");

  await telegramFn(
    telegramRequest({
      callback_query: { id: "cb3", from: { id: 12345 }, data: "no:SECONDMEETING", message: { message_id: 1000, chat: { id: 12345 } } },
    })
  );

  equal(readStatus(store.pages.get(page.id)), "Skipped", "status");
  const texts = store.children.get(page.id).map((b) => (b[b.type].rich_text || []).map((r) => r.text.content).join(""));
  equal(texts.length, 1, "body block count");
  assert(texts[0].includes("Skipped"), `body text: ${texts[0]}`);
  assert(store.pages.has(page.id), "the page must be kept, not deleted");
});

await test("the sweep lists meetings still pending and calls no model", async () => {
  const third = { ...transcribedPayload, meeting_id: "THIRDMEETING", timestamp: Date.parse("2026-09-03T03:00:00Z") };
  await firefliesFn(firefliesRequest(third));
  const target = [...store.pages.values()].find((p) => readSourceId(p) === "THIRDMEETING");

  process.env.URL = "https://site.test";
  store.promoteCalls = [];
  const llmBefore = store.llmCalls;
  const before = store.telegram.length;
  await sweepFn();

  equal(store.promoteCalls.length, 0, "the sweep must not trigger any recap");
  equal(store.llmCalls, llmBefore, "the sweep must not spend any API tokens");
  equal(readStatus(store.pages.get(target.id)), "Pending", "the page must be left alone");
  const texts = store.telegram.slice(before).filter((t) => t.method === "sendMessage").map((t) => t.body.text || "");
  assert(
    texts.some((t) => /not summarised/.test(t) && t.includes(readName(target))),
    `expected a list naming the pending meeting, got: ${texts.join(" | ")}`
  );
  // Leave the page terminal so later tests start clean.
  await telegramFn(
    telegramRequest({
      callback_query: { id: "cb3b", from: { id: 12345 }, data: "no:THIRDMEETING", message: { message_id: 1002, chat: { id: 12345 } } },
    })
  );
});

await test("/promote refuses a call with the wrong internal secret", async () => {
  const before = store.llmCalls;
  const res = await promoteFn(
    new Request("https://site.test/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": "wrong" },
      body: JSON.stringify({ page_id: pageId() }),
    })
  );
  equal(res.status, 202, "background functions always answer 202");
  equal(store.llmCalls, before, "no work should have been done");
});

console.log("\nFailure handling");

await test("a transcript deleted from Fireflies marks the page Failed and says so", async () => {
  const fourth = { ...transcribedPayload, meeting_id: "FOURTHMEETING", timestamp: Date.parse("2026-09-04T03:00:00Z") };
  await firefliesFn(firefliesRequest(fourth));

  store.transcriptExists = false;
  const before = store.telegram.length;
  await telegramFn(
    telegramRequest({
      callback_query: { id: "cb4", from: { id: 12345 }, data: "yes:FOURTHMEETING", message: { message_id: 1001, chat: { id: 12345 } } },
    })
  );
  store.transcriptExists = true;

  const page = [...store.pages.values()].find((p) => readSourceId(p) === "FOURTHMEETING");
  equal(readStatus(page), "Failed", "status");
  const alerts = store.telegram.slice(before).filter((t) => t.method === "sendMessage");
  assert(
    alerts.some((a) => /no longer in Fireflies/.test(a.body.text || "")),
    `expected a 'no longer in Fireflies' alert, got: ${alerts.map((a) => a.body.text).join(" | ")}`
  );
});

await test("the scheduled sweep reports a Failed page but does not retry it", async () => {
  store.promoteCalls = [];
  const before = store.telegram.length;
  await sweepFn();
  equal(store.promoteCalls.length, 0, "a Failed page must not be retried by the schedule");
  const texts = store.telegram.slice(before).filter((t) => t.method === "sendMessage").map((t) => t.body.text || "");
  assert(texts.some((t) => /failed earlier/.test(t)), `expected the failed page to be listed, got: ${texts.join(" | ")}`);
});

await test("/sweep lists unsummarised meetings, Failed included, and recaps nothing", async () => {
  const before = store.llmCalls;
  const msgs = store.telegram.length;
  store.promoteCalls = [];
  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "/sweep" } }));

  equal(store.promoteCalls.length, 0, "/sweep must not trigger a recap");
  equal(store.llmCalls, before, "/sweep must not spend any API tokens");
  const texts = store.telegram.slice(msgs).filter((t) => t.method === "sendMessage").map((t) => t.body.text || "");
  assert(texts.some((t) => /FOURTH|failed earlier/.test(t)), `expected the Failed meeting listed, got: ${texts.join(" | ")}`);
  const page = [...store.pages.values()].find((p) => readSourceId(p) === "FOURTHMEETING");
  equal(readStatus(page), "Failed", "status must be untouched");
  // Skip it so later sections do not keep seeing a Failed page.
  await telegramFn(
    telegramRequest({
      callback_query: { id: "cb4b", from: { id: 12345 }, data: "no:FOURTHMEETING", message: { message_id: 1003, chat: { id: 12345 } } },
    })
  );
});

console.log("\n/join");

await test("/join calls Fireflies and confirms", async () => {
  const before = store.telegram.length;
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: "/join https://teams.microsoft.com/meet/123 Weekly sync" } })
  );
  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage");
  assert(/joining/i.test(reply.body.text), `unexpected reply: ${reply.body.text}`);
  assert(/auto-detecting/.test(reply.body.text), `should say it is auto-detecting: ${reply.body.text}`);
});

await test("/join defaults to auto language detection", async () => {
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: "/join https://teams.microsoft.com/meet/456 Thai standup" } })
  );
  equal(store.lastJoin.language, "auto", "default language");
  equal(store.lastJoin.title, "Thai standup", "title unaffected");
});

await test("/join --lang overrides the default and is stripped from the title", async () => {
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: "/join https://teams.microsoft.com/meet/789 English sync --lang en" } })
  );
  equal(store.lastJoin.language, "en", "override language");
  equal(store.lastJoin.title, "English sync", "--lang and its value must not leak into the title");
});

await test("a trailing 'thai' sets the language without needing --lang", async () => {
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: "/join https://teams.microsoft.com/meet/th1 Weekly sync thai" } })
  );
  equal(store.lastJoin.language, "th", "language from the trailing word");
  equal(store.lastJoin.title, "Weekly sync", "the language word must not leak into the title");
});

await test("a trailing 'english' maps to the en code", async () => {
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: "/join https://teams.microsoft.com/meet/en1 Board review english" } })
  );
  equal(store.lastJoin.language, "en", "english must map to en");
  equal(store.lastJoin.title, "Board review", "title");
});

await test("a title with no recognised trailing word is left untouched", async () => {
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: "/join https://teams.microsoft.com/meet/def1 Ordinary title" } })
  );
  equal(store.lastJoin.language, "auto", "should fall back to the default");
  equal(store.lastJoin.title, "Ordinary title", "title must be untouched");
});

await test("--lang wins over a trailing alias word if somehow both are present", async () => {
  await telegramFn(
    telegramRequest({
      message: { chat: { id: 12345 }, text: "/join https://teams.microsoft.com/meet/both1 Sync thai --lang en" },
    })
  );
  equal(store.lastJoin.language, "en", "the explicit flag should win");
});

await test("/join with a quoted title sends the right title and language", async () => {
  store.lastJoin = null;
  await telegramFn(
    telegramRequest({
      message: { chat: { id: 12345 }, text: '/join https://teams.microsoft.com/meet/q1 "Weekly sync with Joao" thai' },
    })
  );
  equal(store.lastJoin.title, "Weekly sync with Joao", "title");
  equal(store.lastJoin.language, "th", "language");
});

await test("a quoted title ending in a language word is not mangled", async () => {
  store.lastJoin = null;
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: '/join https://teams.microsoft.com/meet/q2 "Learn Thai"' } })
  );
  equal(store.lastJoin.title, "Learn Thai", "title must survive");
  equal(store.lastJoin.language, "auto", "should fall back to the default");
});

await test("a bad language never reaches the Fireflies API", async () => {
  // The join budget is 3 per 20 minutes; a rejected parse must not spend one.
  store.lastJoin = null;
  const before = store.telegram.length;
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: '/join https://teams.microsoft.com/meet/q3 "Sync" klingon' } })
  );
  equal(store.lastJoin, null, "no Fireflies call should have been made");
  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage");
  assert(/don't recognise/.test(reply.body.text), `unexpected reply: ${reply.body.text}`);
});

await test("the join confirmation states which language was used", async () => {
  const before = store.telegram.length;
  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: '/join https://teams.microsoft.com/meet/q4 "Sync" en' } })
  );
  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage");
  assert(/language: en/.test(reply.body.text), `confirmation should name the language: ${reply.body.text}`);
});

await test("/join rejects something that is not a link", async () => {
  const before = store.telegram.length;
  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "/join not-a-link Weekly sync" } }));
  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage");
  assert(/doesn't look like a meeting link/.test(reply.body.text), `unexpected reply: ${reply.body.text}`);
});

console.log("\nChat loop");

await test("a question runs the tool loop and replays the assistant turn verbatim", async () => {
  store.chatRequests = [];
  store.chatScript = [
    {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig-abc" },
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "tu_search", name: "search_meetings", input: { query: "UAT" } },
      ],
    },
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_read", name: "read_meeting", input: { page_id: pageId() } }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Joao is sending the policy draft on Friday." }] },
  ];

  const before = store.telegram.length;
  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "what did we decide in the UAT meeting?" } }));

  equal(store.chatRequests.length, 3, "chat turn count");

  // The second request must carry the first response back unchanged: the
  // thinking block and its signature included, or the API rejects the turn.
  const replayed = store.chatRequests[1].messages;
  const assistant = replayed.find((m) => m.role === "assistant");
  assert(assistant, "the assistant turn was not replayed");
  const thinking = assistant.content.find((b) => b.type === "thinking");
  assert(thinking, "the thinking block was dropped from the replay");
  equal(thinking.signature, "sig-abc", "the thinking signature must survive the round trip");

  const toolResult = replayed.at(-1);
  equal(toolResult.role, "user", "tool results go back as a user turn");
  equal(toolResult.content[0].type, "tool_result", "tool result block type");
  equal(toolResult.content[0].tool_use_id, "tu_search", "tool_use_id");

  // The read_meeting result must contain the real recap text, not a stub.
  const readResult = JSON.parse(store.chatRequests[2].messages.at(-1).content[0].content);
  assert(/policy draft/.test(readResult.body), `read_meeting returned: ${readResult.body?.slice(0, 120)}`);

  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage");
  equal(reply.body.text, "Joao is sending the policy draft on Friday.", "reply text");
});

await test("add_note_to_meeting appends under a Post-meeting notes heading", async () => {
  const target = pageId();
  const blocksBefore = store.children.get(target).length;
  store.chatRequests = [];
  store.chatScript = [
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_note",
          name: "add_note_to_meeting",
          input: { page_id: target, note: "Joao confirmed the draft in the hallway.", is_action_item: false },
        },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Added." }] },
  ];

  await telegramFn(
    telegramRequest({ message: { chat: { id: 12345 }, text: "add a note: Joao confirmed the draft in the hallway" } })
  );

  const blocks = store.children.get(target);
  const texts = blocks.map((b) => (b[b.type].rich_text || []).map((r) => r.text.content).join(""));
  equal(blocks.length, blocksBefore + 2, "expected a heading plus the note");
  assert(texts.includes("Post-meeting notes"), "heading missing");
  assert(texts.at(-1) === "Joao confirmed the draft in the hallway.", `last block: ${texts.at(-1)}`);
});

await test("a second note reuses the existing heading", async () => {
  const target = pageId();
  const blocksBefore = store.children.get(target).length;
  store.chatRequests = [];
  store.chatScript = [
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_note2",
          name: "add_note_to_meeting",
          input: { page_id: target, note: "Draft arrived.", is_action_item: true, action_owner: "Joao" },
        },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Added." }] },
  ];

  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "note: draft arrived" } }));

  const blocks = store.children.get(target);
  const texts = blocks.map((b) => (b[b.type].rich_text || []).map((r) => r.text.content).join(""));
  equal(blocks.length, blocksBefore + 1, "expected only the note, not a second heading");
  equal(texts.filter((t) => t === "Post-meeting notes").length, 1, "heading count");
  equal(texts.at(-1), "Draft arrived. — Joao", "an action note should carry its owner");
});

await test("the loop stops instead of spinning when the model keeps calling tools", async () => {
  store.chatRequests = [];
  store.chatScript = Array.from({ length: 6 }, (_, i) => ({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: `tu_loop${i}`, name: "search_meetings", input: {} }],
  }));

  const before = store.telegram.length;
  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "go in circles" } }));

  equal(store.chatRequests.length, 6, "MAX_TURNS should cap the loop at 6");
  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage");
  assert(/got stuck/.test(reply.body.text), `unexpected reply: ${reply.body.text}`);
});

await test("/space reports the storage meter without touching Notion or the model", async () => {
  store.usageFetches = 0;
  store.chatRequests = [];
  const notionBefore = store.notionRequests;
  const before = store.telegram.length;

  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "/space" } }));

  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage");
  assert(/164 of 400 minutes used \(40%\)/.test(reply.body.text), `unexpected reply: ${reply.body.text}`);
  assert(/236 minutes left, across 7 transcript/.test(reply.body.text), `unexpected reply: ${reply.body.text}`);

  // The whole point of this command: it is the cheapest thing the bot does.
  equal(store.usageFetches, 1, "/space must make exactly one Fireflies request");
  equal(store.chatRequests.length, 0, "/space must never call the model");
  equal(store.notionRequests, notionBefore, "/space must never call Notion");
});

await test("/space warns once past the threshold and never shows negative minutes", async () => {
  store.minutesConsumed = 412;
  const before = store.telegram.length;
  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "/space" } }));
  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage");
  assert(/past the 320-minute mark/.test(reply.body.text), `expected a warning: ${reply.body.text}`);
  assert(/0 minutes left/.test(reply.body.text), `must clamp at zero: ${reply.body.text}`);
  store.minutesConsumed = 163.76;
});


// ---------------------------------------------------------------------------
// Extraction tiers
// ---------------------------------------------------------------------------

const { findSweepablePages, findPendingNotes, findStaleNotesStubs } = await import("../lib/notion.js");

let nextMeeting = 0;
/** A fresh transcribed meeting with its own stub page, ready to be tapped. */
async function freshMeeting() {
  const id = `TIERMEETING${++nextMeeting}`;
  await firefliesFn(
    firefliesRequest({ ...transcribedPayload, meeting_id: id, timestamp: Date.parse("2026-09-05T03:00:00Z") })
  );
  const page = [...store.pages.values()].find((p) => readSourceId(p) === id);
  return { id, page };
}
function tap(action, meetingId) {
  return telegramFn(
    telegramRequest({
      callback_query: {
        id: `cb-${action}-${meetingId}`,
        from: { id: 12345 },
        data: `${action}:${meetingId}`,
        message: { message_id: 2000 + nextMeeting, chat: { id: 12345 } },
      },
    })
  );
}
const blockTexts = (pageId) =>
  (store.children.get(pageId) || []).map((b) => (b[b.type].rich_text || []).map((r) => r.text.content).join(""));

console.log("\nExtraction tiers");

await test("Haiku runs the cheap model with no thinking parameter", async () => {
  const { id, page } = await freshMeeting();
  store.extractRequests = [];
  await tap("haiku", id);

  const req = store.extractRequests.at(-1);
  equal(req.model, "claude-haiku-4-5-20251001", "model");
  // Haiku 4.5 rejects thinking:{type:"adaptive"} with a 400. The key must be
  // absent entirely, not set to "off" — that would 400 just the same.
  equal(req.thinking, undefined, "no thinking key may be sent to Haiku");
  equal(readStatus(store.pages.get(page.id)), "Done", "status");
  equal(readExtractedBy(store.pages.get(page.id)), "claude-haiku-4-5-20251001", "Extracted By records the model");
});

await test("Sonnet runs the better model with adaptive thinking", async () => {
  const { id, page } = await freshMeeting();
  store.extractRequests = [];
  await tap("sonnet", id);

  const req = store.extractRequests.at(-1);
  equal(req.model, "claude-sonnet-5", "model");
  equal(req.thinking?.type, "adaptive", "Sonnet must keep adaptive thinking");
  equal(readExtractedBy(store.pages.get(page.id)), "claude-sonnet-5", "Extracted By");
});

await test("the two tiers reach the same page shape", async () => {
  const { id, page } = await freshMeeting();
  await tap("sonnet", id);
  const texts = blockTexts(page.id);
  assert(texts.includes("Summary"), "summary heading");
  assert(texts.includes("Action items"), "action rollup");
});

await test("LLM_EXTRACT_MODEL collapses both LLM tiers onto one model", async () => {
  process.env.LLM_EXTRACT_MODEL = "claude-opus-5";
  try {
    for (const tier of ["haiku", "sonnet"]) {
      const { id } = await freshMeeting();
      store.extractRequests = [];
      await tap(tier, id);
      equal(store.extractRequests.at(-1).model, "claude-opus-5", `${tier} must honour the override`);
    }
  } finally {
    delete process.env.LLM_EXTRACT_MODEL;
  }
});

await test("LLM_MODEL must not leak into a tier", async () => {
  // config.llm.extractModel() falls back to config.llm.model, so resolving a
  // tier through it would silently run every recap on the CHAT model whenever
  // LLM_EXTRACT_MODEL was unset. The tier's own model has to win.
  process.env.LLM_MODEL = "claude-some-chat-model";
  try {
    const { id } = await freshMeeting();
    store.extractRequests = [];
    await tap("haiku", id);
    equal(store.extractRequests.at(-1).model, "claude-haiku-4-5-20251001", "the tier model must win");
  } finally {
    delete process.env.LLM_MODEL;
  }
});

await test("an unrecognised callback key is reported, not silently run", async () => {
  const { id } = await freshMeeting();
  const before = store.llmCalls;
  await tap("gpt9", id);
  equal(store.llmCalls, before, "no extraction may run");
  assert(/Unrecognised action "gpt9"/.test(lastTelegram("editMessageText").body.text), "expected the fallback reply");
  await tap("no", id); // leave the page terminal for later sweep tests
});

// ---------------------------------------------------------------------------
// The Notes tier
// ---------------------------------------------------------------------------

const SUMMARY = {
  short_summary: "The team reviewed policy coverage and agreed on next steps.",
  overview: "- **policy coverage reviewed**",
  gist: "Policy review.",
  action_items: "**Joao**  \nSend the policy draft (45:00)  \n\n**Nik**  \nReview the policies (12:00)  ",
  notes: "## Policies\n\n- No policies are in place yet (12:00)\n    - Nik to check with Joao\n- Draft due Friday (45:00)",
};

console.log("\nNotes tier");

await test("Notes builds the page from Fireflies' summary with no model call", async () => {
  const { id, page } = await freshMeeting();
  store.summary = SUMMARY;
  store.summaryFetches = 0;
  const llmBefore = store.llmCalls;
  const transcriptsBefore = store.transcriptFetches;

  await tap("notes", id);

  const p = store.pages.get(page.id);
  equal(readStatus(p), "Done", "status");
  equal(readExtractedBy(p), "fireflies-notes", "Extracted By names the source, not a model");
  equal(readState(p), null, "the claim must be cleared when the page completes");
  equal(readTitle(p), "UAT for CC AI", "the summary query carries the real title");
  equal(store.llmCalls, llmBefore, "the whole point of this tier: zero model calls");
  equal(store.summaryFetches, 1, "exactly one Fireflies request");
  equal(store.transcriptFetches, transcriptsBefore, "must not fetch the full transcript");
});

await test("a Notes page has the same skeleton as a model page", async () => {
  const { id, page } = await freshMeeting();
  store.summary = SUMMARY;
  await tap("notes", id);

  const texts = blockTexts(page.id);
  assert(texts.includes("Summary"), "summary heading");
  assert(texts.includes("Action items"), "action rollup");
  assert(texts.includes("Policies"), "topic heading from the structured notes");
  assert(!texts.some((t) => t.includes("Awaiting recap")), "the stub paragraph must be gone");
  // Owner comes from the "**Joao**" header; the timestamp is kept because it
  // is the only way back to that moment in the recording.
  assert(texts.includes("Send the policy draft (45:00) — Joao"), `action bullet missing: ${texts.join(" | ")}`);
  assert(texts.includes("Review the policies (12:00) — Nik"), "second owner's action missing");
  assert(!texts.some((t) => t.includes("**")), "markdown emphasis must be stripped");
});

await test("nested Fireflies bullets survive into Notion as child blocks", async () => {
  const { id, page } = await freshMeeting();
  store.summary = SUMMARY;
  await tap("notes", id);

  const parent = (store.children.get(page.id) || []).find((b) =>
    (b.bulleted_list_item?.rich_text || []).some((r) => r.text.content.includes("No policies are in place yet"))
  );
  assert(parent, "parent bullet missing");
  assert(parent.has_children, "the sub-bullet was flattened away");
  const child = store.children.get(parent.id)[0];
  equal(child.bulleted_list_item.rich_text[0].text.content, "Nik to check with Joao", "child text");
});

await test("read_meeting can see the nested bullets", async () => {
  const { id, page } = await freshMeeting();
  store.summary = SUMMARY;
  await tap("notes", id);

  const { executeTool } = await import("../lib/tools.js");
  const read = await executeTool("read_meeting", { page_id: page.id });
  // Without listChildren({ withChildren: true }) half of a Notes recap would be
  // invisible to the chat agent, which is the main use of the database.
  assert(/Nik to check with Joao/.test(read.body), `sub-bullet missing from read_meeting: ${read.body}`);
});

await test("Notes with no summary yet claims the page and waits", async () => {
  const { id, page } = await freshMeeting();
  store.summary = null;
  const before = store.telegram.length;

  await tap("notes", id);

  const p = store.pages.get(page.id);
  equal(readStatus(p), "Processing", "status");
  equal(readState(p), "Pending Notes", "the page must be claimed");
  assert(blockTexts(page.id).some((t) => t.includes("Awaiting recap")), "no body should have been written");
  const reply = store.telegram.slice(before).find((t) => t.method === "sendMessage" && /hasn't finished/.test(t.body.text || ""));
  assert(reply, "expected a 'still waiting' message");
  assert(/Claude or ChatGPT/.test(reply.body.text), "the reply should offer the escape hatch");
});

await test("a second Notes tap on a claimed page spends no Fireflies quota", async () => {
  const claimed = [...store.pages.values()].find((p) => readState(p) === "Pending Notes");
  const before = store.summaryFetches;
  await tap("notes", readSourceId(claimed));
  equal(store.summaryFetches, before, "must not re-ask for a summary we know is not ready");
  equal(readState(store.pages.get(claimed.id)), "Pending Notes", "the claim must be untouched");
});

await test("Notes on an already-recapped page spends no Fireflies quota", async () => {
  const done = [...store.pages.values()].find((p) => readStatus(p) === "Done");
  const before = store.summaryFetches;
  await tap("notes", readSourceId(done));
  equal(store.summaryFetches, before, "the guard must sit before the summary fetch");
  assert(
    store.telegram.some((t) => t.method === "sendMessage" && /already has a recap/.test(t.body.text || "")),
    "expected an 'already has a recap' reply"
  );
});

await test("a model tier takes over a claimed page and clears the claim", async () => {
  const { id, page } = await freshMeeting();
  store.summary = null;
  await tap("notes", id);
  equal(readState(store.pages.get(page.id)), "Pending Notes", "precondition: claimed");

  store.summary = SUMMARY;
  await tap("sonnet", id);

  const p = store.pages.get(page.id);
  equal(readStatus(p), "Done", "status");
  equal(readState(p), null, "the claim must be released, or nothing can ever sweep this page");
  equal(readExtractedBy(p), "claude-sonnet-5", "the model tier's record must win");
});

await test("the Fireflies summary field set degrades instead of failing the tier", async () => {
  const { id, page } = await freshMeeting();
  store.summary = SUMMARY;
  // Pretend this account's schema has no "notes" field, the exact failure that
  // would otherwise 400 the whole query and kill the tier on a real meeting.
  store.rejectSummaryFields = ["notes"];
  try {
    await tap("notes", id);
  } finally {
    store.rejectSummaryFields = [];
  }

  equal(readStatus(store.pages.get(page.id)), "Done", "the page must still be built");
  assert(!store.summaryFields.includes("notes"), "the rejected field must have been dropped");
  const texts = blockTexts(page.id);
  assert(texts.includes("Summary"), "summary must survive the degrade");
  assert(texts.includes("Action items"), "action items must survive the degrade");
});

// ---------------------------------------------------------------------------
// meeting.summarized
// ---------------------------------------------------------------------------

console.log("\nmeeting.summarized webhook");

const summarizedPayload = (meetingId) => ({
  event: "meeting.summarized",
  timestamp: Date.now(),
  meeting_id: meetingId,
});

await test("an unsigned meeting.summarized is refused before any lookup", async () => {
  const notionBefore = store.notionRequests;
  const res = await firefliesFn(
    new Request("https://site.test/fireflies", { method: "POST", body: JSON.stringify(summarizedPayload("X")) })
  );
  equal(res.status, 401, "status");
  equal(store.notionRequests, notionBefore, "the signature check must stay ahead of every query");
});

await test("meeting.summarized completes a claimed page in the background", async () => {
  const { id, page } = await freshMeeting();
  store.summary = null;
  await tap("notes", id);
  equal(readState(store.pages.get(page.id)), "Pending Notes", "precondition: claimed");

  store.summary = SUMMARY;
  store.promoteCalls = [];
  const llmBefore = store.llmCalls;
  const before = store.telegram.length;

  const res = await firefliesFn(firefliesRequest(summarizedPayload(id)));
  equal(res.status, 200, "Fireflies must get its acknowledgement");
  equal(store.promoteCalls.length, 1, "completion must be handed to the background function");
  equal(store.promoteCalls[0].mode, "notes", "it must be routed as a Notes completion");

  const p = store.pages.get(page.id);
  equal(readStatus(p), "Done", "status");
  equal(readState(p), null, "claim cleared");
  equal(store.llmCalls, llmBefore, "no model call anywhere on this path");

  // A new message, not an edit: the prompt may be hours old by now.
  const sent = store.telegram.slice(before).filter((t) => t.method === "sendMessage");
  assert(sent.some((t) => /Recap saved \(Notes\)/.test(t.body.text || "")), "expected a fresh 'Recap saved' message");
});

await test("meeting.summarized with nothing claimed is a cheap no-op", async () => {
  store.promoteCalls = [];
  const summaryBefore = store.summaryFetches;
  const before = store.telegram.length;

  // This is the COMMON case: once subscribed, the event fires for every
  // meeting, almost none of which is waiting on it.
  const res = await firefliesFn(firefliesRequest(summarizedPayload("NOBODYCLAIMEDTHIS")));
  equal(res.status, 200, "status");
  equal(store.promoteCalls.length, 0, "no work should be triggered");
  equal(store.summaryFetches, summaryBefore, "no Fireflies quota may be spent");
  equal(store.telegram.length, before, "and no message sent");
});

await test("a redelivered meeting.summarized completes the page only once", async () => {
  const { id, page } = await freshMeeting();
  store.summary = null;
  await tap("notes", id);
  store.summary = SUMMARY;

  await firefliesFn(firefliesRequest(summarizedPayload(id)));
  const blocksAfterFirst = store.children.get(page.id).length;
  store.summaryFetches = 0;
  store.promoteCalls = [];

  await firefliesFn(firefliesRequest(summarizedPayload(id)));
  equal(store.promoteCalls.length, 0, "the claim is gone, so nothing should be triggered");
  equal(store.summaryFetches, 0, "no second summary fetch");
  equal(store.children.get(page.id).length, blocksAfterFirst, "the recap must not be duplicated");
});

await test("meeting.summarized with no meeting_id is acknowledged and ignored", async () => {
  store.promoteCalls = [];
  const res = await firefliesFn(firefliesRequest({ event: "meeting.summarized", timestamp: Date.now() }));
  equal(res.status, 200, "status");
  equal(store.promoteCalls.length, 0, "no work");
});

await test("/promote in notes mode never calls the model", async () => {
  const { id, page } = await freshMeeting();
  store.summary = null;
  await tap("notes", id);
  store.summary = SUMMARY;

  const llmBefore = store.llmCalls;
  const res = await promoteFn(
    new Request("https://site.test/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": "flow-test-internal-secret" },
      body: JSON.stringify({ page_id: page.id, mode: "notes" }),
    })
  );
  equal(res.status, 202, "background functions always answer 202");
  equal(readStatus(store.pages.get(page.id)), "Done", "status");
  equal(store.llmCalls, llmBefore, "zero model calls");
});

// ---------------------------------------------------------------------------
// The sweep must not hijack a page waiting on Fireflies
// ---------------------------------------------------------------------------

console.log("\nSweep interaction with claimed pages");

await test("findSweepablePages excludes a claimed page but still returns normal ones", async () => {
  const claimedMeeting = await freshMeeting();
  store.summary = null;
  await tap("notes", claimedMeeting.id);

  const normal = await freshMeeting(); // left Pending, Extraction State empty

  const sweepable = await findSweepablePages({ includeFailed: true, limit: 50 });
  const ids = sweepable.map((m) => m.page_id);

  assert(!ids.includes(claimedMeeting.page.id), "a page waiting on Fireflies must never be swept into a PAID recap");
  // The other half of the assertion, and the more dangerous one to get wrong:
  // Notion's does_not_equal skips empty Selects, so a filter without the
  // is_empty arm would match NOTHING and the sweep would silently stop working.
  assert(ids.includes(normal.page.id), "the sweep must still find ordinary pending pages");
});

await test("the scheduled sweep never recaps, claimed page or not", async () => {
  process.env.URL = "https://site.test";
  store.promoteCalls = [];
  store.summary = SUMMARY;
  const llmBefore = store.llmCalls;

  await sweepFn();

  assert(!store.promoteCalls.some((c) => c.mode !== "notes"), "the sweep triggered a model recap");
  equal(store.llmCalls, llmBefore, "the sweep must not spend any API tokens");
});

await test("the backstop fails a stub whose summary never arrived and releases the claim", async () => {
  const { id, page } = await freshMeeting();
  store.summary = null;
  await tap("notes", id);

  // Age the claim past the backstop window.
  store.pages.get(page.id).last_edited_time = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const stale = await findStaleNotesStubs({ olderThanHours: 24 });
  equal(stale.length, 1, "the aged stub should be found");
  equal(stale[0].page_id, page.id, "wrong stub found");

  store.promoteCalls = [];
  const before = store.telegram.length;
  await sweepFn();

  const p = store.pages.get(page.id);
  equal(readStatus(p), "Failed", "status");
  // Load-bearing: Failed AND still claimed would be invisible to
  // findSweepablePages forever, so nothing could ever retry the page.
  equal(readState(p), null, "the claim must be released so /sweep can see it again");
  const alerts = store.telegram.slice(before).filter((t) => t.method === "sendMessage");
  assert(alerts.some((a) => /still has no summary/.test(a.body.text || "")), "expected an alert naming the cause");

  const sweepable = await findSweepablePages({ includeFailed: true, limit: 50 });
  assert(sweepable.some((m) => m.page_id === page.id), "/sweep must be able to retry the released page");
});

await test("skipping a claimed page releases the claim", async () => {
  const { id, page } = await freshMeeting();
  store.summary = null;
  await tap("notes", id);
  equal(readState(store.pages.get(page.id)), "Pending Notes", "precondition: claimed");

  await tap("no", id);

  const p = store.pages.get(page.id);
  equal(readStatus(p), "Skipped", "status");
  // Otherwise findStaleNotesStubs returns this page on every sweep forever,
  // spending a /promote invocation each time to rediscover it is skipped.
  equal(readState(p), null, "Skipped is terminal and must release the claim");
  const stale = await findStaleNotesStubs({ olderThanHours: 0 });
  assert(!stale.some((m) => m.page_id === page.id), "a skipped page must not be a stranded stub");
});

await test("a freshly claimed stub is not touched by the backstop", async () => {
  const { id, page } = await freshMeeting();
  store.summary = null;
  await tap("notes", id);

  const stale = await findStaleNotesStubs({ olderThanHours: 24 });
  assert(!stale.some((m) => m.page_id === page.id), "a stub claimed seconds ago must be left to wait");
  equal((await findPendingNotes(id)).page_id, page.id, "findPendingNotes should still see it");
});

// ---------------------------------------------------------------------------
// The storage meter
// ---------------------------------------------------------------------------

console.log("\nStorage meter on the transcribed prompt");

await test("a failing usage query still leaves the page and the prompt intact", async () => {
  store.usageFails = new Error("Fireflies 500");
  const before = store.telegram.length;
  try {
    const res = await firefliesFn(
      firefliesRequest({ ...transcribedPayload, meeting_id: "USAGEFAILS", timestamp: Date.parse("2026-09-06T03:00:00Z") })
    );
    equal(res.status, 200, "a storage reading is never worth a failed webhook delivery");
  } finally {
    store.usageFails = null;
  }

  assert([...store.pages.values()].some((p) => readSourceId(p) === "USAGEFAILS"), "the page must still be created");
  const prompt = store.telegram.slice(before).find((t) => t.method === "sendMessage" && t.body.reply_markup);
  assert(prompt, "the prompt must still be sent");
  assert(!/Storage:/.test(prompt.body.text), "it should simply go out without the line");
  await tap("no", "USAGEFAILS");
});

await test("a hanging usage query is aborted and does not stall the webhook", async () => {
  store.usageHangs = true;
  const started = Date.now();
  try {
    const res = await firefliesFn(
      firefliesRequest({ ...transcribedPayload, meeting_id: "USAGEHANGS", timestamp: Date.parse("2026-09-06T04:00:00Z") })
    );
    equal(res.status, 200, "status");
  } finally {
    store.usageHangs = false;
  }
  // The probe's own timeout is 4s; Fireflies gives the whole webhook 10.
  assert(Date.now() - started < 8000, `the webhook took ${Date.now() - started}ms — the abort did not fire`);
  const prompt = lastTelegram("sendMessage");
  assert(prompt.body.reply_markup, "the prompt must still have gone out");
  await tap("no", "USAGEHANGS");
});

await test("the prompt warns about low storage in the same words as /space", async () => {
  store.minutesConsumed = 380;
  const before = store.telegram.length;
  try {
    await firefliesFn(
      firefliesRequest({ ...transcribedPayload, meeting_id: "LOWSTORAGE", timestamp: Date.parse("2026-09-06T05:00:00Z") })
    );
  } finally {
    store.minutesConsumed = 163.76;
  }
  const prompt = store.telegram.slice(before).find((t) => t.method === "sendMessage" && t.body.reply_markup);
  assert(/Storage: 20 of 400 minutes left\./.test(prompt.body.text), `unexpected: ${prompt.body.text}`);
  assert(/past the 320-minute mark/.test(prompt.body.text), "the warning must reach the prompt too");
  await tap("no", "LOWSTORAGE");
});

// ---------------------------------------------------------------------------
// Chat hand-off prompt
// ---------------------------------------------------------------------------

console.log("\nChat hand-off prompt");

await test("a failing title query falls back to the timestamp label", async () => {
  store.titleFails = new Error("Fireflies 500");
  const before = store.telegram.length;
  try {
    const res = await firefliesFn(
      firefliesRequest({ ...transcribedPayload, meeting_id: "TITLEFAILS", timestamp: Date.parse("2026-09-06T06:00:00Z") })
    );
    equal(res.status, 200, "a title is never worth a failed webhook delivery");
  } finally {
    store.titleFails = null;
  }
  const prompt = store.telegram.slice(before).find((t) => t.method === "sendMessage" && t.body.reply_markup);
  assert(prompt, "the prompt must still be sent");
  const copy = prompt.body.reply_markup.inline_keyboard.flat().find((b) => b.copy_text).copy_text.text;
  assert(copy.includes('"Meeting — Sep 6, 13:00"'), `expected the timestamp label: ${copy}`);
  assert(copy.includes("TITLEFAILS"), "the Fireflies id must still be in the prompt");
  await tap("no", "TITLEFAILS");
});

await test("a very long title is trimmed so the copy button survives", async () => {
  store.meetingTitle = "Quarterly planning ".repeat(20).trim();
  const before = store.telegram.length;
  try {
    await firefliesFn(
      firefliesRequest({ ...transcribedPayload, meeting_id: "LONGTITLE", timestamp: Date.parse("2026-09-06T07:00:00Z") })
    );
  } finally {
    store.meetingTitle = "UAT for CC AI";
  }
  const prompt = store.telegram.slice(before).find((t) => t.method === "sendMessage" && t.body.reply_markup);
  const copy = prompt.body.reply_markup.inline_keyboard.flat().find((b) => b.copy_text);
  assert(copy, "the copy button must not be dropped for a long title");
  assert(copy.copy_text.text.length <= 256, `copy_text is ${copy.copy_text.text.length} chars`);
  assert(copy.copy_text.text.includes("LONGTITLE"), "trimming must never cut the Fireflies id");
  await tap("no", "LONGTITLE");
});

await test("a retired Sonnet button in scrollback still runs Sonnet", async () => {
  const { id, page } = await freshMeeting();
  store.extractRequests = [];
  await tap("sonnet", id);
  equal(store.extractRequests.at(-1).model, "claude-sonnet-5", "model");
  equal(readStatus(store.pages.get(page.id)), "Done", "status");
});

console.log(
  failures === 0
    ? `\nAll flow tests passed (Status property kind: ${STATUS_TYPE}).\n`
    : `\n${failures} test(s) failed (Status property kind: ${STATUS_TYPE}).\n`
);
process.exit(failures === 0 ? 0 : 1);
