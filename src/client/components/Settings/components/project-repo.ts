/**
 * Which repository Project Settings is open for
 * (docs/308-data-driven-settings plan.md → Slices → 7).
 *
 * The address every declaration on the three `project-*` tabs carries, as a read
 * rather than a prop — a component takes the setting's key and nothing else
 * (slices 6a, 6b). It is the repository the dialog was OPENED for, never the
 * active one: the two differ whenever Project Settings is opened from another
 * repository's row in the sidebar.
 */

import { useUiStore } from "../../../stores/ui-store.js";

export function useProjectRepoUrl(): string | null {
  return useUiStore((s) => s.projectSettingsRepoUrl);
}
