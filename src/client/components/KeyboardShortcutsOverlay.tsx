import { useEffect, useRef } from "react";

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
      { keys: ["?"], description: "Toggle this help overlay" },
      { keys: ["Esc"], description: "Close overlay / search bar" },
    ],
  },
  {
    title: "Chat",
    shortcuts: [
      { keys: ["Enter"], description: "Send message" },
      { keys: ["Shift", "Enter"], description: "New line in message" },
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
          {i > 0 && <span className="text-gray-500 mx-0.5">+</span>}
          <kbd className="inline-block min-w-[1.5rem] text-center px-1.5 py-0.5 text-xs font-mono rounded bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-200">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="max-w-lg w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors text-sm"
            aria-label="Close"
          >
            Esc
          </button>
        </div>

        {shortcutGroups.map((group) => (
          <div key={group.title} className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
              {group.title}
            </h3>
            <div className="space-y-1">
              {group.shortcuts.map((shortcut, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-100/50 dark:hover:bg-gray-800/50"
                >
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    {shortcut.description}
                  </span>
                  <KeyCombo keys={shortcut.keys} />
                </div>
              ))}
            </div>
          </div>
        ))}

        <p className="text-xs text-gray-400 dark:text-gray-600 text-center pt-2 border-t border-gray-200 dark:border-gray-800">
          Press <kbd className="px-1 py-0.5 text-xs font-mono rounded bg-gray-200 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300">?</kbd> to toggle this overlay
        </p>
      </div>
    </div>
  );
}
