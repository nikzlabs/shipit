/**
 * PrDescriptionSection — renders the PR body as markdown, with inline editing
 * (docs/133 Phase 2).
 *
 * The body markdown source lives on the store (`pr.body`, populated by the
 * poller). When the PR is open, a pencil enters edit mode: a markdown-source
 * textarea with Save/Cancel. Saving calls `pr-store.updatePr`, which applies
 * the change optimistically and reverts on error (the failure surfaces in an
 * inline banner here).
 */

import { useState } from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { usePrStore } from "../../stores/pr-store.js";
import { MarkdownContent } from "../message-markdown.js";
import { Button } from "../ui/button.js";
import { Banner } from "../ui/banner.js";

export function PrDescriptionSection({
  sessionId,
  body,
  editable = false,
}: {
  sessionId: string;
  body?: string;
  editable?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = (body ?? "").trim();

  const startEditing = () => {
    setDraft(body ?? "");
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const err = await usePrStore.getState().updatePr(sessionId, { body: draft });
    setSubmitting(false);
    if (err) {
      setError(err);
      return;
    }
    setEditing(false);
  };

  return (
    <section className="px-4 py-3 border-b border-(--color-border-primary)">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
          Description
        </h3>
        {editable && !editing && (
          <button
            onClick={startEditing}
            className="flex h-6 w-6 items-center justify-center rounded text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
            aria-label="Edit description"
          >
            <PencilSimpleIcon size={ICON_SIZE.SM} />
          </button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Describe this pull request… (markdown supported)"
            rows={8}
            disabled={submitting}
            autoFocus
            className="w-full resize-y rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 font-mono text-sm text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus:border-(--color-border-focus) focus:outline-none disabled:opacity-50"
          />
          {error && (
            <Banner variant="error" className="rounded-md text-left">
              {error}
            </Banner>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="md" onClick={cancel} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" size="md" onClick={save} disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {trimmed.length > 0 ? (
            <div className="text-sm text-(--color-text-secondary)">
              <MarkdownContent text={trimmed} />
            </div>
          ) : (
            <p className="text-sm text-(--color-text-tertiary) italic">No description provided.</p>
          )}
        </>
      )}
    </section>
  );
}
