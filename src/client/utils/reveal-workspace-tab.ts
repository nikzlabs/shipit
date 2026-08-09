import { useUiStore, type RightTab } from "../stores/ui-store.js";

/**
 * Bring a workspace-panel tab into view, wherever the user is looking.
 *
 * Selecting the tab is only one of three things that have to happen: on a phone
 * the workspace column is a separate panel from the chat, and the navigation
 * sidebar may be covering both. Any affordance that says "look at this" — the
 * Present tool chip, an agent-authored pointer (docs/258) — needs all three, and
 * they were duplicated at each call site before this.
 */
export function revealWorkspaceTab(tab: RightTab): void {
  const ui = useUiStore.getState();
  ui.setRightTab(tab);
  ui.setMobilePanel("preview");
  ui.setMobileSidebarOpen(false);
}
