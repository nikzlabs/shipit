import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Badge } from "../ui/badge.js";
import type { ParsedFrontmatter } from "../../utils/markdown-frontmatter.js";
import { parseIssueRef } from "../../../server/shared/issue-ref.js";

/**
 * Frontmatter header. docs/168 removed the status/priority badges — priority
 * and work-status now live in the issue tracker, not the doc. What remains is
 * the optional `issue:` pointer, rendered as a jump-to-issue chip, plus the
 * description and any other extras.
 */
export function FrontmatterHeader({ fm }: { fm: ParsedFrontmatter }) {
  const issueRef = fm.issue ? parseIssueRef(fm.issue) : null;
  const hasContent = !!issueRef || !!fm.description || fm.extras.length > 0;
  if (!hasContent) return null;

  return (
    <div className="mb-4 pb-4 border-b border-(--color-border-secondary) space-y-2">
      {issueRef && (
        <div className="flex flex-wrap items-center gap-2">
          {issueRef.url ? (
            <a
              href={issueRef.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${issueRef.identifier} in ${issueRef.tracker === "unknown" ? "the tracker" : issueRef.tracker}`}
              className="inline-flex"
            >
              <Badge variant="info" className="inline-flex items-center gap-1 hover:brightness-110">
                {issueRef.identifier}
                <ArrowSquareOutIcon size={ICON_SIZE.XS} />
              </Badge>
            </a>
          ) : (
            <Badge variant="default">{issueRef.identifier}</Badge>
          )}
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
