/**
 * The "Start session" call-to-action shared by the Issues list rows and the
 * inline issue detail footer (docs/170). Both seed a ShipIt session from an
 * issue, so they share one button: the `cta` Button variant by default (a
 * subtle accent tint that fills to solid on hover — calm enough to repeat on
 * every list row) plus a rocket that lifts off on hover. The detail footer
 * overrides `variant` to solid `primary`, since there it's the single main
 * action rather than one of many list rows. Centralized so the rocket and
 * sizing treatment can't drift between the two surfaces.
 *
 * Sized with the standard `md` (32px) so it lines up with every other text
 * button in the app — no bespoke height override anymore. Only the `cta`
 * variant and the rocket animation are particular to this button.
 *
 * ## Repository picker (docs/236)
 *
 * When more than one repo is registered the button becomes a **split control**:
 * the main half starts in the default repo (one click, exactly as before) and a
 * caret half opens a menu of every repo so the user can start the issue in a
 * *different* one. A declared tracker is frequently a planning repository or a
 * Linear team shared across projects (docs/248), so the issue you want to work
 * on often belongs to a repo other than the session you're sitting in; without
 * this the user has to switch repos in the sidebar, open a new session, come
 * back to the Issues tab and find the issue again.
 *
 * The caret is a separate `<Button>` rather than a wrapping menu so the primary
 * action keeps its single-click cost — the picker is the deliberate detour, not
 * the default path.
 */

import type { MouseEvent } from "react";
import { CaretDownIcon, RocketLaunchIcon } from "@phosphor-icons/react";
import { Button, type ButtonProps } from "./ui/button.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "./ui/dropdown-menu.js";
import { parseRepoName } from "../utils/repo-label.js";
import { cn } from "../utils/cn.js";
import type { RepoInfo } from "../../server/shared/types.js";

export function StartSessionButton({
  label = "Start session",
  disabled,
  title,
  onClick,
  className,
  variant = "cta",
  repos,
  targetRepoUrl,
  onStartInRepo,
}: {
  /** Button text — the detail footer uses a longer "…from this issue" form. */
  label?: string;
  disabled?: boolean;
  title?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Layout-only classes from the call site (e.g. row width / grid placement). */
  className?: string;
  /**
   * Button emphasis. Defaults to the calm `cta` used down the Issues list; the
   * detail footer overrides to solid `primary` since it's the main action there.
   */
  variant?: ButtonProps["variant"];
  /**
   * Repos offered in the picker. The caret half only renders when there are at
   * least two (with one repo there is nothing to choose) and `onStartInRepo` is
   * wired, so every existing call site keeps today's plain-button rendering.
   */
  repos?: RepoInfo[];
  /** The repo the plain click starts in — checkmarked in the menu. */
  targetRepoUrl?: string;
  /** Start in an explicitly chosen repo instead of {@link targetRepoUrl}. */
  onStartInRepo?: (repoUrl: string) => void;
}) {
  const showPicker = Boolean(onStartInRepo) && (repos?.length ?? 0) > 1;

  const main = (
    <Button
      variant={variant}
      // Standard `md` height (32px) so this lines up with every other text
      // button. In the Issues list the action cell centers the button on the
      // row's first-line baseline regardless of its height, so it still aligns.
      size="md"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn("group/ss", showPicker ? "flex-1 rounded-r-none" : className)}
    >
      <RocketLaunchIcon
        size={16}
        className="transition-transform duration-200 ease-out group-hover/ss:-translate-y-0.5 group-hover/ss:translate-x-0.5"
      />
      {label}
    </Button>
  );

  if (!showPicker) return main;

  return (
    // Layout classes from the call site move to the wrapper — the two halves
    // size themselves inside it (the main half flexes, the caret stays snug).
    <div className={cn("inline-flex items-stretch", className)}>
      {main}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size="md"
            disabled={disabled}
            aria-label="Start session in another repository"
            title="Start session in another repository"
            // `-ml-px` collapses the two borders of the `cta` variant into one
            // shared edge; the inset shadow draws the divider for variants that
            // have no border of their own (e.g. solid `primary`).
            className="rounded-l-none -ml-px px-1.5 shadow-[inset_1px_0_0_0_color-mix(in_oklab,currentColor_25%,transparent)]"
            onClick={(e) => e.stopPropagation()}
          >
            <CaretDownIcon size={12} weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56"
          // The Issues list row is itself a click target (it opens the detail
          // view); without this a click that lands on the menu bubbles up and
          // navigates away underneath the user.
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuLabel>Start session in</DropdownMenuLabel>
          {repos?.map((repo) => {
            const isTarget = repo.url === targetRepoUrl;
            const cloning = repo.status === "cloning";
            return (
              <DropdownMenuItem
                key={repo.url}
                disabled={cloning}
                onSelect={() => onStartInRepo?.(repo.url)}
                className={isTarget ? "text-(--color-text-primary)" : "text-(--color-text-secondary)"}
              >
                <span className={`w-3 text-center ${isTarget ? "text-(--color-success)" : "opacity-0"}`}>
                  ✓
                </span>
                <span className="truncate flex-1 text-left">{parseRepoName(repo.url)}</span>
                {cloning && (
                  <span className="text-[9px] text-(--color-warning) animate-pulse">cloning</span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
