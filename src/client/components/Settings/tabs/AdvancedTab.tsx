import { useState } from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Button } from "../../ui/button.js";
import { Alert } from "../../ui/banner.js";
import { useUiStore } from "../../../stores/ui-store.js";
import {
  DeclaredEnumCards,
  SettingCopy,
  bindSetting,
} from "../declared.js";
import { DeclaredSettings } from "../DeclaredSettings.js";

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

/**
 * Prose that belongs to a section rather than to any one declaration, so it stays
 * out of the descriptions the agent reads (inventory.md P12).
 */
const ADVANCED_NOTES = {
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

export function AdvancedTab({
  onFullReset,
  memoryBudgetMb,
  onMemoryBudgetSave,
}: {
  onFullReset?: () => void;
  memoryBudgetMb: number | null;
  onMemoryBudgetSave: (mb: number | null) => void;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [memoryBudgetGb, setMemoryBudgetGb] = useState(
    memoryBudgetMb === null ? "" : String(Math.round((memoryBudgetMb / 1024) * 10) / 10),
  );
  const [memoryBudgetSaved, setMemoryBudgetSaved] = useState(false);
  // docs/284 req 13 — the default differs by deployment, so the field cannot

  const dockerMemory = useUiStore((s) => s.dockerMemory);
  const effectiveBudgetGb = memoryBudgetMb === null && dockerMemory?.budgetBytes
    ? Math.round((dockerMemory.budgetBytes / 1024 ** 3) * 10) / 10
    : null;
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [channelSwitching, setChannelSwitching] = useState(false);
  const version = useUiStore((s) => s.version);
  const updateMode = useUiStore((s) => s.updateMode);
  const effectiveUpdateMode = updateStatus?.updateMode ?? updateMode;

  const selectedChannel = updateStatus?.channel ?? version?.channel ?? "edge";

  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Software Updates</h3>
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

        {/* Release-channel selector (feature 162) — each option's own words come
            from the declaration, so the agent reads what the card says. */}
        <div className="space-y-1.5">
          <DeclaredEnumCards
            settingKey="advanced.releaseChannel"
            value={selectedChannel}
            disabled={channelSwitching || updateApplying}
            testIdPrefix="settings-channel"
            onChange={(channel) => {
              if (channel === selectedChannel || channelSwitching) return;
              void (async () => {
                setChannelSwitching(true);
                setUpdateError(null);
                try {
                  const res = await fetch("/api/updates/channel", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ channel }),
                  });
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({})) as { error?: string };
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                  }
                  setUpdateStatus(await res.json() as UpdateStatusResult);
                } catch (err) {
                  setUpdateError((err as Error).message);
                } finally {
                  setChannelSwitching(false);
                }
              })();
            }}
          />
          {channelSwitching && (
            <p className="text-xs text-(--color-text-tertiary)">Switching channel…</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Button
            variant="primary"
            size="md"
            disabled={updateChecking || updateApplying}
            onClick={async () => {
              setUpdateChecking(true);
              setUpdateError(null);
              try {
                const res = await fetch("/api/updates/check", { method: "POST" });
                if (!res.ok) {
                  const body = await res.json().catch(() => ({})) as { error?: string };
                  throw new Error(body.error ?? `HTTP ${res.status}`);
                }
                const data = await res.json() as UpdateStatusResult;
                setUpdateStatus(data);
              } catch (err) {
                setUpdateError((err as Error).message);
              } finally {
                setUpdateChecking(false);
              }
            }}
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

      <div className="border-t border-(--color-border-secondary)" />

      <DeclaredSettings tab="advanced" notes={ADVANCED_NOTES} />

      <div className="border-t border-(--color-border-secondary)" />

      {/* docs/284 — replaces "Max Idle Containers". A count rationed the wrong
          unit: an idle shell and a Postgres service cost the machine very
          different amounts, and memory is what the user is actually out of. */}
      <div className="space-y-3">
        <SettingCopy
          settingKey="advanced.memoryBudgetMb"
          heading
          detail={
            effectiveBudgetGb ? (
              <p className="mt-1 text-xs text-(--color-text-tertiary)" data-testid="settings-memory-budget-effective">
                Currently following the install default of {effectiveBudgetGb} GB.
              </p>
            ) : undefined
          }
        />
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            step={0.5}
            placeholder="whole machine"
            aria-label="Memory budget"
            value={memoryBudgetGb}
            onChange={(e) => { setMemoryBudgetGb(e.target.value); setMemoryBudgetSaved(false); }}
            className="w-36 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
            data-testid="settings-memory-budget"
            {...bindSetting("advanced.memoryBudgetMb")}
          />
          <span className="text-sm text-(--color-text-secondary)">GB</span>
          <Button
            variant="primary"
            size="md"
            aria-label={memoryBudgetSaved ? "Memory budget saved" : "Save memory budget"}
            onClick={() => {
              const gb = Number(memoryBudgetGb);
              onMemoryBudgetSave(memoryBudgetGb.trim() === "" || !(gb > 0) ? null : Math.round(gb * 1024));
              setMemoryBudgetSaved(true);
            }}
            className="rounded-md"
            data-testid="settings-memory-budget-save"
            {...bindSetting("advanced.memoryBudgetMb")}
          >
            {memoryBudgetSaved ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

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
