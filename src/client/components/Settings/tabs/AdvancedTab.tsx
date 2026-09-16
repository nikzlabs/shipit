import { useState } from "react";
import { DeclaredSettings } from "../DeclaredSettings.js";
import { UpdatePanel } from "./UpdatePanel.js";

/**
 * Prose and chrome that belong to a section rather than to any one declaration,
 * so they stay out of the descriptions the agent reads (inventory.md P12).
 */
const ADVANCED_NOTES = {
  "Software Updates": <UpdatePanel />,
  Conversation: (
    <p className="text-xs text-(--color-text-secondary)">
      Saved for this browser. Browser Find searches displayed content. In-app search can still
      find hidden message text.
    </p>
  ),
  Notifications: (
    <p className="text-sm text-(--color-text-secondary)">
      Get notified when a session needs your attention &mdash; the agent stops and is waiting on
      you, CI fails, or a PR has merge conflicts. The same conditions that highlight a session in
      the sidebar.
    </p>
  ),
};

export function AdvancedTab({ onFullReset }: { onFullReset?: () => void }) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
      <DeclaredSettings tab="advanced" notes={ADVANCED_NOTES} />

      <div className="border-t border-(--color-border-secondary)" />

      <div className="space-y-4">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Reset Container</h3>
        <p className="text-sm text-(--color-text-secondary)">
          Delete all sessions, chat history, and settings. Credentials (GitHub, Claude) are preserved. This cannot be undone.
        </p>
        <button
          onClick={() => {
            if (confirmingReset) {
              setResetting(true);
              onFullReset?.();
            } else {
              setConfirmingReset(true);
            }
          }}
          onBlur={() => {
            if (!resetting) setConfirmingReset(false);
          }}
          disabled={resetting}
          className={`w-full px-3 py-2 text-sm rounded-md border transition-colors ${
            resetting
              ? "bg-(--color-error-subtle) border-(--color-error)/50 text-(--color-error) opacity-50 cursor-not-allowed"
              : confirmingReset
                ? "bg-(--color-error-subtle) border-(--color-error)/50 text-(--color-error)"
                : "bg-(--color-error-subtle) border-(--color-error)/30 text-(--color-error) hover:border-(--color-error)/50"
          }`}
          data-testid="settings-reset"
        >
          {resetting ? "Resetting..." : confirmingReset ? "Click again to confirm reset" : "Reset Everything"}
        </button>
      </div>
    </div>
  );
}
