import { useSettingsStore } from "../stores/settings-store.js";
import { getKeybindingDef, type KeybindingId } from "./registry.js";

/**
 * Reactively resolve a binding to its current chord (the user's override, or
 * the registry default). Re-renders when the binding is changed in settings.
 */
export function useKeybinding(id: KeybindingId): string {
  return useSettingsStore((s) => s.keybindings[id] ?? getKeybindingDef(id).defaultBinding);
}
