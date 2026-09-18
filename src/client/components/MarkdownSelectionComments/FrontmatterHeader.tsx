import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Badge } from "../ui/badge.js";
import type { ParsedFrontmatter } from "../../utils/markdown-frontmatter.js";
import { parseIssueRef, type ParsedIssueRef } from "../../../server/shared/issue-ref.js";
import type { ResolvedIssueRef } from "../../../server/shared/issue-ref-resolution.js";
import { useFileStore } from "../../stores/file-store.js";
import { resolveUiIssueRef, useIssuesStore } from "../../stores/issues-store.js";
import { useUiStore } from "../../stores/ui-store.js";

function IssueChip({ issueRef, resolved }: { issueRef: ParsedIssueRef; resolved: ResolvedIssueRef | null }) {
  if (resolved) {
    const tracker = resolved.tracker;
    return (
      <button
        type="button"
        title={`Open ${resolved.identifier} in ShipIt`}
        onClick={() => {
          // Dismiss a file preview that would cover the Issues tab.
          useFileStore.getState().closePreview();
          useUiStore.getState().setRightTab("issues");
          useUiStore.getState().setMobilePanel("preview");
          void useIssuesStore.getState().openIssue({
            tracker,
            identifier: resolved.identifier,
            id: resolved.issueId,
            ...(resolved.url ? { url: resolved.url } : {}),
          });
        }}
        className="inline-flex cursor-pointer"
      >
        <Badge variant="info" className="hover:brightness-110">
          {resolved.identifier}
        </Badge>
      </button>
    );
  }

  if (!issueRef.url) return <Badge variant="default">{issueRef.identifier}</Badge>;

  return (
    <a
      href={issueRef.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${issueRef.identifier} in the tracker`}
      className="inline-flex"
    >
      <Badge variant="info" className="inline-flex items-center gap-1 hover:brightness-110">
        {issueRef.identifier}
        <ArrowSquareOutIcon size={ICON_SIZE.XS} />
      </Badge>
    </a>
  );
}

export function FrontmatterHeader({ fm }: { fm: ParsedFrontmatter }) {
  const issueRef = fm.issue ? parseIssueRef(fm.issue) : null;
  const resolution = fm.issue ? resolveUiIssueRef(fm.issue) : null;
  const resolved = resolution?.ok ? resolution.ref : null;
  const hasContent = !!issueRef || !!fm.description || fm.extras.length > 0;
  if (!hasContent) return null;

  return (
    <div className="mb-4 pb-4 border-b border-(--color-border-secondary) space-y-2">
      {issueRef && (
        <div className="flex flex-wrap items-center gap-2">
          <IssueChip issueRef={issueRef} resolved={resolved} />
        </div>
      )}
      {fm.description && (
        <p className="text-sm text-(--color-text-secondary) italic">{fm.description}</p>
      )}
      {fm.extras.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          {fm.extras.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="text-(--color-text-tertiary) font-medium">{entry.key}</dt>
              <dd className="text-(--color-text-secondary) font-mono break-all">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
