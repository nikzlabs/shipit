// eslint-disable-next-line no-restricted-imports -- useEffect: load this session's egress override when the dialog opens (external system sync)
import { useEffect, useState } from "react";
import {
  GlobeIcon,
  ShieldCheckIcon,
  ShieldSlashIcon,
  WarningIcon,
  CheckCircleIcon,
  ClockClockwiseIcon,
  ArrowsClockwiseIcon,
  CircleNotchIcon,
} from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog.js";
import { Button } from "../ui/button.js";
import { WithTooltip } from "../ui/tooltip.js";
import { ICON_SIZE } from "../../design-tokens.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useApi, ApiError } from "../../hooks/useApi.js";
import type { EgressAllowlistView, EgressSessionSettings } from "../../../server/shared/types.js";

/**
 * Per-session settings dialog (docs/172 / SHI-90).
 *
 * Holds the session-scoped half of egress configuration — the network
 * containment override (Inherit / Contained / Open). It used to live as a bare
 * Radix radio group at the bottom of the session's overflow menu, where its
 * `text-sm` rows with no icon broke the menu's visual rhythm; it now opens from
 * a "Session settings…" menu item into this dialog, styled to match the Sandbox
 * capability picker. This is deliberately separate from the global Settings →
 * Network dialog (app-wide allowlist); per-session lives with the session.
 *
 * Egress is a CREATION-TIME network-topology choice: the firewall + DNS resolver
 * + SNI-proxy sidecars are plumbed into the container's netns when it is created.
 * Changing the mode on a RUNNING session persists the override (PUT) but does
 * NOT re-plumb the live container. So the dialog surfaces a **pending** state
 * (the server diffs the now-resolved containment against what the live container
 * actually started with — `EgressSessionSettings.pendingRestart`) and offers
 * "Restart to apply now", which reuses the existing container-restart lifecycle
 * control (POST /api/sessions/:id/container/restart). Restart is never automatic
 * and is disabled while an agent turn is running (it would kill the agent).
 *
 * Wired with direct fetches for the read/override (GET the effective view, PUT to
 * set/clear) so it doesn't depend on the Settings store, which is single-session-
 * scoped and only loaded while that dialog is open.
 */

type Mode = "inherit" | "contained" | "open";

const modeFromOverride = (override: boolean | null): Mode =>
  override === null ? "inherit" : override ? "contained" : "open";

const overrideFromMode = (mode: Mode): boolean | null =>
  mode === "inherit" ? null : mode === "contained";

export function SessionSettingsDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // undefined = not yet loaded; the options render disabled until it resolves.
  const [mode, setMode] = useState<Mode | undefined>(undefined);
  // Deployment-level facts (not changed by this session's override): the global
  // containment switch and whether this deployment can actually ENFORCE
  // containment. Optimistic `true` so a capable host never flashes the warning.
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [enforcementActive, setEnforcementActive] = useState(true);
  // Server-computed: the now-resolved containment differs from what this
  // session's live container was created with, so the change applies only on the
  // next container start. Null while loading / when no container is running.
  const [pendingRestart, setPendingRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const api = useApi();
  // The active session's live "is an agent turn running" flag. The dialog only
  // renders for the current session, so this is the right session's state. A
  // restart would kill the running agent (see CLAUDE.md never-kill rules), so it
  // gates the restart action.
  const agentRunning = useSessionStore((s) => s.isLoading);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: read the session's current override when the dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/egress/allowlist?session=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const view = (await res.json()) as EgressAllowlistView;
        if (!cancelled) {
          setMode(modeFromOverride(view?.session?.override ?? null));
          setGlobalEnabled(view?.globalEnabled ?? true);
          setEnforcementActive(view?.session?.enforcementActive ?? view?.enforcementActive ?? true);
          setPendingRestart(view?.session?.pendingRestart ?? false);
        }
      } catch {
        if (!cancelled) setMode("inherit");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, open]);

  const handleChange = async (next: Mode) => {
    const prev = mode;
    setMode(next);
    try {
      const res = await fetch(`/api/egress/session/${encodeURIComponent(sessionId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ override: overrideFromMode(next) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The PUT returns the fresh session view, including the recomputed
      // pendingRestart (resolved-now vs the live container's started-with mode),
      // so the indicator reflects the selection without a second round-trip.
      const settings = (await res.json()) as EgressSessionSettings;
      setPendingRestart(settings?.pendingRestart ?? false);
    } catch (err) {
      setMode(prev);
      useUiStore.getState().setToast({ message: "Failed to update this session's network mode" });
      console.error("[session-egress] failed to set override:", err);
    }
  };

  const handleRestart = async () => {
    if (restarting || agentRunning) return;
    setRestarting(true);
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/container/restart`);
      // Re-handshake the WS so the worker reattaches to the freshly-restarted
      // container (mirrors the SessionHealthStrip rescue flow). Bridged to App's
      // `reconnect()` via the window-event listener in useAppBootstrap.
      window.dispatchEvent(new CustomEvent("shipit:reconnect-ws"));
      // The new container starts with the now-resolved mode, so nothing is
      // pending anymore.
      setPendingRestart(false);
      useUiStore.getState().setToast({ message: "Restarting container to apply the new network mode" });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      useUiStore.getState().setToast({ message: `Failed to restart container: ${message}` });
      console.error("[session-egress] restart-to-apply failed:", err);
    } finally {
      setRestarting(false);
    }
  };

  // Would this session resolve to Contained? "inherit" follows the global switch;
  // "contained"/"open" force it. Computed from the live `mode` so toggling to
  // Open hides the warning immediately (Open isn't claiming containment).
  const sessionContained = mode === "open" ? false : mode === "contained" ? true : globalEnabled;
  // Policy says contain but the deployment can't enforce → warn instead of
  // silently implying protection. Mirrors the Settings → Network egress banner.
  const showEnforcementWarning = mode !== undefined && sessionContained && !enforcementActive;

  const globalLabel = globalEnabled ? "Contained" : "Open";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[460px] max-w-[92vw] p-0" data-testid="session-settings-dialog">
        <div className="flex items-center gap-2.5 px-5 pt-4.5 pb-1.5">
          <span className="w-8.5 h-8.5 rounded-lg bg-(--color-bg-tertiary) text-(--color-text-secondary) flex items-center justify-center shrink-0">
            <GlobeIcon size={ICON_SIZE.MD} />
          </span>
          <div>
            <DialogTitle className="text-base">Session settings</DialogTitle>
            <DialogDescription className="text-xs">
              Network access for this session only. Applies the next time its container starts.
            </DialogDescription>
          </div>
        </div>

        <div className="px-5 pt-2 pb-1" role="radiogroup" aria-label="Network access">
          <ModeOption
            icon={<ShieldCheckIcon size={ICON_SIZE.SM} />}
            title="Inherit global"
            desc={`Follow the workspace setting (currently ${globalLabel}). Change it in Settings → Network.`}
            selected={mode === "inherit"}
            disabled={mode === undefined}
            onSelect={() => void handleChange("inherit")}
          />
          <ModeOption
            icon={<ShieldCheckIcon size={ICON_SIZE.SM} weight="fill" />}
            title="Contained"
            desc="Default-deny — only the allowlist (LLM API, GitHub, registries, your added hosts) is reachable, with inline prompts for new hosts."
            selected={mode === "contained"}
            disabled={mode === undefined}
            onSelect={() => void handleChange("contained")}
          />
          <ModeOption
            icon={<ShieldSlashIcon size={ICON_SIZE.SM} />}
            title="Open"
            desc="Unrestricted outbound network access — no allowlist, no prompts."
            selected={mode === "open"}
            disabled={mode === undefined}
            onSelect={() => void handleChange("open")}
          />
        </div>

        {/* Pending — the selected mode resolves to a different containment than the
            live container was started with. Egress is plumbed at container
            creation, so it applies on the next start; offer the existing restart
            as an explicit "apply now". */}
        {pendingRestart && (
          <div
            className="mx-5 mb-1 flex items-center gap-2 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2"
            data-testid="session-settings-pending"
          >
            <span className="shrink-0 text-(--color-text-tertiary)"><ClockClockwiseIcon size={ICON_SIZE.SM} /></span>
            <p className="flex-1 text-xs text-(--color-text-secondary)">
              Pending · applies on next container start
            </p>
            <WithTooltip
              label={
                agentRunning
                  ? "Wait for the current turn to finish"
                  : "Restart this session's container to apply the new network mode now"
              }
            >
              {/* span wrapper so the tooltip still shows while the button is disabled */}
              <span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={agentRunning || restarting}
                  onClick={() => void handleRestart()}
                  data-testid="session-settings-restart"
                >
                  {restarting
                    ? <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
                    : <ArrowsClockwiseIcon size={ICON_SIZE.XS} />}
                  Restart to apply now
                </Button>
              </span>
            </WithTooltip>
          </div>
        )}

        {showEnforcementWarning && (
          <div
            className="mx-5 mb-1 flex items-start gap-2 rounded-md border border-(--color-warning) bg-(--color-warning-subtle) px-3 py-2"
            data-testid="session-settings-enforcement-warning"
          >
            <span className="mt-0.5 shrink-0 text-(--color-warning)"><WarningIcon size={ICON_SIZE.SM} weight="fill" /></span>
            <p className="text-xs text-(--color-warning)">
              Not enforced on this deployment — contained sessions fail to start. See the install notes.
            </p>
          </div>
        )}

        <p className="px-5 pb-4.5 pt-2 text-[11px] text-(--color-text-tertiary)">
          Containment can&rsquo;t fully air-gap a session — the agent&rsquo;s lifeline (the LLM API and
          ShipIt) always stays open. For a workspace with no internet beyond that, start a new
          <span className="text-(--color-text-secondary)"> Sandbox</span> session with Network access off.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function ModeOption({
  icon,
  title,
  desc,
  selected,
  disabled,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={title}
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors mb-1.5 last:mb-0 disabled:opacity-50 ${
        selected
          ? "border-(--color-accent) bg-(--color-accent-subtle)"
          : "border-(--color-border-secondary) bg-(--color-bg-secondary) hover:bg-(--color-bg-hover)"
      }`}
    >
      <span
        className={`mt-0.5 shrink-0 ${selected ? "text-(--color-accent)" : "text-(--color-text-secondary)"}`}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-(--color-text-primary)">{title}</div>
        <p className="text-xs text-(--color-text-secondary) mt-0.5">{desc}</p>
      </div>
      {selected && (
        <span className="mt-0.5 shrink-0 text-(--color-accent)">
          <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" />
        </span>
      )}
    </button>
  );
}
