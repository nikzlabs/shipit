import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents, shipitLinkComponents, urlTransform } from "../message-markdown.js";

const remarkPluginsDocs = [remarkGfm];

/**
 * Keep each top-level block stable for selection anchoring.
 *
 * `shipitLinks` opts the block into agent-authored pointers (docs/258 req 14)
 * and is **default off** — the same renderer draws repo markdown in the
 * file-preview dialog, which ShipIt did not author. Both component maps and the
 * transform are module constants, so the memo still holds.
 */
export const MarkdownBlock = memo(({ source, shipitLinks = false }: {
  source: string;
  shipitLinks?: boolean;
}) => (
  <div className="prose dark:prose-invert prose-sm max-w-none">
    <Markdown
      remarkPlugins={remarkPluginsDocs}
      components={shipitLinks ? shipitLinkComponents : markdownComponents}
      urlTransform={shipitLinks ? urlTransform : undefined}
      skipHtml
    >
      {source}
    </Markdown>
  </div>
));
MarkdownBlock.displayName = "MarkdownBlock";
