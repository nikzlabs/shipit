/**
 * SecretBlockBanner — docs/213 / planning#317.
 *
 * Sits above the composer for as long as the session's auto-commit is refused
 * because a likely credential is in the working tree, and disappears the moment
 * a commit lands.
 *
 * It exists because the refusal's original surface — a single persisted chat
 * notice — was reliably missed: it renders with the weight of any other row, so
 * a block announced before a few long agent turns is buried, while *every* turn
 * after it silently fails to commit too (`autoCommit` re-stages the whole tree,
 * so one flagged line stops the branch advancing at all). The state has to be
 * the thing on screen, not the announcement of it.
 *
 * Deliberately has no dismiss control. The banner is not a notification; it is
 * the rendering of a live, blocking condition, and the only way out is to make
 * the condition false.
 */

import { useSessionStore } from "../stores/session-store.js";
import { WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

export function SecretBlockBanner() {
  const block = useSessionStore((s) => s.secretBlock);
  if (!block || block.findings.length === 0) return null;

  const { findings } = block;
  const noun = findings.length === 1 ? "a likely secret" : `${findings.length} likely secrets`;

  return (
    <div className="mx-4 last:mb-2">
      <div
        role="status"
        className="flex items-start gap-2 px-3 py-2 rounded-lg border border-(--color-warning) bg-(--color-bg-secondary) text-xs"
      >
        <WarningIcon size={ICON_SIZE.SM} className="text-(--color-warning) shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-(--color-text-secondary)">
            Commits are blocked — {noun} in your changes
          </div>
          <div className="mt-1 text-(--color-text-tertiary) font-mono text-[10px] leading-tight">
            {findings.map((f) => (
              <div key={`${f.rule}:${f.file}:${f.line ?? ""}`} className="break-all">
                • {f.line ? `${f.file}:${f.line}` : f.file} — {f.description} ({f.redacted})
              </div>
            ))}
          </div>
          <div className="mt-1 text-(--color-text-tertiary) break-words">
            Nothing has been committed or pushed since — including later, unrelated work.
            Remove the credential (use an environment variable or a ShipIt secret) and the
            next turn commits everything at once. If it&rsquo;s a false positive, add a{" "}
            <code className="font-mono">gitleaks:allow</code> comment to that line.
          </div>
        </div>
      </div>
    </div>
  );
}
