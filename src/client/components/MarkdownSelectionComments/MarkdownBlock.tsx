import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../message-markdown.js";

const remarkPluginsDocs = [remarkGfm];

/** Keep each top-level block stable for selection anchoring. */
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
