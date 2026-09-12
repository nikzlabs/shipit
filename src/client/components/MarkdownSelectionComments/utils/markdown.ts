import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";

export type BlockSpacing = "lg" | "md" | "sm";

export interface MarkdownBlock {
  source: string;
  textContent: string;
  topSpacing: BlockSpacing;
}

export const TOP_MARGIN_CLASS: Record<BlockSpacing, string> = {
  lg: "mt-6",
  md: "mt-4",
  sm: "mt-2",
};

export function topSpacingFor(node: RootContent): BlockSpacing {
  if (node.type === "heading") {
    return node.depth <= 2 ? "lg" : "md";
  }
  if (node.type === "paragraph") return "sm";
  return "md";
}

export function mdastToText(node: RootContent | Root): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map(mdastToText).join("");
  }
  return "";
}

const docsParser = unified().use(remarkParse).use(remarkGfm);

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
