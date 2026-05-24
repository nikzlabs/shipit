// eslint-disable-next-line no-restricted-imports -- window keydown listener with cleanup
import { useEffect } from "react";

export function isValidQuickCaptureHotkey(hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.find((p) => !["mod", "ctrl", "cmd", "meta", "alt", "opt", "shift"].includes(p));
  if (!key) return false;
  const hasStrongModifier = parts.includes("mod") || parts.includes("ctrl") || parts.includes("cmd") || parts.includes("meta");
  const hasSecondModifier = parts.includes("alt") || parts.includes("opt") || parts.includes("shift");
  return hasStrongModifier && hasSecondModifier;
}

function eventMatchesHotkey(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.find((p) => !["mod", "ctrl", "cmd", "meta", "alt", "opt", "shift"].includes(p));
  if (!key) return false;
  const wantsMod = parts.includes("mod");
  const wantsCtrl = parts.includes("ctrl");
  const wantsMeta = parts.includes("cmd") || parts.includes("meta");
  const wantsAlt = parts.includes("alt") || parts.includes("opt");
  const wantsShift = parts.includes("shift");

  const modOk = wantsMod ? e.ctrlKey || e.metaKey : (!e.ctrlKey || wantsCtrl) && (!e.metaKey || wantsMeta);
  return (
    modOk &&
    e.ctrlKey === (wantsCtrl || (wantsMod && e.ctrlKey)) &&
    e.metaKey === (wantsMeta || (wantsMod && e.metaKey)) &&
    e.altKey === wantsAlt &&
    e.shiftKey === wantsShift &&
    e.key.toLowerCase() === key
  );
}

export function useQuickCaptureHotkey(hotkey: string, onOpen: () => void): void {
  // eslint-disable-next-line no-restricted-syntax -- global keyboard shortcut with cleanup
  useEffect(() => {
    if (!isValidQuickCaptureHotkey(hotkey)) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!eventMatchesHotkey(e, hotkey)) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hotkey, onOpen]);
}
