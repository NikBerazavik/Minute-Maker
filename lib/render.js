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

// ---------------------------------------------------------------------------
// The Notes tier — Fireflies' own summary, rendered without a model.
//
// Everything below parses text a MODEL wrote for a human, not a schema. It is
// not validated the way lib/extract.js validates an LLM extraction, and a
// summary that arrives in an unexpected shape must still produce a usable page.
// So the rule for this whole section is: degrade, never throw. The worst
// outcome allowed is a thinner page, never a failed one.
//
// The shapes are the ones the live account actually returns:
//
//   action_items  "**Owner**\ntask (04:14)  \ntask (24:58)\n\n**Owner2**\n..."
//   notes         "## Topic\n\n- point (03:42)\n    - sub-point\n- point (05:45)"
//   short_summary a prose paragraph
//   overview      a list of "- **bold**" lines, not prose
// ---------------------------------------------------------------------------

const BULLET = /^\s*[-*•]\s+/;

/** Markdown emphasis reads as literal asterisks in Notion, so strip it. */
function stripMarkdown(line) {
  return String(line ?? "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/\s+$/, "") // Fireflies ends lines with two spaces (a hard break)
    .trim();
}

const isBlank = (line) => !String(line ?? "").trim();
const indentOf = (line) => (String(line).match(/^[ \t]*/)?.[0] || "").replace(/\t/g, "    ").length;

/**
 * "**Owner**" on its own line, tasks on the lines below it.
 *
 * A task appearing before any owner header keeps "TBA", matching what
 * normalizeExtraction does with an LLM action item that has no owner — the two
 * tiers must not disagree about what an unowned action looks like.
 */
export function parseFirefliesActionItems(text) {
  const items = [];
  let owner = "TBA";

  for (const raw of String(text ?? "").split("\n")) {
    if (isBlank(raw)) continue;
    const line = String(raw).trim().replace(/\s+$/, "");
    // A header is a line that is ENTIRELY bold: "**Thanachai Chuklin**".
    const header = line.match(/^\*\*(.+?)\*\*[:：]?$/);
    if (header) {
      owner = header[1].trim() || "TBA";
      continue;
    }
    const content = stripMarkdown(line);
    if (content) items.push({ content, owner });
  }
  return items;
}

/**
 * "## Topic" sections with (optionally nested) bullets under them.
 *
 * Anything before the first heading, or a field with no headings at all (the
 * shorthand_bullet fallback), lands in a leading section with `title: null`,
 * which renders as bullets with no heading rather than inventing one.
 */
export function parseFirefliesNotes(text) {
  const sections = [];
  let current = null;

  const section = (title) => {
    current = { title, items: [] };
    sections.push(current);
    return current;
  };

  for (const raw of String(text ?? "").split("\n")) {
    if (isBlank(raw)) continue;
    const heading = String(raw).match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      const title = stripMarkdown(heading[1]);
      if (title) section(title);
      continue;
    }

    const content = stripMarkdown(raw);
    if (!content) continue;
    if (!current) section(null);

    // An indented bullet belongs to the point above it. Only one level deep:
    // Notion allows more, but Fireflies has never produced more, and a deeper
    // tree read back through read_meeting would cost a request per level.
    const nested = BULLET.test(raw) && indentOf(raw) >= 2 && current.items.length > 0;
    if (nested) current.items.at(-1).children.push(content);
    else current.items.push({ content, children: [] });
  }

  return sections.filter((s) => s.items.length > 0 || s.title);
}

/** A bullet that may carry one level of children. */
export function nestedBullet(text, children = []) {
  const block = bullet(text);
  if (children.length) {
    block.bulleted_list_item.children = children.map((c) => bullet(c));
  }
  return block;
}

/**
 * Fireflies' summary text is sometimes prose and sometimes a bullet list
 * (`overview` is bullets on this account, `short_summary` is prose). Render
 * whichever it actually is rather than dumping "- **x**" into a paragraph.
 */
function summarySection(text) {
  const lines = String(text ?? "")
    .split("\n")
    .filter((l) => !isBlank(l));
  if (lines.length === 0) return [];

  const bulletish = lines.filter((l) => BULLET.test(l)).length;
  if (bulletish >= Math.ceil(lines.length / 2)) {
    return lines.map((l) => bullet(stripMarkdown(l))).filter((b) => b.bulleted_list_item.rich_text.length);
  }
  return String(text)
    .split(/\n{2,}/)
    .map((para) => stripMarkdown(para.split("\n").join(" ")))
    .filter(Boolean)
    .map((para) => paragraph(para));
}

/**
 * The Notes page body. Structurally identical to an LLM page on purpose —
 * same Summary heading, same Action items rollup, same one-heading-per-topic
 * shape — so the two tiers produce pages that read and search the same way.
 *
 * Returns [] when there is nothing at all to render, which the caller treats
 * as "Fireflies has not finished summarising yet".
 */
export function renderNotesBlocks({ summary, actionItems, notes } = {}) {
  const blocks = [];

  const summaryBlocks = summarySection(summary);
  if (summaryBlocks.length) {
    blocks.push(heading2(config.text.summaryHeading));
    blocks.push(...summaryBlocks);
  }

  const actions = parseFirefliesActionItems(actionItems);
  if (actions.length) {
    blocks.push(heading2(config.text.actionsHeading));
    // actionLine() is the LLM tier's formatter. Reused rather than reimplemented
    // so an action bullet cannot come out differently depending on the tier.
    for (const a of actions) {
      blocks.push(bullet(actionLine({ content: a.content, action_owner: a.owner, action_due: null })));
    }
  }

  for (const section of parseFirefliesNotes(notes)) {
    if (section.title) blocks.push(heading2(section.title));
    for (const item of section.items) blocks.push(nestedBullet(item.content, item.children));
  }

  return blocks;
}

/** Flatten Notion blocks back to readable text (for read_meeting). */
export function blocksToText(blocks, indent = "") {
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
        lines.push(`${indent}- ${text}`);
        break;
      case "paragraph":
        lines.push(text);
        break;
      default:
        if (text) lines.push(text);
    }
    // Notes-tier pages nest one level. listChildren({ withChildren: true })
    // attaches them here; without that they simply are not present.
    if (b._children?.length) lines.push(blocksToText(b._children, `${indent}  `));
  }
  // Only the top-level call trims: trimming a nested call would strip the very
  // indent that makes the child a child.
  return indent ? lines.join("\n") : lines.join("\n").trim();
}
