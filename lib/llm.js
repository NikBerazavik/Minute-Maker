import { config } from "./config.js";
import * as anthropic from "./llm/anthropic.js";
import * as openrouter from "./llm/openrouter.js";

// ---------------------------------------------------------------------------
// Provider-neutral LLM layer.
//
// extract.js and agent.js only ever see the shapes below, so pointing the
// whole pipeline at a different vendor (OpenRouter, for cost/quality trials)
// is an env change plus one adapter file — no pipeline edits.
//
//   chat({ system, messages, tools, toolChoice, maxTokens, model, thinking })
//     -> { text, toolCalls: [{ id, name, input }], stopReason, usage, raw }
//
// Neutral message shape:
//   { role: "user" | "assistant", content: string | Block[] }
// Neutral blocks:
//   { type: "text",        text }
//   { type: "tool_use",    id, name, input }        (assistant)
//   { type: "tool_result", tool_use_id, content }   (user)
//   { type: "opaque",      _raw }                   provider-private blocks
//                                                   (e.g. Anthropic thinking)
//                                                   that must be replayed
//                                                   verbatim on the same model
//                                                   and dropped elsewhere.
//
// stopReason is normalised to: "end" | "tool_use" | "max_tokens" | "refusal".
// ---------------------------------------------------------------------------

const ADAPTERS = { anthropic, openrouter };

function adapter(name = config.llm.provider) {
  const impl = ADAPTERS[name];
  if (!impl) {
    throw new Error(`Unknown LLM_PROVIDER "${name}". Expected one of: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return impl;
}

export async function chat(request) {
  const impl = adapter();
  const model = request.model || config.llm.model;
  const started = Date.now();
  // `thinking` is spread through with everything else. The OpenRouter adapter
  // destructures only the params it supports, so the extra key is ignored there
  // — there is no OpenAI-compatible equivalent to forward it to.
  const response = await impl.chat({ ...request, model });
  console.log(
    `llm ${config.llm.provider}/${model} stop=${response.stopReason} ` +
      `in=${response.usage.input} out=${response.usage.output} ${Date.now() - started}ms`
  );
  return response;
}

/**
 * Turns a chat() response into the assistant message to push back into
 * `messages`. Delegated to the adapter so provider-private blocks (Anthropic
 * thinking blocks, which must be replayed unchanged) survive the round trip.
 */
export function assistantTurn(response) {
  return adapter().assistantTurn(response);
}

/** results: [{ id, result }] where result is any JSON-serialisable value. */
export function toolResultTurn(results) {
  return {
    role: "user",
    content: results.map(({ id, result }) => ({
      type: "tool_result",
      tool_use_id: id,
      content: typeof result === "string" ? result : JSON.stringify(result),
    })),
  };
}

