import { config } from "../config.js";

// ---------------------------------------------------------------------------
// OpenRouter adapter (OpenAI-compatible /chat/completions).
//
// STATUS: written, never executed against the live API. It exists so that
// trialling other models is a config change, not a redesign. Before trusting
// it, set OPENROUTER_API_KEY + LLM_PROVIDER=openrouter and run:
//     npm run test:llm
// which forces a tool call and asserts the parsed arguments come back.
//
// Wire-format differences from Anthropic, all handled below:
//   system prompt   -> a leading { role: "system" } message
//   tools           -> { type: "function", function: { name, description, parameters } }
//   forced choice   -> { type: "function", function: { name } }
//   tool_use        -> assistant.tool_calls[]; arguments is a JSON *string*
//   tool_result     -> its own { role: "tool", tool_call_id, content } message
//   thinking blocks -> no equivalent; neutral "opaque" blocks are dropped
//   finish_reason   -> tool_calls | stop | length | content_filter
//
// Model ids on OpenRouter are namespaced, e.g. "anthropic/claude-sonnet-5" or
// "google/gemini-2.5-pro". LLM_MODEL is passed through verbatim.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 8 * 60 * 1000;

const STOP_REASONS = {
  stop: "end",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

function toApiTools(tools = []) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      ...(t.strict ? { strict: true } : {}),
    },
  }));
}

/** Neutral messages -> OpenAI messages. One neutral message can fan out to several. */
export function toApiMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const texts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of message.content) {
      if (block.type === "text") texts.push(block.text);
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        });
      }
      // "opaque" (Anthropic thinking) has no OpenAI equivalent — dropped.
    }

    if (message.role === "assistant") {
      const assistant = { role: "assistant", content: texts.join("\n") || null };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      if (assistant.content !== null || assistant.tool_calls) out.push(assistant);
    } else {
      // Tool results must precede any new user text so the call/result pairing
      // stays adjacent to the assistant turn that produced it.
      out.push(...toolResults);
      if (texts.length) out.push({ role: "user", content: texts.join("\n") });
    }
  }
  return out;
}

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw || "{}");
  } catch (err) {
    throw new Error(`OpenRouter returned unparseable tool arguments: ${String(raw).slice(0, 200)}`);
  }
}

export async function chat({ system, messages, tools, toolChoice, maxTokens, model }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: toApiMessages(system, messages),
  };
  if (tools?.length) body.tools = toApiTools(tools);
  if (toolChoice && toolChoice !== "auto") {
    body.tool_choice = { type: "function", function: { name: toolChoice.name } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  let json;
  try {
    res = await fetch(config.llm.openrouter.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.llm.openrouter.apiKey()}`,
        "Content-Type": "application/json",
        "X-Title": "Minute Maker",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    json = await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`OpenRouter request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || json.error) {
    throw new Error(
      `OpenRouter ${res.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 300)}`
    );
  }

  const choice = json.choices?.[0];
  if (!choice) throw new Error(`OpenRouter returned no choices: ${JSON.stringify(json).slice(0, 300)}`);

  return {
    text: String(choice.message?.content || "").trim(),
    toolCalls: (choice.message?.tool_calls || []).map((call) => ({
      id: call.id,
      name: call.function?.name,
      input: parseArguments(call.function?.arguments),
    })),
    stopReason: STOP_REASONS[choice.finish_reason] || "end",
    usage: {
      input: json.usage?.prompt_tokens || 0,
      output: json.usage?.completion_tokens || 0,
    },
    raw: json,
  };
}

export function assistantTurn(response) {
  const content = [];
  if (response.text) content.push({ type: "text", text: response.text });
  for (const call of response.toolCalls) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  }
  return { role: "assistant", content };
}
