import { CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useRepoStore } from "../stores/repo-store.js";
import { REPO_COLOR_COUNT, REPO_COLOR_NAMES, repoColorVar } from "../../server/shared/repo-colors.js";

/**
 * docs/254 — pick the identity color for a repo's sidebar group.
 *
 * The swatches render the same `--repo-color-N` custom properties the sidebar
 * edge uses, so what you pick here is literally what the rail draws — including
 * the theme's own light/dark mapping. Selection writes through the store's
 * optimistic `setRepoColorIndex`, so the edge in the sidebar behind this dialog
 * changes on click rather than on save; there is no separate save step.
 */
export function RepoColorPicker({ repoUrl }: { repoUrl: string }) {
  const repo = useRepoStore((s) => s.repos.find((r) => r.url === repoUrl));
  const setRepoColorIndex = useRepoStore((s) => s.setRepoColorIndex);
  const selected = repo?.colorIndex;

  return (
    <div className="space-y-3" data-testid="repo-color-picker">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Sidebar color</h3>
        <p className="text-xs text-(--color-text-secondary)">
          The colored edge marking this repository&apos;s group in the session sidebar. Each repo gets a
          different color automatically — change it here if you&apos;d rather pick your own.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Sidebar color"
        className="grid grid-cols-8 gap-2 max-w-md"
      >
        {Array.from({ length: REPO_COLOR_COUNT }, (_, index) => {
          const isSelected = selected === index;
          return (
            <button
              key={index}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={REPO_COLOR_NAMES[index]}
              title={REPO_COLOR_NAMES[index]}
              data-testid={`repo-color-${index}`}
              onClick={() => { void setRepoColorIndex(repoUrl, index); }}
              className={`h-8 rounded-md flex items-center justify-center transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus) ${
                isSelected ? "ring-2 ring-(--color-text-primary) ring-offset-2 ring-offset-(--color-bg-elevated)" : ""
              }`}
              style={{ backgroundColor: repoColorVar(index) }}
            >
              {/* The tick is the non-color cue: the selected swatch must be
                  identifiable without relying on the ring's contrast against
                  sixteen different backgrounds. */}
              {isSelected && (
                <CheckIcon size={ICON_SIZE.XS} weight="bold" className="text-(--color-text-inverse) drop-shadow" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
