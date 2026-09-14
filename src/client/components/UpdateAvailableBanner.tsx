import { ArrowCircleUpIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useUiStore } from "../stores/ui-store.js";
import type { UpdateNotice } from "../../server/shared/types.js";

export function updateNoticeVisible(notice: UpdateNotice | null): boolean {
  return Boolean(notice?.available && !notice.dismissed);
}

/**
 * The pill the daily update check raises (docs/304). It never applies an
 * update: acting on it opens Settings → Advanced, which already holds the
 * changelog, the channel selector and the update control (req 7).
 */
export function UpdateAvailableBanner({ compact = false }: { compact?: boolean }) {
  const notice = useUiStore((s) => s.updateNotice);
  if (!notice || !updateNoticeVisible(notice)) return null;

  const openSettings = () => {
    const ui = useUiStore.getState();
    ui.setSettingsTab("advanced");
    ui.setSettingsOpen(true);
  };

  const dismiss = () => {
    const optimistic = { ...notice, dismissed: true };
    useUiStore.getState().setUpdateNotice(optimistic);
    void (async () => {
      try {
        const res = await fetch("/api/updates/dismiss", { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        // The server is the one install-wide record of this (req 8), so a
        // failed write must not leave the browser quietly out of step with it.
        // Only this browser's own guess is rolled back: anything that arrived
        // since — a check's result, another device's dismissal — is newer and
        // came from that record, so reverting it would be the stale write.
        if (useUiStore.getState().updateNotice === optimistic) {
          useUiStore.getState().setUpdateNotice(notice);
          useUiStore.getState().setToast({ message: "Failed to dismiss the update notice" });
        }
        console.error("[updates] dismiss failed:", err);
      }
    })();
  };

  return (
    <div
      role="status"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-(--color-info) bg-(--color-bg-elevated) text-xs font-medium whitespace-nowrap text-(--color-info) shadow-lg"
      data-testid="update-available-banner"
    >
      <ArrowCircleUpIcon size={ICON_SIZE.XS} weight="fill" className="shrink-0" />
      <button
        onClick={openSettings}
        className="hover:underline min-w-0 truncate"
        title="Open Settings → Software Updates"
        data-testid="update-available-open"
      >
        {compact ? "Update available" : `Update available — ${notice.latestVersion}`}
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss update notice"
        title="Dismiss until ShipIt is updated"
        className="ml-0.5 -mr-1 p-0.5 rounded-full text-(--color-info) hover:bg-(--color-bg-hover) transition-colors"
        data-testid="update-available-dismiss"
      >
        <XIcon size={ICON_SIZE.XS} />
      </button>
    </div>
  );
}
