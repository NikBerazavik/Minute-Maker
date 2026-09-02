import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Deterministic rendering: extraction JSON -> Notion block objects.
// No model output is interpreted here beyond the schema fields. The action
// item rollup and the per-topic bullets are both derived from the same
// `is_action_item` flag, so they cannot drift apart.
// ---------------------------------------------------------------------------

export const RICH_TEXT_LIMIT = 2000; // Notion: max chars per text object
export const BLOCKS_PER_REQUEST = 100; // Notion: max children per request

/** Split text into <= limit pieces, preferring newline then space boundaries. */
export function chunkText(text, limit = RICH_TEXT_LIMIT) {
  const s = String(text ?? "");
  if (s.length <= limit) return [s];
  const chunks = [];
  let remaining = s;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function chunkArray(arr, size = BLOCKS_PER_REQUEST) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const richText = (text) => chunkText(text).map((content) => ({ type: "text", text: { content } }));

export const heading2 = (text) => ({ object: "block", type: "heading_2", heading_2: { rich_text: richText(text) } });
export const paragraph = (text) => ({ object: "block", type: "paragraph", paragraph: { rich_text: richText(text) } });
export const bullet = (text) => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: richText(text) },
});

/** "content — owner, due X" for the rollup and for post-meeting action notes. */
export function actionLine({ content, action_owner, action_due }) {
  const owner = action_owner && String(action_owner).trim() ? String(action_owner).trim() : "TBA";
  const due = action_due && String(action_due).trim() ? `, due ${String(action_due).trim()}` : "";
  return `${String(content).trim()} — ${owner}${due}`;
}

/**
 * extraction = { summary, topics: [{ title, notes: [{ content, speaker,
 * is_action_item, action_owner, action_due }] }] }
 */
export function renderBlocks(extraction) {
  const blocks = [];
  const topics = Array.isArray(extraction?.topics) ? extraction.topics : [];

  blocks.push(heading2(config.text.summaryHeading));
  const summary = String(extraction?.summary || "").trim() || "(no summary produced)";
  for (const para of summary.split(/\n{2,}/)) blocks.push(paragraph(para.trim()));

  const actions = topics.flatMap((t) => (t.notes || []).filter((n) => n && n.is_action_item === true));
  if (actions.length) {
    blocks.push(heading2(config.text.actionsHeading));
    for (const n of actions) blocks.push(bullet(actionLine(n)));
  }

  for (const topic of topics) {
    const title = String(topic?.title || "General").trim() || "General";
    blocks.push(heading2(title));
    for (const n of topic.notes || []) {
      const content = String(n?.content || "").trim();
      if (content) blocks.push(bullet(content));
    }
  }

  return blocks;
}

/** A single post-meeting note as a bullet; action items carry owner/due inline. */
export function renderNoteBullet({ note, is_action_item, action_owner, action_due }) {
  const text = is_action_item ? actionLine({ content: note, action_owner, action_due }) : String(note).trim();
  return bullet(text);
}

/** Flatten Notion blocks back to readable text (for read_meeting). */
export function blocksToText(blocks) {
  const lines = [];
  for (const b of blocks) {
    const inner = b[b.type];
    const text = (inner?.rich_text || []).map((r) => r.plain_text ?? r.text?.content ?? "").join("");
    switch (b.type) {
      case "heading_1":
      case "heading_2":
        lines.push("", `## ${text}`);
        break;
      case "heading_3":
        lines.push("", `### ${text}`);
        break;
      case "bulleted_list_item":
      case "numbered_list_item":
        lines.push(`- ${text}`);
        break;
      case "paragraph":
        lines.push(text);
        break;
      default:
        if (text) lines.push(text);
    }
  }
  return lines.join("\n").trim();
}
