/**
 * The sidebar colour, as the component `project.colorIndex` names
 * (docs/308-data-driven-settings slice 7). A swatch grid is no value kind's
 * control — `numeric` has no entry in the table (P4) — and the value is one
 * repository's, so it goes through the repositories store.
 */

import { CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useRepoStore } from "../stores/repo-store.js";
import { parseRepoName } from "../utils/repo-label.js";
import { REPO_COLOR_COUNT, REPO_COLOR_NAMES, repoColorVar } from "../../server/shared/repo-colors.js";
import { settingCopy } from "./Settings/setting-copy.js";
import { SettingCopy } from "./Settings/declared.js";
import { useProjectRepoUrl } from "./Settings/components/project-repo.js";

export function RepoColorPicker() {
  const repoUrl = useProjectRepoUrl();
  const repos = useRepoStore((s) => s.repos);
  const setRepoColorIndex = useRepoStore((s) => s.setRepoColorIndex);
  const selected = repos.find((r) => r.url === repoUrl)?.colorIndex;
  // Colors another repo is already using. Assignment never hands out a duplicate

  const takenBy = new Map<number, string[]>();
  for (const r of repos) {
    if (r.url === repoUrl || r.colorIndex === undefined) continue;
    takenBy.set(r.colorIndex, [...(takenBy.get(r.colorIndex) ?? []), parseRepoName(r.url)]);
  }

  return (
    <div className="space-y-3" data-testid="repo-color-picker">
      <SettingCopy
        settingKey="project.colorIndex"
        heading
        /* Not part of the setting: it explains the dot on a swatch, which is
           derived from what the other repositories currently use. */
        detail={
          <p className="text-xs text-(--color-text-tertiary)">
            Colors already taken by another repository are marked with a dot.
          </p>
        }
      />
      <div
        role="radiogroup"
        aria-label={settingCopy("project.colorIndex").label}
        className="grid grid-cols-8 gap-2 max-w-md"
      >
        {Array.from({ length: REPO_COLOR_COUNT }, (_, index) => {
          const isSelected = selected === index;
          const users = takenBy.get(index);
          const label = users
            ? `${REPO_COLOR_NAMES[index]} — already used by ${users.join(", ")}`
            : REPO_COLOR_NAMES[index];
          return (
            <button
              key={index}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={label}
              title={label}
              data-taken={users ? "true" : undefined}
              data-testid={`repo-color-${index}`}
              onClick={() => { if (repoUrl) void setRepoColorIndex(repoUrl, index); }}
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
              {/* Taken by another repo — a small notch rather than a disabled
                  state, because picking a duplicate on purpose is allowed. */}
              {!isSelected && users && (
                <span className="w-1.5 h-1.5 rounded-full bg-(--color-text-inverse) opacity-70" aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
