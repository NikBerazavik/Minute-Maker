// ---------------------------------------------------------------------------
// Registers (or inspects, or removes) the Telegram webhook.
//
//   npm run webhook:set      point Telegram at your Netlify deployment
//   npm run webhook:info     show current status, including recent errors
//   npm run webhook:delete   unregister
//
// webhook:info is the first thing to run when the bot goes quiet — Telegram
// records the last delivery error there, which is usually the whole answer.
// ---------------------------------------------------------------------------

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const deployUrl = process.env.DEPLOY_URL;

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set.");
  process.exit(1);
}

const command = process.argv[2] || "set";
const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

if (command === "set") {
  if (!deployUrl) {
    console.error("DEPLOY_URL is not set. Add it to .env, e.g. https://your-site.netlify.app");
    process.exit(1);
  }
  if (!secret) {
    console.error("TELEGRAM_WEBHOOK_SECRET is not set. Generate one: openssl rand -hex 32");
    process.exit(1);
  }

  const url = `${deployUrl.replace(/\/$/, "")}/telegram`;
  const result = await api("setWebhook", {
    url,
    secret_token: secret,
    // callback_query is what carries the Yes/No taps. Without it here, the
    // buttons appear but nothing ever happens when they are pressed.
    allowed_updates: ["message", "edited_message", "callback_query"],
    drop_pending_updates: true,
  });

  console.log(result.ok ? `Webhook set to ${url}` : `Failed: ${result.description}`);
  process.exit(result.ok ? 0 : 1);
}

if (command === "info") {
  const result = await api("getWebhookInfo");
  console.log(JSON.stringify(result.result, null, 2));
  if (result.result?.last_error_message) {
    console.log(`\nLast delivery error: ${result.result.last_error_message}`);
  }
  const allowed = result.result?.allowed_updates;
  if (allowed && !allowed.includes("callback_query")) {
    console.log("\nWARNING: callback_query is not in allowed_updates — Yes/No taps will be ignored.");
    console.log("Fix it with: npm run webhook:set");
  }
  process.exit(0);
}

if (command === "delete") {
  const result = await api("deleteWebhook", { drop_pending_updates: true });
  console.log(result.ok ? "Webhook deleted." : `Failed: ${result.description}`);
  process.exit(result.ok ? 0 : 1);
}

console.error(`Unknown command "${command}". Use: set | info | delete`);
process.exit(1);
