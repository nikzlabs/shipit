/**
 * The Software Updates chrome: the running version, the update actions and what
 * the last check found.
 *
 * None of it is a setting, so none of it is declared — it is a tab's own content
 * placed around the generated rows (inventory.md P12). It is the *note* on the
 * Software Updates section, so the release channel renders beneath it, inside
 * the section it belongs to, as the generated row it now is.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: re-read the update status when the channel it describes changes (external system sync)
import { useEffect, useRef, useState } from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Button } from "../../ui/button.js";
import { Alert } from "../../ui/banner.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useSetting } from "../declared-setting.js";

interface UpdateStatusResult {
  available: boolean;
  behindBy: number;
  commitMessages: string[];
  currentCommit: string;
  channel: "stable" | "edge";
  currentVersion: string;
  latestVersion: string;
  isDowngrade: boolean;
  releaseUrl?: string;
  updateMode?: "managed" | "manual";

  lastUpdateError?: {
    failedAt?: string;
    runningSha?: string;
    attemptedRef?: string;
    attemptedSha?: string;
    exitCode?: number;
  };
}

export function UpdatePanel() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const version = useUiStore((s) => s.version);
  const updateMode = useUiStore((s) => s.updateMode);
  const effectiveUpdateMode = updateStatus?.updateMode ?? updateMode;

  const { value: channel } = useSetting("advanced.releaseChannel");
  const selectedChannel = useRef(channel);
  selectedChannel.current = channel;

  /*
    A check describes ONE channel, and this panel outlives a change of channel —
    so an answer is kept only if the selection has not moved since it was asked
    for. The route that stores the channel drops its own answer server-side for
    the same reason (`api-routes-updates.ts`).

    Both orderings happen: a check that finishes after the change is dropped
    here, and one that finished before it is replaced by the run below. The
    comparison is against the selection this run STARTED from, not against the
    stored channel — a check is worth showing whether or not the record agrees
    with the server, and only movement makes it stale.
  */
  const runCheck = async () => {
    const askedOn = selectedChannel.current;
    setUpdateChecking(true);
    setUpdateError(null);
    try {
      const res = await fetch("/api/updates/check", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as UpdateStatusResult;
      if (selectedChannel.current !== askedOn) return;
      setUpdateStatus(data);
    } catch (err) {
      setUpdateError((err as Error).message);
    } finally {
      setUpdateChecking(false);
    }
  };

  /*
    The channel moved, so what is on screen describes the channel the user just
    left. Asking again is what keeps the changelog and the downgrade warning
    beside the choice that produced them — the write's own answer used to carry
    them, and a generated row's writer awaits its response and does nothing else
    with it (plan.md → One writer).

    Only when something IS on screen: with nothing shown there is nothing stale
    to repair, and a hydrated value arriving after this panel mounted would
    otherwise fetch on its own.
  */
  const checkedChannel = useRef(channel);
  // eslint-disable-next-line no-restricted-syntax -- external system sync: re-read the update status the channel this panel shows has moved away from
  useEffect(() => {
    if (checkedChannel.current === channel) return;
    checkedChannel.current = channel;
    if (!updateStatus) return;
    setUpdateStatus(null);
    void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the channel is the change this watches; `updateStatus` is read, not watched
  }, [channel]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-(--color-text-secondary)">
        {effectiveUpdateMode === "managed"
          ? "Check for new versions and update ShipIt in place."
          : "Check for new versions and choose the release channel. Re-run the local production script to apply updates."}
      </p>

      {/* Current version — channel-aware label, e.g. "Stable · v1.4.0".
          Anchored on the running image's baked build id, so it stays
          honest even if a failed update left the checkout ahead. */}
      {version && (
        <p className="text-sm text-(--color-text-secondary)" data-testid="settings-version">
          Current version:{" "}
          <span className="font-medium text-(--color-text-primary)">
            {version.channel === "stable" ? "Stable" : "Edge"} · {version.version}
          </span>
        </p>
      )}
      {/* Checkout is ahead of the running image — an update didn't finish. */}
      {version?.mismatch && (
        <p className="text-sm text-(--color-warning)" data-testid="settings-version-mismatch">
          ⚠ A previous update may not have finished — this is still running the
          last successfully-built version. Try Update Now again.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <Button
          variant="primary"
          size="md"
          disabled={updateChecking || updateApplying}
          onClick={runCheck}
          className="rounded-md"
          data-testid="settings-check-updates"
        >
          {updateChecking ? "Checking..." : "Check for Updates"}
        </Button>
        {effectiveUpdateMode === "managed" && updateStatus?.available && !updateApplying && (
          <Button
            variant="primary"
            size="md"
            onClick={async () => {
              setUpdateApplying(true);
              setUpdateError(null);
              try {
                const res = await fetch("/api/updates/apply", { method: "POST" });
                if (!res.ok) {
                  const body = await res.json().catch(() => ({})) as { error?: string };
                  throw new Error(body.error ?? `HTTP ${res.status}`);
                }
              } catch (err) {
                setUpdateApplying(false);
                setUpdateError((err as Error).message);
              }
            }}
            className="rounded-md"
            data-testid="settings-apply-update"
          >
            Update Now
          </Button>
        )}
        {effectiveUpdateMode === "managed" && (
          <Button
            variant="secondary"
            size="md"
            disabled={restarting || updateApplying}
            onClick={async () => {
              setRestarting(true);
              setUpdateError(null);
              try {
                const res = await fetch("/api/updates/restart", { method: "POST" });
                if (!res.ok) {
                  const body = await res.json().catch(() => ({})) as { error?: string };
                  throw new Error(body.error ?? `HTTP ${res.status}`);
                }
              } catch (err) {
                setRestarting(false);
                setUpdateError((err as Error).message);
              }
            }}
            className="rounded-md"
            data-testid="settings-restart"
          >
            {restarting ? "Restarting..." : "Just Restart"}
          </Button>
        )}
      </div>
      {effectiveUpdateMode === "manual" && (
        <p className="text-sm text-(--color-text-secondary)" data-testid="settings-manual-update-note">
          To apply updates or restart local production, stop ShipIt and re-run{" "}
          <span className="font-mono text-(--color-text-primary)">docker/local/prod.sh</span>.
        </p>
      )}
      {updateApplying && (
        <p className="text-sm text-(--color-text-secondary)">
          Updating... ShipIt will restart momentarily, and this page reloads itself
          once the new version is up.
        </p>
      )}
      {restarting && (
        <p className="text-sm text-(--color-text-secondary)">
          Restarting... ShipIt will be back momentarily and reconnects on its own.
        </p>
      )}
      {updateError && (
        <p className="text-sm text-(--color-error)">{updateError}</p>
      )}
      {/* The previous in-place update failed (build errored, checkout
          rolled back). Surfaced explicitly so it isn't mistaken for a
          UI glitch — see issue #1047. */}
      {updateStatus?.lastUpdateError && !updateApplying && (
        <Alert
          variant="error"
          className="text-sm"
          data-testid="settings-update-failed"
        >
          <div>
            <p className="font-medium">Last update failed</p>
            <p className="mt-0.5 text-(--color-text-secondary)">
              The rebuild didn&apos;t complete, so ShipIt is still running the previous
              version
              {updateStatus.lastUpdateError.runningSha
                ? ` (${updateStatus.lastUpdateError.runningSha.slice(0, 7)})`
                : ""}
              . The checkout was rolled back automatically. Free up disk space if needed,
              then try Update Now again.
            </p>
          </div>
        </Alert>
      )}
      {updateStatus && !updateApplying && (
        <div className="text-sm text-(--color-text-secondary)">
          {updateStatus.available ? (
            <>
              {updateStatus.isDowngrade ? (
                <p
                  className="text-(--color-warning)"
                  data-testid="settings-downgrade-warning"
                >
                  ⚠ Switching to {updateStatus.latestVersion} would move you off newer
                  code you&apos;re currently running ({updateStatus.currentVersion}). This is a
                  downgrade — older code may not read newer on-disk data cleanly.
                </p>
              ) : (
                <p>
                  {updateStatus.latestVersion} available (you&apos;re on {updateStatus.currentVersion}) —{" "}
                  {updateStatus.behindBy} commit{updateStatus.behindBy === 1 ? "" : "s"} behind
                </p>
              )}
              <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs font-mono text-(--color-text-tertiary)">
                {updateStatus.commitMessages.slice(0, 10).map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
                {updateStatus.commitMessages.length > 10 && (
                  <li>...and {updateStatus.commitMessages.length - 10} more</li>
                )}
              </ul>
              {/* Overflow-only escape hatch — the inline changelog above
                  is the primary affordance (CLAUDE.md §2). */}
              {updateStatus.releaseUrl && (
                <a
                  href={updateStatus.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary)"
                  data-testid="settings-release-link"
                >
                  View release on GitHub
                  <ArrowSquareOutIcon size={ICON_SIZE.XS} />
                </a>
              )}
            </>
          ) : (
            <>
              <p>ShipIt is up to date ({updateStatus.currentVersion})</p>
              {updateStatus.releaseUrl && (
                <a
                  href={updateStatus.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary)"
                  data-testid="settings-release-link"
                >
                  View release on GitHub
                  <ArrowSquareOutIcon size={ICON_SIZE.XS} />
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
