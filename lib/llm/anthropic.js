import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Anthropic Messages API adapter. Raw fetch, no SDK — same posture as the rest
// of this project (zero runtime dependencies).
// ---------------------------------------------------------------------------

const ENDPOINT = "https://api.anthropic.com/v1/messages";

// Netlify background functions get 15 minutes; fail well before that so the
// error surfaces as a Telegram alert rather than a silent function timeout.
const REQUEST_TIMEOUT_MS = 8 * 60 * 1000;

const STOP_REASONS = {
  end_turn: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  stop_sequence: "end",
  pause_turn: "end",
};

/**
 * Forced tool use (`tool_choice: {type:"tool"}`) returns 400 on Fable-class
 * models. Everything else this project would plausibly run (Sonnet 5, Opus 5,
 * Haiku 4.5) accepts it. Detect rather than hard-code, so swapping LLM_MODEL
 * cannot silently break extraction.
 */
export function supportsForcedToolChoice(model) {
  return !/^claude-(fable|mythos)/.test(String(model || ""));
}

function toApiTools(tools = []) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(t.strict ? { strict: true } : {}),
  }));
}

function toApiContent(content) {
  if (typeof content === "string") return content;
  const out = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;
      case "tool_use":
        out.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        break;
      case "tool_result":
        out.push({ type: "tool_result", tool_use_id: block.tool_use_id, content: block.content });
        break;
      case "opaque":
        // Thinking blocks and anything else the API produced. Replayed byte
        // for byte — editing them invalidates the signature.
        out.push(block._raw);
        break;
      default:
        throw new Error(`anthropic adapter: unsupported neutral block "${block.type}"`);
    }
  }
  return out;
}

function toNeutralBlocks(apiContent = []) {
  return apiContent.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") {
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    }
    return { type: "opaque", _raw: block };
  });
}

export async function chat({ system, messages, tools, toolChoice, maxTokens, model }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages.map((m) => ({ role: m.role, content: toApiContent(m.content) })),
  };
  // "adaptive" lets the API decide thinking depth, but it is a Claude-5-family
  // parameter: older models 400 on it. LLM_THINKING=off covers that case.
  if (config.llm.thinking !== "off") body.thinking = { type: config.llm.thinking };
  if (system) body.system = system;
  if (tools?.length) body.tools = toApiTools(tools);

  let forcedToolName = null;
  if (toolChoice && toolChoice !== "auto") {
    forcedToolName = toolChoice.name;
    if (supportsForcedToolChoice(model)) {
      body.tool_choice = { type: "tool", name: forcedToolName };
    } else {
      // Fable/Mythos: forced choice 400s. Fall back to auto — extract.js also
      // names the tool in its prompt, and throws if no call comes back.
      body.tool_choice = { type: "auto" };
      console.warn(`Model ${model} rejects forced tool_choice; using auto for "${forcedToolName}".`);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  let json;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": config.llm.anthropic.apiKey(),
        "anthropic-version": config.llm.anthropic.apiVersion,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    json = await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Anthropic request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 300)}`);
  }

  const content = json.content || [];
  return {
    text: content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim(),
    toolCalls: content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input })),
    stopReason: STOP_REASONS[json.stop_reason] || "end",
    usage: { input: json.usage?.input_tokens || 0, output: json.usage?.output_tokens || 0 },
    raw: json,
  };
}

export function assistantTurn(response) {
  return { role: "assistant", content: toNeutralBlocks(response.raw.content || []) };
}
