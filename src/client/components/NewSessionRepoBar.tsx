import { useMemo, useRef, useState } from "react";
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Dialog, DialogOverlay, DialogPanel, DialogPortal, DialogTitle } from "./ui/dialog.js";
import { groupBandFill } from "./SessionSidebar/SessionGroup.js";
import { repoColorVar } from "../../server/shared/repo-colors.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { RepoInfo } from "../../server/shared/types.js";

/**
 * docs/259 — the new-session screen's answer to "which repo am I in?".
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
 * Every viewport (req 1). The desktop sidebar names the repo as well, but it is
 * across the window from the composer the user is typing in, and the bar is the
 * switcher too (req 3). The only thing the viewport changes is the picker's
 * shape: a bottom sheet under 768px (`useIsMobile`'s boundary, so `md:` is the
 * desktop side), a centered card above it.
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

  // Where focus should land when the sheet opens: the row for the repo we're
  // already in, which is the natural place to start from and the one Radix's
  // default (first tabbable) would only reach by accident.
  const initialRowRef = useRef<HTMLButtonElement | null>(null);
  // And where it goes back to on close. Radix restores to whatever was focused
  // when the sheet opened, which is the bar only where a click focuses a button
  // — true in Chrome and Firefox, not in Safari, where it would land on <body>
  // and restart the next Tab at the top of the document. Naming the target
  // makes the restore the same on every browser.
  const barRef = useRef<HTMLButtonElement | null>(null);

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
        ref={barRef}
        data-testid="new-session-repo-bar"
        onClick={() => setPickerOpen(true)}
        aria-label={`New session in ${repoSlug} — change repository`}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        // `min-h-11` is the app's 44px mobile touch floor (see MicButton) — the
        // padding alone lands at 41px, which is under it. From `md:` up there is
        // no touch floor to respect and there IS a row to line up with: the bar
        // sits at the top of the chat panel, level with the sidebar header and
        // the right panel's tab strip, both of which are `h-10.25` (41px). At
        // 44px it overhung both by 3px, so the three top borders did not meet.
        // Fixed height rather than `min-h`, since the content is one line.
        className="flex min-h-11 w-full items-center gap-2 border-b border-(--color-border-primary) bg-(--color-bg-primary) px-3 py-2.5 text-left md:h-10.25 md:min-h-0"
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

      {/* `DialogPanel` is the raw Radix content: the focus trap, the restore of
          focus to the bar on close, Escape and outside-pointer dismissal, with
          no layout of its own. `DialogContent` is not used because it is
          fullscreen under `md:` — a whole screen for a three-row repo list — and
          the previous answer, a hand-rolled `role="dialog" aria-modal` div, was
          a modal claim Tab could walk out of. Shape is bespoke, behaviour is
          not. The `Dialog` wrapper adds Back-button dismissal on top.

          Bottom sheet under `md:`, centered card at and above it: a list
          anchored to the bottom edge of a wide window reads as a mobile
          surface left switched on.

          The open state is Radix's to unmount (`DialogPortal` renders nothing
          when closed), NOT a `{pickerOpen && …}` guard around the root. A guard
          there tears the whole tree out the instant the state flips, so the
          focus scope never gets to run `onCloseAutoFocus` and focus is left on
          `<body>` — the exact defect this rewrite exists to fix. */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPanel
            // Radix warns without one, and the visible heading is the honest
            // name — better than an `aria-label` saying something else.
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              // Land on the current repo's row rather than Radix's default
              // (the first tabbable), and never on the obscured bar behind.
              if (!initialRowRef.current) return;
              e.preventDefault();
              initialRowRef.current.focus();
            }}
            onCloseAutoFocus={(e) => {
              if (!barRef.current) return;
              e.preventDefault();
              barRef.current.focus();
            }}
            className="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-xl border-t border-(--color-border-secondary) bg-(--color-bg-elevated) pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-72 md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:pb-3 md:shadow-2xl"
          >
            <DialogTitle className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
              Start this session in
            </DialogTitle>
            {pickable.map((r, i) => {
              const label = parseRepoLabel(r.url);
              // Identity by URL, not by label. `parseRepoLabel` truncates a
              // repo name at its first dot (`owner/api.v1` and `owner/api.v2`
              // both render as `owner/api`), so a label comparison would mark
              // BOTH rows selected and then refuse to switch to either. The
              // label is only the fallback for the window before the repo
              // list has loaded and `repo` is still undefined.
              const selected = repo ? r.url === repo.url : label === repoSlug;
              const swatch = r.colorIndex !== undefined ? repoColorVar(r.colorIndex) : undefined;
              return (
                <button
                  key={r.url}
                  type="button"
                  // The selected row is where focus lands on open; with
                  // nothing resolved yet, the first row is.
                  ref={selected || (!repo && i === 0) ? initialRowRef : undefined}
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
          </DialogPanel>
        </DialogPortal>
      </Dialog>
    </>
  );
}
