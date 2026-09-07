// ---------------------------------------------------------------------------
// Offline tests for the deterministic parts: rendering, chunking, extraction
// validation, webhook signature checking, and the OpenRouter message mapping.
// No network, no credentials.
//
//   npm run test:render
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { config } from "../lib/config.js";
import {
  renderBlocks,
  chunkText,
  chunkArray,
  blocksToText,
  actionLine,
  BLOCKS_PER_REQUEST,
  RICH_TEXT_LIMIT,
} from "../lib/render.js";
import { normalizeExtraction, formatTranscript } from "../lib/extract.js";
import { toApiMessages } from "../lib/llm/openrouter.js";
import { verifySignature } from "../netlify/functions/fireflies.js";
import { parseJoinCommand, resolveLanguage } from "../lib/join.js";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name} — ${err.message}`);
    failures++;
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const note = (content, extra = {}) => ({
  content,
  speaker: "Nik",
  is_action_item: false,
  action_owner: "TBA",
  action_due: null,
  ...extra,
});

const headingTexts = (blocks, type = "heading_2") =>
  blocks.filter((b) => b.type === type).map((b) => b[type].rich_text.map((r) => r.text.content).join(""));
const bulletTexts = (blocks) =>
  blocks
    .filter((b) => b.type === "bulleted_list_item")
    .map((b) => b.bulleted_list_item.rich_text.map((r) => r.text.content).join(""));

console.log("\nChunking");

test("chunkText leaves short text alone", () => {
  equal(chunkText("hello").length, 1, "chunk count");
});

test("chunkText splits at the Notion rich-text limit", () => {
  const long = "word ".repeat(1200); // 6000 chars
  const chunks = chunkText(long);
  assert(chunks.length >= 3, `expected 3+ chunks, got ${chunks.length}`);
  for (const c of chunks) assert(c.length <= RICH_TEXT_LIMIT, `chunk of ${c.length} exceeds ${RICH_TEXT_LIMIT}`);
  equal(chunks.join(" ").replace(/\s+/g, " ").trim(), long.replace(/\s+/g, " ").trim(), "content preserved");
});

test("chunkText never emits an empty chunk for unbroken text", () => {
  const chunks = chunkText("x".repeat(5000));
  equal(chunks.length, 3, "chunk count");
  for (const c of chunks) assert(c.length > 0, "empty chunk");
});

test("chunkArray batches at the Notion block limit", () => {
  const batches = chunkArray(new Array(250).fill(0), BLOCKS_PER_REQUEST);
  equal(batches.length, 3, "batch count");
  equal(batches[0].length, 100, "first batch size");
  equal(batches[2].length, 50, "last batch size");
});

console.log("\nRendering");

test("a meeting with no action items omits the rollup heading", () => {
  const blocks = renderBlocks({
    summary: "We talked about the report.",
    topics: [{ title: "Report", notes: [note("Nik walked through the draft.")] }],
  });
  const headings = headingTexts(blocks);
  assert(!headings.includes(config.text.actionsHeading), `rollup heading present: ${headings.join(", ")}`);
  assert(headings.includes(config.text.summaryHeading), "summary heading missing");
  assert(headings.includes("Report"), "topic heading missing");
});

test("action items appear in the rollup AND inline, and cannot drift", () => {
  const action = note("Nik will send the policy draft.", {
    is_action_item: true,
    action_owner: "Nik",
    action_due: "Friday",
  });
  const blocks = renderBlocks({
    summary: "Policies.",
    topics: [{ title: "Policies", notes: [note("Joao explained the current state."), action] }],
  });

  const bullets = bulletTexts(blocks);
  // The rollup line carries owner and due; the inline bullet is bare content.
  assert(bullets.includes("Nik will send the policy draft. — Nik, due Friday"), `rollup line missing: ${bullets}`);
  assert(bullets.includes("Nik will send the policy draft."), "inline bullet missing");
  assert(bullets.includes("Joao explained the current state."), "discussion bullet missing");
  equal(headingTexts(blocks).filter((h) => h === config.text.actionsHeading).length, 1, "rollup heading count");
});

test("action line falls back to TBA and omits an absent due date", () => {
  equal(actionLine({ content: "Do the thing", action_owner: "", action_due: null }), "Do the thing — TBA", "line");
});

test("a big meeting produces more than one append batch", () => {
  const topics = Array.from({ length: 8 }, (_, t) => ({
    title: `Topic ${t + 1}`,
    notes: Array.from({ length: 12 }, (_, n) => note(`Point ${n + 1} of topic ${t + 1}.`)),
  }));
  const blocks = renderBlocks({ summary: "Long meeting.", topics });
  assert(blocks.length > BLOCKS_PER_REQUEST, `expected >100 blocks, got ${blocks.length}`);
  equal(chunkArray(blocks, BLOCKS_PER_REQUEST).length, 2, "append batches");
});

test("a 3000-character note stays one block with two rich-text pieces", () => {
  const blocks = renderBlocks({
    summary: "s",
    topics: [{ title: "T", notes: [note("word ".repeat(600))] }],
  });
  const bullet = blocks.find((b) => b.type === "bulleted_list_item");
  assert(bullet.bulleted_list_item.rich_text.length > 1, "expected the note to be split into rich-text pieces");
  for (const rt of bullet.bulleted_list_item.rich_text) {
    assert(rt.text.content.length <= RICH_TEXT_LIMIT, "rich-text piece too long");
  }
});

test("blocksToText reads a rendered page back", () => {
  const blocks = renderBlocks({
    summary: "Summary text.",
    topics: [{ title: "Alpha", notes: [note("First point.")] }],
  });
  // Simulate what the Notion API returns (plain_text rather than text.content).
  const asApi = blocks.map((b) => ({
    type: b.type,
    [b.type]: { rich_text: b[b.type].rich_text.map((r) => ({ plain_text: r.text.content })) },
  }));
  const text = blocksToText(asApi);
  assert(text.includes("## Summary"), "summary heading missing");
  assert(text.includes("- First point."), "bullet missing");
});

console.log("\nExtraction validation");

test("normalizeExtraction rejects an empty summary", () => {
  let threw = false;
  try {
    normalizeExtraction({ summary: "  ", topics: [{ title: "T", notes: [note("x")] }] });
  } catch {
    threw = true;
  }
  assert(threw, "expected a throw");
});

test("normalizeExtraction rejects topics with no usable notes", () => {
  let threw = false;
  try {
    normalizeExtraction({ summary: "s", topics: [{ title: "T", notes: [{ content: "   " }] }] });
  } catch {
    threw = true;
  }
  assert(threw, "expected a throw");
});

test("normalizeExtraction defaults owner to TBA and clears a due date on a non-action", () => {
  const out = normalizeExtraction({
    summary: "s",
    topics: [{ title: "T", notes: [{ content: "a point", is_action_item: false, action_due: "Friday" }] }],
  });
  equal(out.topics[0].notes[0].action_owner, "TBA", "owner");
  equal(out.topics[0].notes[0].action_due, null, "due");
  equal(out.topics[0].notes[0].speaker, "Unknown", "speaker");
});

test("normalizeExtraction defaults a missing topic title to General", () => {
  const out = normalizeExtraction({ summary: "s", topics: [{ notes: [note("a")] }] });
  equal(out.topics[0].title, "General", "title");
});

console.log("\nTranscript formatting");

test("formatTranscript renders timestamps and skips empty lines", () => {
  const text = formatTranscript([
    { speaker_name: "Nik", text: "Hello", start_time: 65 },
    { speaker_name: "Joao", text: "   ", start_time: 70 },
    { speaker_name: null, text: "Anonymous point", start_time: 3725 },
  ]);
  equal(text.split("\n").length, 2, "line count");
  assert(text.startsWith("[1:05] Nik: Hello"), `bad first line: ${text.split("\n")[0]}`);
  assert(text.includes("[1:02:05] Unknown: Anonymous point"), "hour formatting or Unknown fallback wrong");
});

console.log("\n/join parsing");

const LINK = "https://teams.microsoft.com/meet/491621134392563";
const join = (text) => parseJoinCommand(text);

test("quoted title with a language keeps them separate", () => {
  const r = join(`${LINK} "Weekly sync" thai`);
  equal(r.error, undefined, "should not error");
  equal(r.title, "Weekly sync", "title");
  equal(r.language, "th", "language");
  equal(r.link, LINK, "link");
});

test("quoted title with no language leaves the language unset", () => {
  const r = join(`${LINK} "Weekly sync"`);
  equal(r.title, "Weekly sync", "title");
  equal(r.language, null, "language should be unset, letting the config default apply");
});

test("quotes protect a title that ends in a language word", () => {
  // The exact case bare parsing gets wrong.
  const r = join(`${LINK} "Learn Thai"`);
  equal(r.title, "Learn Thai", "title must survive intact");
  equal(r.language, null, "no language should be taken from inside the quotes");
});

test("smart quotes from an iOS keyboard are accepted", () => {
  const r = join(`${LINK} \u201CBoard review\u201D english`);
  equal(r.title, "Board review", "title");
  equal(r.language, "en", "language");
});

test("single quotes work too", () => {
  const r = join(`${LINK} 'Board review' th`);
  equal(r.title, "Board review", "title");
  equal(r.language, "th", "language");
});

test("an unterminated quote is an error, not a guess", () => {
  const r = join(`${LINK} "Weekly sync`);
  assert(/never closed it/.test(r.error || ""), `expected a quote error, got: ${JSON.stringify(r)}`);
});

test("junk after a quoted title is rejected rather than silently ignored", () => {
  const r = join(`${LINK} "Weekly sync" with the platform team`);
  assert(/couldn't tell what/.test(r.error || ""), `expected an error, got: ${JSON.stringify(r)}`);
});

test("an unknown language after a quoted title is rejected", () => {
  // Rejecting protects the 3-per-20-minute join budget from being spent on a
  // meeting that would be transcribed in the wrong language.
  const r = join(`${LINK} "Weekly sync" klingon`);
  assert(/don't recognise/.test(r.error || ""), `expected an error, got: ${JSON.stringify(r)}`);
});

test("an unlisted but well-formed code passes through after a quoted title", () => {
  equal(join(`${LINK} "Sync" ja`).language, "ja", "ja");
  equal(join(`${LINK} "Sync" zh-CN`).language, "zh-CN", "region subtag case preserved");
});

test("a code longer than Fireflies allows is rejected, never truncated", () => {
  const r = join(`${LINK} "Sync" es-419`);
  assert(/at most 5 characters/.test(r.error || ""), `expected a length error, got: ${JSON.stringify(r)}`);
});

test("bare title with a trailing language word still works", () => {
  const r = join(`${LINK} Weekly sync thai`);
  equal(r.title, "Weekly sync", "title");
  equal(r.language, "th", "language");
});

test("bare title without a language word is left whole", () => {
  const r = join(`${LINK} Ordinary meeting title`);
  equal(r.title, "Ordinary meeting title", "title");
  equal(r.language, null, "language");
});

test("bare parsing ignores code-shaped words that are not aliases", () => {
  // "AI" is a valid-looking code but almost certainly part of the title.
  const r = join(`${LINK} Roadmap for AI`);
  equal(r.title, "Roadmap for AI", "title must be left alone");
  equal(r.language, null, "language");
});

test("--lang works in both the quoted and bare forms", () => {
  equal(join(`${LINK} "Sync" --lang ja`).language, "ja", "quoted");
  const bare = join(`${LINK} Sync meeting --lang ja`);
  equal(bare.language, "ja", "bare");
  equal(bare.title, "Sync meeting", "--lang must not leak into the title");
});

test("--lang with no value is an error", () => {
  assert(/No language given/.test(join(`${LINK} Sync --lang`).error || ""), "bare form");
  assert(/exactly one language/.test(join(`${LINK} "Sync" --lang`).error || ""), "quoted form");
});

test("a missing or malformed link is rejected", () => {
  assert(/doesn't look like a meeting link/.test(join("not-a-link Weekly sync").error || ""), "not a url");
  assert(/doesn't look like a meeting link/.test(join("ftp://x.com Weekly").error || ""), "wrong protocol");
  assert(/Usage/.test(join("").error || ""), "empty");
});

test("a link with no title at all is valid", () => {
  const r = join(LINK);
  equal(r.title, "", "title");
  equal(r.language, null, "language");
  equal(r.link, LINK, "link");
});

test("resolveLanguage maps aliases case-insensitively", () => {
  equal(resolveLanguage("THAI").code, "th", "THAI");
  equal(resolveLanguage(" English ").code, "en", "padded English");
  equal(resolveLanguage("auto").code, "auto", "auto");
});

console.log("\nWebhook signature");

const SECRET = "test-secret-value";
const BODY = JSON.stringify({ event: "meeting.transcribed", timestamp: 1710876543210, meeting_id: "ASxwZxCstx" });
const GOOD = `sha256=${crypto.createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex")}`;

test("accepts a correctly signed body", () => {
  assert(verifySignature(BODY, GOOD, SECRET), "valid signature rejected");
});

test("rejects a tampered body", () => {
  assert(!verifySignature(BODY.replace("ASxwZxCstx", "OTHERMEETID"), GOOD, SECRET), "tampered body accepted");
});

test("rejects a tampered signature", () => {
  const flipped = GOOD.slice(0, -1) + (GOOD.endsWith("a") ? "b" : "a");
  assert(!verifySignature(BODY, flipped, SECRET), "tampered signature accepted");
});

test("rejects a missing signature header", () => {
  assert(!verifySignature(BODY, null, SECRET), "missing header accepted");
  assert(!verifySignature(BODY, "", SECRET), "empty header accepted");
});

test("rejects a signature of the wrong length without throwing", () => {
  assert(!verifySignature(BODY, "sha256=short", SECRET), "short signature accepted");
});

test("rejects the right digest under the wrong secret", () => {
  const other = `sha256=${crypto.createHmac("sha256", "different-secret").update(BODY, "utf8").digest("hex")}`;
  assert(!verifySignature(BODY, other, SECRET), "wrong-secret signature accepted");
});

console.log("\nOpenRouter message mapping");

test("tool_use becomes tool_calls and tool_result becomes a tool message", () => {
  const mapped = toApiMessages("sys", [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "opaque", _raw: { type: "thinking" } },
        { type: "text", text: "checking" },
        { type: "tool_use", id: "t1", name: "search_meetings", input: { query: "UAT" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"count":1}' }] },
  ]);

  equal(mapped[0].role, "system", "system first");
  equal(mapped[1].role, "user", "user second");
  equal(mapped[2].role, "assistant", "assistant third");
  equal(mapped[2].tool_calls[0].function.name, "search_meetings", "tool name");
  equal(mapped[2].tool_calls[0].function.arguments, '{"query":"UAT"}', "arguments must be a JSON string");
  equal(mapped[3].role, "tool", "tool result role");
  equal(mapped[3].tool_call_id, "t1", "tool_call_id");
  assert(!JSON.stringify(mapped).includes("thinking"), "opaque blocks must be dropped");
});

console.log(failures === 0 ? "\nAll offline tests passed.\n" : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
