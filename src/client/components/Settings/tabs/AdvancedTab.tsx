import { useState } from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Button } from "../../ui/button.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { ToggleSwitch } from "../ToggleSwitch.js";

/** Shape of the /api/updates/check and /api/updates/channel responses. */
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
  /** Present when the previous in-place update failed and hasn't been retried. */
  lastUpdateError?: {
    failedAt?: string;
    runningSha?: string;
    attemptedRef?: string;
    attemptedSha?: string;
    exitCode?: number;
  };
}

function NotificationSettings() {
  const notifyOnFinish = useSettingsStore((s) => s.notifyOnFinish);
  const soundOnFinish = useSettingsStore((s) => s.soundOnFinish);
  const setNotifyOnFinish = useSettingsStore((s) => s.setNotifyOnFinish);
  const setSoundOnFinish = useSettingsStore((s) => s.setSoundOnFinish);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Notifications</h3>
      <p className="text-sm text-(--color-text-secondary)">
        Get notified when a session needs your attention &mdash; the agent stops and is waiting on you,
        CI fails, or a PR has merge conflicts. The same conditions that highlight a session in the sidebar.
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Browser notification</span>
            <p className="text-xs text-(--color-text-tertiary)">Show a desktop notification when the tab is in the background</p>
          </div>
          <ToggleSwitch enabled={notifyOnFinish} onToggle={setNotifyOnFinish} testId="settings-notify-on-finish" />
        </div>
        <div className="flex items-center justify-between py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Sound</span>
            <p className="text-xs text-(--color-text-tertiary)">Play a chime when a session needs attention</p>
          </div>
          <ToggleSwitch enabled={soundOnFinish} onToggle={setSoundOnFinish} testId="settings-sound-on-finish" />
        </div>
      </div>
    </div>
  );
}

function LiveSteeringSettings() {
  const liveSteering = useSettingsStore((s) => s.liveSteering);

  const handleToggle = async (v: boolean) => {
    useSettingsStore.getState().setLiveSteering(v);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveSteering: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      useSettingsStore.getState().setLiveSteering(!v);
      useUiStore.getState().setToast({ message: "Failed to update live steering setting" });
      console.error("[settings] toggle liveSteering failed:", err);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Live Steering</h3>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Inject messages mid-turn</span>
            <p className="text-xs text-(--color-text-tertiary)">Send a message while the agent is running to steer it without waiting for the turn to finish. On by default — it also keeps the agent process alive across interrupts so answering an AskUserQuestion or continuing after a stop works cleanly. Toggle off to return to the queue-based mode (one process per turn).</p>
          </div>
          <ToggleSwitch enabled={liveSteering} onToggle={(v) => void handleToggle(v)} testId="settings-live-steering" />
        </div>
      </div>
    </div>
  );
}

/**
 * docs/169 — both PR remediation automations (auto-fix CI, auto-resolve
 * conflicts) are global + persisted account-level toggles. They share one
 * settings group so a user manages "auto-fix my PR" switches in one place.
 */
function PrAutomationsSettings() {
  const autoResolveConflicts = useSettingsStore((s) => s.autoResolveConflicts);
  const autoFixCi = useSettingsStore((s) => s.autoFixCi);

  const makeToggle = (
    key: "autoResolveConflicts" | "autoFixCi",
    setter: (v: boolean) => void,
    label: string,
  ) => async (v: boolean) => {
    setter(v);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setter(!v);
      useUiStore.getState().setToast({ message: `Failed to update ${label} setting` });
      console.error(`[settings] toggle ${key} failed:`, err);
    }
  };

  const handleResolveToggle = makeToggle(
    "autoResolveConflicts",
    (v) => useSettingsStore.getState().setAutoResolveConflicts(v),
    "auto-resolve",
  );
  const handleFixToggle = makeToggle(
    "autoFixCi",
    (v) => useSettingsStore.getState().setAutoFixCi(v),
    "auto-fix",
  );

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">PR automations</h3>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Auto-fix CI when checks fail</span>
            <p className="text-xs text-(--color-text-tertiary)">When a PR&rsquo;s checks fail and the agent isn&rsquo;t busy, fetches the failing logs and asks the agent to fix them. Retries up to three times per commit.</p>
          </div>
          <ToggleSwitch enabled={autoFixCi} onToggle={(v) => void handleFixToggle(v)} testId="settings-auto-fix-ci" />
        </div>
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Auto-resolve conflicts when the base branch moves</span>
            <p className="text-xs text-(--color-text-tertiary)">Detects when the PR can no longer merge cleanly. When the agent isn&rsquo;t busy, runs a rebase and asks the agent to fix any conflicts. Force-pushes the result.</p>
          </div>
          <ToggleSwitch enabled={autoResolveConflicts} onToggle={(v) => void handleResolveToggle(v)} testId="settings-auto-resolve-conflicts" />
        </div>
      </div>
    </div>
  );
}

/**
 * docs/144 — global gate for sub-agent spawning. When on, a pinned session's
 * agent can spawn another registered agent for a one-shot sub-task (e.g. a
 * second-opinion review) via `shipit agent run`. Default off.
 */
function MultiAgentSettings() {
  const enableSubAgents = useSettingsStore((s) => s.enableSubAgents);

  const handleToggle = async (v: boolean) => {
    useSettingsStore.getState().setEnableSubAgents(v);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableSubAgents: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      useSettingsStore.getState().setEnableSubAgents(!v);
      useUiStore.getState().setToast({ message: "Failed to update multi-agent setting" });
      console.error("[settings] toggle enableSubAgents failed:", err);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Multi-agent sessions</h3>
      <div className="flex items-center justify-between py-1 gap-4">
        <div>
          <span className="text-sm text-(--color-text-primary)">Allow spawning another agent for a sub-task</span>
          <p className="text-xs text-(--color-text-tertiary)">
            Lets the agent in a session spawn another agent for a one-shot sub-task (e.g. a
            second-opinion review from a different model). The spawned agent runs with full tool
            access and its work is committed under your session&rsquo;s agent. Enabling this means
            a session container can briefly hold credentials for both agents.
          </p>
        </div>
        <ToggleSwitch enabled={enableSubAgents} onToggle={(v) => void handleToggle(v)} testId="settings-enable-sub-agents" />
      </div>
    </div>
  );
}

export function AdvancedTab({
  onFullReset,
  maxIdleContainers,
  onMaxIdleContainersSave,
}: {
  onFullReset?: () => void;
  maxIdleContainers: number;
  onMaxIdleContainersSave: (n: number) => void;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [idleContainers, setIdleContainers] = useState(maxIdleContainers);
  const [idleContainersSaved, setIdleContainersSaved] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [channelSwitching, setChannelSwitching] = useState(false);
  const version = useUiStore((s) => s.version);
  const updateMode = useUiStore((s) => s.updateMode);
  const effectiveUpdateMode = updateStatus?.updateMode ?? updateMode;
  // Optimistic channel: the persisted preference reflected by either the
  // ambient version (running instance) or the latest check/switch result.
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

        {/* Release-channel selector (feature 162) */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-(--color-text-secondary)">Release channel</span>
          <div className="flex gap-2" role="group" aria-label="Release channel">
            {([
              { id: "stable" as const, label: "Stable", desc: "Vetted releases, fewer updates." },
              { id: "edge" as const, label: "Edge", desc: "Latest changes from main, updated continuously." },
            ]).map((opt) => {
              const active = selectedChannel === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={channelSwitching || updateApplying}
                  aria-pressed={active}
                  data-testid={`settings-channel-${opt.id}`}
                  onClick={async () => {
                    if (active || channelSwitching) return;
                    setChannelSwitching(true);
                    setUpdateError(null);
                    try {
                      const res = await fetch("/api/updates/channel", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ channel: opt.id }),
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
                  }}
                  className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                    active
                      ? "border-(--color-accent) bg-(--color-accent-subtle)"
                      : "border-(--color-border-secondary) hover:border-(--color-border-primary)"
                  }`}
                >
                  <span className="block text-sm font-medium text-(--color-text-primary)">
                    {opt.label}
                    {opt.id === "stable" && (
                      <span className="ml-1.5 text-xs font-normal text-(--color-text-tertiary)">recommended</span>
                    )}
                  </span>
                  <span className="block text-xs text-(--color-text-tertiary)">{opt.desc}</span>
                </button>
              );
            })}
          </div>
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
            Updating... ShipIt will restart momentarily. Refresh the page in a few seconds.
          </p>
        )}
        {restarting && (
          <p className="text-sm text-(--color-text-secondary)">
            Restarting... ShipIt will be back momentarily. Refresh the page in a few seconds.
          </p>
        )}
        {updateError && (
          <p className="text-sm text-(--color-error)">{updateError}</p>
        )}
        {/* The previous in-place update failed (build errored, checkout
            rolled back). Surfaced explicitly so it isn't mistaken for a
            UI glitch — see issue #1047. */}
        {updateStatus?.lastUpdateError && !updateApplying && (
          <div
            className="rounded-md border border-(--color-error) bg-(--color-error-subtle) px-3 py-2 text-sm text-(--color-error)"
            data-testid="settings-update-failed"
          >
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

      <LiveSteeringSettings />

      <div className="border-t border-(--color-border-secondary)" />

      <PrAutomationsSettings />

      <div className="border-t border-(--color-border-secondary)" />

      <MultiAgentSettings />

      <div className="border-t border-(--color-border-secondary)" />

      <NotificationSettings />

      <div className="border-t border-(--color-border-secondary)" />

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Max Idle Containers</h3>
        <p className="text-sm text-(--color-text-secondary)">
          Maximum Docker containers kept running when not in use. Containers beyond this limit are stopped. Set to 0 to stop all idle containers immediately.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            value={idleContainers}
            onChange={(e) => { setIdleContainers(Math.max(0, Math.floor(Number(e.target.value) || 0))); setIdleContainersSaved(false); }}
            className="w-24 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
            data-testid="settings-max-idle-containers"
          />
          <Button
            variant="primary"
            size="md"
            onClick={() => { onMaxIdleContainersSave(idleContainers); setIdleContainersSaved(true); }}
            className="rounded-md"
            data-testid="settings-max-idle-containers-save"
          >
            {idleContainersSaved ? "Saved" : "Save"}
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
