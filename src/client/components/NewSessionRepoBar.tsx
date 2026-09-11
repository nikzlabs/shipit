import { useMemo, useRef, useState } from "react";
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Dialog, DialogOverlay, DialogPanel, DialogPortal, DialogTitle } from "./ui/dialog.js";
import { groupBandFill } from "./SessionSidebar/SessionGroup.js";
import { repoColorVar } from "../../server/shared/repo-colors.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { RepoInfo } from "../../server/shared/types.js";

export function NewSessionRepoBar({
  repoSlug,
  repo,
  repos,
  onSelectRepo,
}: {

  repoSlug: string;

  repo: RepoInfo | undefined;

  repos: RepoInfo[];

  onSelectRepo: (repoUrl: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const initialRowRef = useRef<HTMLButtonElement | null>(null);

  const barRef = useRef<HTMLButtonElement | null>(null);

  const color = repo?.colorIndex !== undefined ? repoColorVar(repo.colorIndex) : undefined;

  // picker too. The one exception is the repo we're currently in: it must be

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

            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {

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

              const selected = repo ? r.url === repo.url : label === repoSlug;
              const swatch = r.colorIndex !== undefined ? repoColorVar(r.colorIndex) : undefined;
              return (
                <button
                  key={r.url}
                  type="button"

                  ref={selected || (!repo && i === 0) ? initialRowRef : undefined}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => {
                    setPickerOpen(false);

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
