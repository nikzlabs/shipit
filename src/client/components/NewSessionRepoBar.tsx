import { useMemo, useState } from "react";
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Dialog } from "./ui/dialog.js";
import { groupBandFill } from "./SessionSidebar/SessionGroup.js";
import { repoColorVar } from "../../server/shared/repo-colors.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { RepoInfo } from "../../server/shared/types.js";

/**
 * docs/259 — the mobile new-session screen's answer to "which repo am I in?".
 *
 * Tapping `+` on the mobile tab bar starts a session in a repo the app picked
 * IMPLICITLY (the current session's repo, else the active repo) and lands on
 * `/repo/{owner}/{repo}/new`. There, the sessions drawer is closed, mobile
 * browsers hide the URL, and `showNewSessionView` suppresses the PR lifecycle
 * card — so nothing on screen named the repo and the implicit pick was
 * unverifiable (reqs 1, 2) and uncorrectable without backing out through the
 * drawer (req 3).
 *
 * This bar takes exactly the slot `PrLifecycleCard` occupies. The two are
 * mutually exclusive by construction — the PR card's own condition includes
 * `!showNewSessionView` — so the slot has one occupant at a time and the
 * handover on graduation is automatic, costing no steady-state vertical space.
 *
 * Mobile only. The desktop already answers the question in its always-visible
 * sidebar, where the group for this repo renders its `New session` row selected.
 */
export function NewSessionRepoBar({
  repoSlug,
  repo,
  repos,
  onSelectRepo,
}: {
  /**
   * The `owner/repo` slug from the route. Always available (it's parsed
   * straight from the pathname), unlike {@link repo}, which is `undefined`
   * until the repo list loads — so the bar names the repo from the very first
   * frame instead of flashing empty.
   */
  repoSlug: string;
  /** The matching repo record, once the list has loaded. Supplies the color. */
  repo: RepoInfo | undefined;
  /** Every known repo, for the picker. */
  repos: RepoInfo[];
  /** Start a new session in a different repo (App's `handleNewSessionForRepo`). */
  onSelectRepo: (repoUrl: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  // docs/254 — `colorIndex` is undefined only for a row written before that
  // migration's backfill. Such a repo gets no edge and no band rather than an
  // arbitrary color, which is the same fallback the sidebar group header takes.
  const color = repo?.colorIndex !== undefined ? repoColorVar(repo.colorIndex) : undefined;

  // docs/222 — a hidden repo is out of the sidebar, so it stays out of this
  // picker too. The one exception is the repo we're currently in: it must be
  // listed (and checked) even when hidden, or the picker would claim the user
  // is somewhere they're not.
  const pickable = useMemo(
    () => repos.filter((r) => !r.hidden || r.url === repo?.url),
    [repos, repo?.url],
  );

  return (
    <>
      <button
        type="button"
        data-testid="new-session-repo-bar"
        onClick={() => setPickerOpen(true)}
        aria-label={`New session in ${repoSlug} — change repository`}
        className="flex w-full items-center gap-2 border-b border-(--color-border-primary) bg-(--color-bg-primary) px-3 py-2.5 text-left"
        style={{
          ...(color
            ? { borderLeftWidth: 3, borderLeftStyle: "solid", borderLeftColor: color, backgroundColor: groupBandFill(color) }
            : {}),
        }}
      >
        <span className="shrink-0 text-xs text-(--color-text-tertiary)">New session in</span>
        <span className="min-w-0 truncate text-sm font-semibold text-(--color-text-primary)">
          {repoSlug}
        </span>
        <CaretRightIcon size={ICON_SIZE.SM} className="ml-auto shrink-0 text-(--color-text-tertiary)" />
      </button>

      {/* Wrapped in the shared Dialog purely to inherit Back-button dismissal,
          the same way QuickCaptureOverlay does: the wrapper pushes a history
          entry and maps Back → onOpenChange(false). The bottom-sheet layout is
          kept bespoke rather than forced into DialogContent's fullscreen-on-
          mobile mold — a three-row repo list does not warrant a whole screen. */}
      {pickerOpen && (
        <Dialog open onOpenChange={(o) => { if (!o) setPickerOpen(false); }}>
          <div
            role="dialog"
            aria-label="Choose a repository"
            className="fixed inset-0 z-50 flex flex-col justify-end bg-(--color-bg-overlay)"
            onClick={(e) => {
              if (e.target === e.currentTarget) setPickerOpen(false);
            }}
          >
            <div className="max-h-[70vh] overflow-y-auto rounded-t-xl border-t border-(--color-border-secondary) bg-(--color-bg-elevated) pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
              <h2 className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
                Start this session in
              </h2>
              {pickable.map((r) => {
                const label = parseRepoLabel(r.url);
                const selected = label === repoSlug;
                const swatch = r.colorIndex !== undefined ? repoColorVar(r.colorIndex) : undefined;
                return (
                  <button
                    key={r.url}
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      setPickerOpen(false);
                      // Re-picking the repo we're already in would otherwise
                      // re-claim a session and reset the view — including the
                      // draft the user just typed. Closing is the whole action.
                      if (!selected) onSelectRepo(r.url);
                    }}
                    className={`flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm ${
                      selected ? "bg-(--color-accent-subtle)" : "active:bg-(--color-bg-hover)"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-(--color-text-tertiary)"
                      style={swatch ? { backgroundColor: swatch } : undefined}
                    />
                    <span className="min-w-0 truncate text-(--color-text-primary)">{label}</span>
                    {selected && (
                      <CheckIcon size={ICON_SIZE.SM} className="ml-auto shrink-0 text-(--color-accent)" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
