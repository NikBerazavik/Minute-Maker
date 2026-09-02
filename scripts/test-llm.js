// ---------------------------------------------------------------------------
// Live check of the provider layer. Costs a few cents of tokens.
//
//   npm run test:llm
//
// This is the acceptance test for switching providers. The OpenRouter adapter
// is written but has never been run against the live API, so after setting
// LLM_PROVIDER=openrouter and OPENROUTER_API_KEY, run this before trusting the
// pipeline with a real meeting:
//
//   LLM_PROVIDER=openrouter LLM_MODEL=anthropic/claude-sonnet-5 npm run test:llm
//
// It exercises the three things most likely to differ between providers:
// a forced tool call, parsed tool arguments, and a second turn carrying the
// assistant turn plus tool results back into the conversation.
// ---------------------------------------------------------------------------

import { config } from "../lib/config.js";
import { chat, assistantTurn, toolResultTurn } from "../lib/llm.js";

const TOOL = {
  name: "record_measurement",
  description: "Record a single measurement mentioned by the user.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      label: { type: "string", description: "What was measured." },
      value: { type: "number", description: "The numeric value." },
    },
    required: ["label", "value"],
    additionalProperties: false,
  },
};

let failures = 0;
function report(name, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

console.log(`\nProvider: ${config.llm.provider}, model: ${config.llm.model}\n`);

// --- Turn 1: forced tool call -------------------------------------------------
const messages = [
  { role: "user", content: "The tank held 42 litres this morning. Record that measurement with record_measurement." },
];

const first = await chat({
  system: "You record measurements by calling the record_measurement tool.",
  messages,
  tools: [TOOL],
  toolChoice: { name: TOOL.name },
  maxTokens: 4096,
});

report("returns a tool call", first.toolCalls.length === 1, `stopReason=${first.stopReason}`);
const call = first.toolCalls[0];
if (call) {
  report("tool name is correct", call.name === TOOL.name, call.name);
  report("arguments are a parsed object", call.input && typeof call.input === "object", typeof call.input);
  report("value came through as a number", call.input?.value === 42, JSON.stringify(call.input));
}

// --- Turn 2: replay the assistant turn and the tool result --------------------
if (call) {
  messages.push(assistantTurn(first));
  messages.push(toolResultTurn([{ id: call.id, result: { recorded: true } }]));

  const second = await chat({
    system: "You record measurements by calling the record_measurement tool.",
    messages,
    tools: [TOOL],
    maxTokens: 4096,
  });

  report("second turn is accepted and returns text", second.stopReason === "end" && second.text.length > 0, second.text.slice(0, 80));
  report("usage is reported", second.usage.input > 0, JSON.stringify(second.usage));
}

console.log(failures === 0 ? "\nProvider layer works.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
