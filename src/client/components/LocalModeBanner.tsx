/**
 * LocalModeBanner — shown when the orchestrator runs in `RUNTIME_MODE=local`
 * (the dogfooding ShipIt-in-ShipIt path; see docs/118-shipit-ui-local).
 *
 * Local mode is "production behavior minus the container layer," so several
 * container-backed inner-UI features silently no-op. Rather than let the
 * developer think they're testing functionality they aren't, this banner
 * states plainly what's disabled. The outer ShipIt session container is
 * intact, so the escape hatch for each disabled feature is "use the outer
 * panel" (outer terminal, outer preview, outer file watcher).
 *
 * Dismissible — the dismissal is remembered in localStorage so it doesn't nag
 * across reloads. It re-appears only if the user clears storage.
 *
 * Style: neutral/info (blue), not a warning — local mode is an intentional
 * configuration, not an error state.
 */

import { useState } from "react";
import { InfoIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useUiStore } from "../stores/ui-store.js";

const DISMISS_KEY = "shipit:local-mode-banner-dismissed";

function getDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function LocalModeBanner() {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const [dismissed, setDismissed] = useState(getDismissed);

  if (runtimeMode !== "local" || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Non-critical — dismissal just won't persist across reloads.
    }
    setDismissed(true);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-3 py-1.5 text-xs border-b bg-(--color-info-subtle) text-(--color-info) border-(--color-info)/30"
      data-testid="local-mode-banner"
    >
      <InfoIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0" />
      <span className="font-medium">Running in local mode</span>
      <span className="opacity-90 min-w-0 truncate">
        — container features are disabled here: preview, the terminal, and live
        file-tree updates. Use the outer ShipIt panels for those.
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss local mode notice"
        className="ml-auto shrink-0 inline-flex items-center justify-center w-5 h-5 rounded hover:bg-(--color-bg-hover) transition-colors"
      >
        <XIcon size={ICON_SIZE.XS} />
      </button>
    </div>
  );
}
