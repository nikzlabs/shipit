import { useUiStore, type RightTab } from "../stores/ui-store.js";

export function revealWorkspaceTab(tab: RightTab): void {
  const ui = useUiStore.getState();
  ui.setRightTab(tab);
  ui.setMobilePanel("preview");
  ui.setMobileSidebarOpen(false);
}
