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
  promoteCalls: [], // bodies POSTed to the /promote background function
  transcriptFetches: 0,
  transcriptExists: true,
  lastJoin: null, // variables sent on the last addToLiveMeeting call
};

const SCHEMA = {
  Name: { type: "title" },
  Date: { type: "date" },
  "Source Meeting ID": { type: "rich_text" },
  Status: {
    type: "select",
    select: { options: [{ name: "Pending" }, { name: "Processing" }, { name: "Done" }, { name: "Skipped" }, { name: "Failed" }] },
  },
};

const readStatus = (page) => page.properties.Status?.select?.name || null;
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
  if (filter.property === "Status") return readStatus(page) === filter.select.equals;
  if (filter.property === "Name") return readTitle(page).toLowerCase().includes(String(filter.title.contains).toLowerCase());
  if (filter.property === "Date") return true;
  throw new Error(`mock: unhandled filter ${JSON.stringify(filter)}`);
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
    const path = u.slice("https://api.notion.com/v1".length).split("?")[0];

    if (method === "GET" && path === "/databases/db-1") return json({ data_sources: [{ id: "ds-1", name: "Meetings" }] });
    if (method === "GET" && path === "/data_sources/ds-1") return json({ properties: SCHEMA });

    if (method === "POST" && path === "/data_sources/ds-1/query") {
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
          existing.push({ id: `${pageId}-b${existing.length}`, ...stored });
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

await test("creates a stub page and sends a Yes/No prompt", async () => {
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
  const buttons = prompt.body.reply_markup.inline_keyboard[0];
  equal(buttons[0].callback_data, `yes:${MEETING_ID}`, "yes callback_data");
  assert(Buffer.byteLength(buttons[0].callback_data) <= 64, "callback_data exceeds Telegram's 64-byte limit");
});

await test("a redelivered webhook does not create a second page", async () => {
  const before = store.telegram.length;
  const res = await firefliesFn(firefliesRequest(transcribedPayload));
  equal(res.status, 200, "status");
  equal(store.pages.size, 1, "page count");
  equal(store.telegram.length, before, "no second prompt should be sent");
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

await test("Yes writes the recap, sets the real title and marks it Done", async () => {
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

await test("tapping Yes again does nothing", async () => {
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

await test("the sweep promotes only the meetings still pending", async () => {
  const third = { ...transcribedPayload, meeting_id: "THIRDMEETING", timestamp: Date.parse("2026-09-03T03:00:00Z") };
  await firefliesFn(firefliesRequest(third));
  const target = [...store.pages.values()].find((p) => readSourceId(p) === "THIRDMEETING");

  process.env.URL = "https://site.test";
  store.promoteCalls = [];
  const llmBefore = store.llmCalls;
  await sweepFn();

  equal(store.promoteCalls.length, 1, "only the one Pending meeting should be triggered");
  equal(store.promoteCalls[0].page_id, target.id, "wrong page triggered");
  // The trigger reaches the real background function, which does the work.
  equal(store.llmCalls, llmBefore + 1, "the triggered run should have extracted");
  equal(readStatus(store.pages.get(target.id)), "Done", "status after the sweep");
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

await test("the scheduled sweep does not retry a Failed page", async () => {
  store.promoteCalls = [];
  await sweepFn();
  equal(store.promoteCalls.length, 0, "a Failed page must not be retried by the schedule");
});

await test("/sweep does retry a Failed page, and recaps it", async () => {
  const before = store.llmCalls;
  store.promoteCalls = [];
  await telegramFn(telegramRequest({ message: { chat: { id: 12345 }, text: "/sweep" } }));

  equal(store.promoteCalls.length, 1, "expected one promotion to be triggered");
  equal(store.promoteCalls[0].allow_failed, true, "/sweep must ask for failed pages to be retried");
  equal(store.llmCalls, before + 1, "expected one extraction");
  const page = [...store.pages.values()].find((p) => readSourceId(p) === "FOURTHMEETING");
  equal(readStatus(page), "Done", "status");
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

console.log(failures === 0 ? "\nAll flow tests passed.\n" : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
