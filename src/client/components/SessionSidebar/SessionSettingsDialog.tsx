// eslint-disable-next-line no-restricted-imports -- useEffect: load this session's egress override when the dialog opens (external system sync)
import { useEffect, useState } from "react";
import { GlobeIcon, ShieldCheckIcon, ShieldSlashIcon, WarningIcon, CheckCircleIcon } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog.js";
import { ICON_SIZE } from "../../design-tokens.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { EgressAllowlistView } from "../../../server/shared/types.js";

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
 * The override applies on the session's next container start. Wired with direct
 * fetches (GET the effective view for the current value, PUT to set/clear) so it
 * doesn't depend on the Settings store, which is single-session-scoped and only
 * loaded while that dialog is open.
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
    } catch (err) {
      setMode(prev);
      useUiStore.getState().setToast({ message: "Failed to update this session's network mode" });
      console.error("[session-egress] failed to set override:", err);
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
