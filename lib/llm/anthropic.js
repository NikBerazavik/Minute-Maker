import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Anthropic Messages API adapter. Raw fetch, no SDK — same posture as the rest
// of this project (zero runtime dependencies).
// ---------------------------------------------------------------------------

const ENDPOINT = "https://api.anthropic.com/v1/messages";

// Netlify background functions get 15 minutes; fail well before that so the
// error surfaces as a Telegram alert rather than a silent function timeout.
const REQUEST_TIMEOUT_MS = 8 * 60 * 1000;

// Transient failures — rate limits, overload, a flaky gateway — are retried
// rather than failing a recap. Attempts stop once this much time has passed,
// so the retries can never push a run past the background budget.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;
const RETRY_BUDGET_MS = 4 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 1000;

const STOP_REASONS = {
  end_turn: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  stop_sequence: "end",
  pause_turn: "end",
};

/**
 * Forced tool use (`tool_choice: {type:"tool"}`) returns 400 on Fable/Mythos
 * and on Opus 5.5 and Sonnet 5.5. Haiku 5.5, Sonnet 5, Opus 5 and the 4.x
 * models accept it. A model this list does not know about is still covered:
 * chat() downgrades to auto and retries once if the API rejects the choice.
 */
export function supportsForcedToolChoice(model) {
  return !/^claude-(fable|mythos|opus-5-5|sonnet-5-5)/.test(String(model || ""));
}

/**
 * `output_config.effort` arrived with Opus 4.5 and errors on the models before
 * it. Unknown (newer) models are assumed to support it.
 */
export function supportsEffort(model) {
  return !/^claude-(3|haiku-4|sonnet-4-5|sonnet-4-2|opus-4-1|opus-4-2)/.test(String(model || ""));
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
      case "image":
        out.push({ type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } });
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

class AnthropicError extends Error {
  constructor(status, message, retryAfterMs) {
    super(`Anthropic ${status}: ${message}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One HTTP attempt. Throws AnthropicError on a non-2xx, with any Retry-After. */
async function post(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  let text;
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
    text = await res.text();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Anthropic request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // An overloaded gateway can answer with HTML, so never assume JSON.
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // handled below
  }

  if (!res.ok || !json) {
    // Number(null) is 0, so an absent header must not read as "retry now".
    const header = res.headers.get("retry-after");
    const retryAfter = header === null ? NaN : Number(header);
    throw new AnthropicError(
      res.status,
      json?.error?.message || String(text || "").slice(0, 300) || "(empty body)",
      Number.isFinite(retryAfter) ? retryAfter * 1000 : null
    );
  }
  return json;
}

/** post() with retries on rate limits, overload and network errors. */
async function send(body) {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await post(body);
    } catch (err) {
      const retryable = err instanceof AnthropicError ? RETRY_STATUSES.has(err.status) : err.name === "TypeError";
      const delay = Math.min(err.retryAfterMs ?? 2000 * 4 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      if (!retryable || attempt >= MAX_ATTEMPTS || Date.now() - started + delay > RETRY_BUDGET_MS) throw err;
      console.warn(`${err.message} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS}).`);
      await sleep(delay);
    }
  }
}

export async function chat({ system, messages, tools, toolChoice, maxTokens, model, thinking, effort }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages.map((m) => ({ role: m.role, content: toApiContent(m.content) })),
  };
  // "adaptive" lets the API decide thinking depth, but older models (Claude
  // 4.x Haiku) 400 on it — which is why the extraction tiers carry their own
  // mode. A per-request value wins over the global; the global still covers
  // the chat loop and anything that does not specify one.
  const think = thinking ?? config.llm.thinking;
  if (think && think !== "off") body.thinking = { type: think };
  if (effort && supportsEffort(model)) body.output_config = { effort };
  if (system) body.system = system;
  if (tools?.length) body.tools = toApiTools(tools);

  if (toolChoice && toolChoice !== "auto") {
    if (supportsForcedToolChoice(model)) {
      body.tool_choice = { type: "tool", name: toolChoice.name };
    } else {
      // Forced choice 400s here. Fall back to auto — extract.js also names the
      // tool in its prompt, and throws if no call comes back.
      body.tool_choice = { type: "auto" };
      console.warn(`Model ${model} rejects forced tool_choice; using auto for "${toolChoice.name}".`);
    }
  }

  let json;
  try {
    json = await send(body);
  } catch (err) {
    // A model newer than supportsForcedToolChoice() knows about: downgrade to
    // auto once rather than failing the recap on a request shape.
    if (!(err instanceof AnthropicError && err.status === 400 && body.tool_choice?.type === "tool" && /tool_choice/.test(err.message))) {
      throw err;
    }
    console.warn(`Model ${model} rejected forced tool_choice; retrying with auto for "${body.tool_choice.name}".`);
    json = await send({ ...body, tool_choice: { type: "auto" } });
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
