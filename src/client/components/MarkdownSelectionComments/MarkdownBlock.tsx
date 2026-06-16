import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../message-markdown.js";

/**
 * Shared remark plugin stack for the docs viewer. `remark-gfm` is the superset
 * we render (tables, task lists, strikethrough). We deliberately don't add
 * `rehype-slug` / `rehype-autolink-headings` — the docs viewer has no UI for
 * deep-linking to sections, so the heading ids and wrapping anchors would
 * just be dead DOM weight.
 */
const remarkPluginsDocs = [remarkGfm];

/**
 * Memoised wrapper around a single rendered markdown block. The wrapper exists
 * so selection-anchored comment positioning has a stable container per
 * top-level block: `offsetWithin` walks text nodes from the document root and
 * `commentsByBlock` slots each comment after the block whose flat text
 * contains it. We memoise on the source slice so streaming-style re-renders of
 * an unrelated block don't reconcile this one's text nodes — the same
 * property that lets the chat survive without the freeze hack now keeps the
 * docs viewer's mid-selection rendering stable too.
 */
export const MarkdownBlock = memo(({ source }: { source: string }) => (
  <div className="prose dark:prose-invert prose-sm max-w-none">
    <Markdown
      remarkPlugins={remarkPluginsDocs}
      components={markdownComponents}
      skipHtml
    >
      {source}
    </Markdown>
  </div>
));
MarkdownBlock.displayName = "MarkdownBlock";
