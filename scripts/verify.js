// ---------------------------------------------------------------------------
// Preflight check. Run this BEFORE deploying:  npm run verify
//
// It catches the failures that would otherwise surface as silence: a typo'd
// property name, a database the integration was never connected to, a Status
// option spelled differently in Notion than in config.
//
// Costs one Fireflies API request (the free plan allows 50 per day).
// ---------------------------------------------------------------------------

import { config } from "../lib/config.js";
import { notionRequest, meetingsSourceId, meetingsSchema, searchMeetings } from "../lib/notion.js";
import { whoAmI } from "../lib/fireflies.js";
import { getMe } from "../lib/telegram.js";
import { today, nowLocal } from "../lib/dates.js";

const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const warn = (m) => console.log(`  WARN  ${m}`);
let failures = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    ok(`${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    bad(`${name} — ${err.message}`);
    failures++;
  }
}

console.log("\nEnvironment");
await check("Environment variables present", () => {
  config.notion.apiKey();
  config.notion.meetingsDbId();
  config.telegram.botToken();
  config.telegram.chatId();
  config.telegram.webhookSecret();
  config.fireflies.apiKey();
  config.fireflies.webhookSecret();
  config.internalSecret();
  if (config.llm.provider === "openrouter") config.llm.openrouter.apiKey();
  else config.llm.anthropic.apiKey();
  return `provider ${config.llm.provider}, model ${config.llm.model}`;
});
await check("Local time resolves", () => `${nowLocal()} (today = ${today()})`);

console.log("\nNotion");
await check("Token is valid", async () => {
  const me = await notionRequest("/users/me");
  return me.name || me.bot?.owner?.type || "authenticated";
});
await check("Meetings database reachable", async () => {
  const id = await meetingsSourceId();
  return `data source ${id.slice(0, 8)}...`;
});
await check("Schema matches config", async () => {
  const schema = await meetingsSchema();
  const actual = Object.keys(schema);
  const expected = [config.props.name, config.props.date, config.props.sourceId, config.props.status];
  const missing = expected.filter((p) => !actual.includes(p));
  if (missing.length) throw new Error(`missing propertie(s): ${missing.join(", ")}`);

  const types = {
    [config.props.name]: ["title"],
    [config.props.date]: ["date"],
    [config.props.sourceId]: ["rich_text"],
    [config.props.status]: ["select", "status"],
  };
  for (const [prop, allowed] of Object.entries(types)) {
    if (!allowed.includes(schema[prop].type)) {
      throw new Error(`"${prop}" is a ${schema[prop].type}; expected ${allowed.join(" or ")}`);
    }
  }
  return `${actual.length} properties, Status is a ${schema[config.props.status].type}`;
});
await check("Status options exist", async () => {
  const schema = await meetingsSchema();
  const prop = schema[config.props.status];
  const options = (prop.select?.options || prop.status?.options || []).map((o) => o.name);
  const wanted = Object.values(config.status);
  const missing = wanted.filter((w) => !options.includes(w));
  if (missing.length) {
    // Notion auto-creates missing Select options on write, but a Status
    // property does not — so this is fatal there and only a warning here.
    if (prop.type === "status") throw new Error(`Status property is missing options: ${missing.join(", ")}`);
    warn(`Select is missing options (Notion will create them on first write): ${missing.join(", ")}`);
  }
  return options.join(", ") || "(none yet)";
});
await check("Can query the database", async () => {
  const meetings = await searchMeetings({ limit: 3 });
  return `${meetings.length} meeting(s) found`;
});

console.log("\nTelegram");
await check("Bot token is valid", async () => {
  const me = await getMe();
  if (!me.ok) throw new Error(me.description || "getMe failed");
  return `@${me.result.username}`;
});

console.log("\nFireflies");
await check("API key is valid", async () => {
  const user = await whoAmI();
  return user?.email || "authenticated";
});

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check(s) failed. Fix these before deploying.\n`
);
process.exit(failures === 0 ? 0 : 1);
