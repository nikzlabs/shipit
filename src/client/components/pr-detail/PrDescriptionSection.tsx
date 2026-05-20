/**
 * PrDescriptionSection — renders the PR body as markdown (read-only).
 *
 * The body markdown source already lives on the store (`pr.body`, populated
 * by the poller). Editing (pencil → Monaco) is docs/133 Phase 2 and not yet
 * wired here.
 */

import { MarkdownContent } from "../message-markdown.js";

export function PrDescriptionSection({ body }: { body?: string }) {
  const trimmed = (body ?? "").trim();
  return (
    <section className="px-4 py-3 border-b border-(--color-border-primary)">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary) mb-2">
        Description
      </h3>
      {trimmed.length > 0 ? (
        <div className="text-sm text-(--color-text-secondary)">
          <MarkdownContent text={trimmed} />
        </div>
      ) : (
        <p className="text-sm text-(--color-text-tertiary) italic">No description provided.</p>
      )}
    </section>
  );
}
