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
import { Alert } from "../ui/banner.js";
import { WithTooltip } from "../ui/tooltip.js";
import { ICON_SIZE } from "../../design-tokens.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useApi, ApiError } from "../../hooks/useApi.js";
import { SandboxCapabilityToggles } from "../SandboxCapabilityToggles.js";
import { DEFAULT_SANDBOX_CAPABILITIES } from "../../../server/shared/types.js";
import type {
  EgressAllowlistView,
  EgressSessionSettings,
  SandboxCapabilitiesView,
  SessionCapabilities,
} from "../../../server/shared/types.js";

/**
 * Per-session settings dialog (docs/172 / planning#92, docs/279).
 *
 * Holds everything scoped to ONE session:
 *   - for a **sandbox**, its capability grants (docs/279 req 5) — editable after
 *     creation, rendered from the same `SandboxCapabilityToggles` the creation
 *     dialog uses;
 *   - for every **other** session, the network containment override
 *     (Inherit / Contained / Open).
 *
 * The two are mutually exclusive on purpose. A sandbox's Network access IS a
 * capability (docs/211: it only ever tightens), so showing the containment radio
 * group beside it would put two controls over one session's egress in one dialog
 * — a second source of truth for the same question.
 *
 * Deliberately separate from the global Settings → Network dialog (app-wide
 * allowlist); per-session lives with the session.
 *
 * Both halves are CREATION-TIME container choices: the firewall + DNS resolver +
 * SNI-proxy sidecars, and the Docker plumbing, are installed when the container
 * is created. Changing either on a RUNNING session persists it but does NOT
 * re-plumb the live container. So the dialog surfaces a **pending** state — the
 * server diffs what is now resolved against what the live container actually
 * started with (`EgressSessionSettings.pendingRestart` /
 * `SandboxCapabilitiesView.pendingRestart`) — and offers "Restart to apply now",
 * which reuses the existing container-restart lifecycle control
 * (POST /api/sessions/:id/container/restart). Restart is never automatic and is
 * disabled while an agent turn is running (it would kill the agent).
 *
 * Wired with direct fetches so it doesn't depend on the Settings store, which is
 * single-session-scoped and only loaded while that dialog is open.
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
  // docs/279 — a sandbox's capability grants. `undefined` until the fetch
  // resolves (the toggles render disabled meanwhile); never fetched at all for a
  // non-sandbox session, which has no capability set.
  const [capabilities, setCapabilities] = useState<SessionCapabilities | undefined>(undefined);
  const [savingCapabilities, setSavingCapabilities] = useState(false);

  const api = useApi();
  // docs/279 — which half of this dialog applies. Read from the session list
  // (the same source the sandbox banner and the sidebar badge use) rather than
  // inferred from a failed capabilities fetch, so the dialog renders the right
  // shape on the first frame instead of flipping after a round-trip.
  const isSandbox = useSessionStore(
    (s) => s.sessions.find((session) => session.id === sessionId)?.kind === "sandbox",
  );
  // The active session's live "is an agent turn running" flag. The dialog only
  // renders for the current session, so this is the right session's state. A
  // restart would kill the running agent (see CLAUDE.md never-kill rules), so it
  // gates the restart action.
  const agentRunning = useSessionStore((s) => s.isLoading);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: read the session's current override when the dialog opens
  useEffect(() => {
    if (!open || isSandbox) return;
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
  }, [sessionId, open, isSandbox]);

  // docs/279 — a sandbox's grants + the server's pending-restart verdict. A
  // separate fetch from the egress one above because the two are mutually
  // exclusive halves of this dialog: a sandbox has no containment override to
  // read, and every other session has no capability set.
  // eslint-disable-next-line no-restricted-syntax -- external system sync: read this sandbox's grants when the dialog opens
  useEffect(() => {
    if (!open || !isSandbox) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/capabilities`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const view = (await res.json()) as SandboxCapabilitiesView;
        if (!cancelled) {
          setCapabilities(view.capabilities);
          setPendingRestart(view.pendingRestart);
        }
      } catch (err) {
        // Leave the toggles disabled rather than rendering a guessed set the
        // user could act on: an optimistic default here would show grants this
        // session may not have.
        console.error("[session-capabilities] failed to read grants:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, open, isSandbox]);

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

  /**
   * docs/279 — write the whole capability set. Optimistic: the toggle moves
   * immediately and reverts on failure, matching how the network mode above
   * behaves, because the round-trip is a local write and a settings toggle that
   * lags a click reads as broken.
   *
   * The server returns the normalized set it actually stored, which is not
   * always what was sent — `normalizeCapabilities` clears `dangerousGitHubOps`
   * when `git` is off — so the response, not the optimistic value, is what the
   * toggles end up showing.
   */
  const handleCapabilitiesChange = async (next: SessionCapabilities) => {
    const prev = capabilities;
    setCapabilities(next);
    setSavingCapabilities(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/capabilities`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capabilities: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const view = (await res.json()) as SandboxCapabilitiesView;
      setCapabilities(view.capabilities);
      setPendingRestart(view.pendingRestart);
    } catch (err) {
      setCapabilities(prev);
      useUiStore.getState().setToast({ message: "Failed to update this session's capabilities" });
      console.error("[session-capabilities] failed to write grants:", err);
    } finally {
      setSavingCapabilities(false);
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
      useUiStore.getState().setToast({
        message: isSandbox
          ? "Restarting container to apply the new capabilities"
          : "Restarting container to apply the new network mode",
      });
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
              {isSandbox
                ? "What the agent in this sandbox may use. GitHub access applies at once; Docker and Network apply the next time its container starts."
                : "Network access for this session only. Applies the next time its container starts."}
            </DialogDescription>
          </div>
        </div>

        {/* docs/279 — a sandbox edits its capability grants here; every other
            session edits its containment override. Mutually exclusive: a
            sandbox's Network access IS one of these grants, so rendering both
            would give one session's egress two controls. */}
        {isSandbox ? (
          <div className="px-5 pt-1.5 pb-1" data-testid="session-settings-capabilities">
            <SandboxCapabilityToggles
              capabilities={capabilities ?? DEFAULT_SANDBOX_CAPABILITIES}
              onChange={(next) => void handleCapabilitiesChange(next)}
              disabled={capabilities === undefined || savingCapabilities}
            />
          </div>
        ) : (
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
        )}

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
                  : isSandbox
                    ? "Restart this session's container to apply the new capabilities now"
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
          <Alert
            variant="warning"
            className="mx-5 mb-1"
            data-testid="session-settings-enforcement-warning"
          >
            <span className="mt-0.5 shrink-0 text-(--color-warning)"><WarningIcon size={ICON_SIZE.SM} weight="fill" /></span>
            <p>
              Not enforced on this deployment — contained sessions fail to start. See the install notes.
            </p>
          </Alert>
        )}

        <p className="px-5 pb-4.5 pt-2 text-[11px] text-(--color-text-tertiary)">
          {isSandbox ? (
            <>
              Turning a capability off removes the agent&rsquo;s access to it and destroys nothing it
              already made — containers it built keep running until this session is archived. Network
              access off still isn&rsquo;t an air-gap: the agent&rsquo;s lifeline (the LLM API and
              ShipIt) always stays open.
            </>
          ) : (
            <>
              Containment can&rsquo;t fully air-gap a session — the agent&rsquo;s lifeline (the LLM API and
              ShipIt) always stays open. For a workspace with no internet beyond that, start a new
              <span className="text-(--color-text-secondary)"> Sandbox</span> session with Network access off.
            </>
          )}
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
