import { useSettingsStore } from "../stores/settings-store.js";
import { getKeybindingDef, type KeybindingId } from "./registry.js";

export function useKeybinding(id: KeybindingId): string {
  return useSettingsStore((s) => s.keybindings[id] ?? getKeybindingDef(id).defaultBinding);
}
