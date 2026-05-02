// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listener for Escape/? with cleanup (browser API subscription)
import { useEffect, useRef } from "react";
import { Button } from "./ui/button.js";

export interface ShortcutEntry {
  keys: string[];
  description: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutEntry[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "General",
    shortcuts: [
      { keys: ["Ctrl", "/"], description: "Toggle this help overlay" },
      { keys: ["Esc"], description: "Close overlay / search bar" },
    ],
  },
  {
    title: "Sessions",
    shortcuts: [
      { keys: ["Ctrl", "Shift", "O"], description: "New session" },
    ],
  },
  {
    title: "Chat",
    shortcuts: [
      { keys: ["Enter"], description: "Send message" },
      { keys: ["Shift", "Enter"], description: "New line in message" },
      { keys: ["Esc"], description: "Stop Claude while processing" },
    ],
  },
  {
    title: "Search",
    shortcuts: [
      { keys: ["Ctrl", "F"], description: "Toggle search bar" },
      { keys: ["Enter"], description: "Next search match" },
      { keys: ["Shift", "Enter"], description: "Previous search match" },
    ],
  },
];

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key, i) => (
        <span key={i}>
          {i > 0 && <span className="text-(--color-text-secondary) mx-0.5">+</span>}
          <kbd className="inline-block min-w-[1.5rem] text-center px-1.5 py-0.5 text-xs font-mono rounded bg-(--color-bg-tertiary) border border-(--color-border-secondary) text-(--color-text-primary)">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isModSlash = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "/";
      if (e.key === "Escape" || e.key === "?" || isModSlash) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-(--color-bg-overlay) backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="max-w-lg w-full mx-4 rounded-xl bg-(--color-bg-elevated) border border-(--color-border-secondary) p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-(--color-text-primary)">
            Keyboard Shortcuts
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
          >
            Esc
          </Button>
        </div>

        {shortcutGroups.map((group) => (
          <div key={group.title} className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-(--color-text-secondary)">
              {group.title}
            </h3>
            <div className="space-y-1">
              {group.shortcuts.map((shortcut, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-(--color-bg-hover)"
                >
                  <span className="text-sm text-(--color-text-primary)">
                    {shortcut.description}
                  </span>
                  <KeyCombo keys={shortcut.keys} />
                </div>
              ))}
            </div>
          </div>
        ))}

        <p className="text-xs text-(--color-text-tertiary) text-center pt-2 border-t border-(--color-border-primary)">
          Press <kbd className="px-1 py-0.5 text-xs font-mono rounded bg-(--color-bg-tertiary) border border-(--color-border-secondary) text-(--color-text-primary)">Ctrl</kbd> + <kbd className="px-1 py-0.5 text-xs font-mono rounded bg-(--color-bg-tertiary) border border-(--color-border-secondary) text-(--color-text-primary)">/</kbd> to toggle this overlay
        </p>
      </div>
    </div>
  );
}
