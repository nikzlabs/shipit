import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";

/**
 * Per-block top-margin size. We render each top-level mdast child in its own
 * `.prose` container; Tailwind Typography's `> :first-child { margin-top: 0 }`
 * rule zeros out the prose heading/paragraph margins inside it, so we restore
 * vertical rhythm with a wrapper margin chosen by block type. Headings get the
 * largest gap (section break), paragraphs get the smallest (tight inline
 * paragraph-after-content), everything else sits in between.
 */
export type BlockSpacing = "lg" | "md" | "sm";

export interface MarkdownBlock {
  /** Verbatim slice of the original markdown source that produced this block. */
  source: string;
  /** Flattened text — used to match selection-anchored comments to a block. */
  textContent: string;
  /** Top margin to apply to this block's wrapper (suppressed on the first block). */
  topSpacing: BlockSpacing;
}

export const TOP_MARGIN_CLASS: Record<BlockSpacing, string> = {
  lg: "mt-6",
  md: "mt-4",
  sm: "mt-2",
};

/**
 * Pick the wrapper top-margin for a top-level mdast block. Headings get a
 * section-break gap (depth 1–2 the largest, deeper headings smaller).
 * Paragraphs get the tightest gap so a heading + paragraph reads as a pair.
 * Lists, code, quotes, tables, and rules sit in the middle.
 */
export function topSpacingFor(node: RootContent): BlockSpacing {
  if (node.type === "heading") {
    return node.depth <= 2 ? "lg" : "md";
  }
  if (node.type === "paragraph") return "sm";
  return "md";
}

/** Flatten an mdast subtree to a plain text string for comment matching. */
export function mdastToText(node: RootContent | Root): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map(mdastToText).join("");
  }
  return "";
}

const docsParser = unified().use(remarkParse).use(remarkGfm);

/**
 * Split markdown into top-level blocks by parsing to mdast and slicing the
 * original source by each child's recorded offsets. Each slice round-trips
 * cleanly through react-markdown — re-parsing a top-level paragraph, heading,
 * list, or fenced code block in isolation produces the same render as parsing
 * the whole document, so block-by-block rendering preserves layout while
 * giving us stable wrappers to anchor comments against.
 */
export function splitIntoTopLevelBlocks(content: string): MarkdownBlock[] {
  const tree = docsParser.parse(content);
  const blocks: MarkdownBlock[] = [];
  for (const child of tree.children) {
    const start = child.position?.start.offset ?? 0;
    const end = child.position?.end.offset ?? content.length;
    blocks.push({
      source: content.slice(start, end),
      textContent: mdastToText(child),
      topSpacing: topSpacingFor(child),
    });
  }
  if (blocks.length === 0 && content.trim() !== "") {
    blocks.push({ source: content, textContent: content, topSpacing: "md" });
  }
  return blocks;
}
