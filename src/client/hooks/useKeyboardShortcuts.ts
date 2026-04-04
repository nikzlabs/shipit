// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listeners with cleanup (browser API subscription)
import { useEffect } from "react";
import type { UseSearchReturn } from "./useSearch.js";

export function useKeyboardShortcuts(params: {
  search: UseSearchReturn;
  searchOpen: boolean;
  setSearchOpen: (updater: (prev: boolean) => boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (updater: (prev: boolean) => boolean) => void;
  isLoading: boolean;
  settingsOpen: boolean;
  handleInterrupt: () => void;
}): void {
  const { search, setSearchOpen, setShortcutsOpen, isLoading, searchOpen, shortcutsOpen, settingsOpen, handleInterrupt } = params;

  // Ctrl+F / Cmd+F to toggle search bar (only when focus is in the chat panel)
  // When focus is elsewhere (right panel, dialogs, iframes), let the browser's native search work
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        const target = e.target as HTMLElement | null;
        const inChatPanel = !target || target === document.body || target.closest("[data-chat-panel]");
        if (!inChatPanel) return;
        e.preventDefault();
        setSearchOpen((prev: boolean) => {
          if (prev) {
            search.clear();
            return false;
          }
          return true;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [search, setSearchOpen]);

  // ? to toggle keyboard shortcuts overlay (only when not typing in an input)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        setShortcutsOpen((prev: boolean) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setShortcutsOpen]);

  // Escape key to interrupt Claude while loading (only when not typing in an input or overlay open)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && isLoading && !searchOpen && !shortcutsOpen && !settingsOpen) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "SELECT") return;
        e.preventDefault();
        handleInterrupt();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isLoading, searchOpen, shortcutsOpen, settingsOpen, handleInterrupt]);
}
