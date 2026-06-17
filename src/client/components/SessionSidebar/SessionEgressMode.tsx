// eslint-disable-next-line no-restricted-imports -- useEffect: load this session's egress override when the menu opens (external system sync)
import { useEffect, useState } from "react";
import { WarningIcon } from "@phosphor-icons/react";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../ui/dropdown-menu.js";
import { ICON_SIZE } from "../../design-tokens.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { EgressAllowlistView } from "../../../server/shared/types.js";

/**
 * Per-session network-containment override, rendered inside the active
 * session's overflow menu (docs/172 / SHI-90).
 *
 * This is the session-scoped half of egress configuration — it deliberately
 * lives here on the session's own menu rather than in the global Settings →
 * Network dialog, which holds app-wide settings only. Three modes:
 *   - Inherit — follow the global containment toggle (the default).
 *   - Contained — force default-deny + allowlist for this session.
 *   - Open — unrestricted egress for this session only.
 *
 * The override applies on the session's next container start, matching the
 * Settings copy. Wired with direct fetches (GET the effective view for the
 * current value, PUT to set/clear) so it doesn't depend on the Settings store,
 * which is single-session-scoped and only loaded while the dialog is open.
 */

type Mode = "inherit" | "contained" | "open";

const modeFromOverride = (override: boolean | null): Mode =>
  override === null ? "inherit" : override ? "contained" : "open";

const overrideFromMode = (mode: Mode): boolean | null =>
  mode === "inherit" ? null : mode === "contained";

export function SessionEgressMode({ sessionId }: { sessionId: string }) {
  // undefined = not yet loaded; render the group disabled-ish until it resolves.
  const [mode, setMode] = useState<Mode | undefined>(undefined);
  // Deployment-level facts (not changed by this session's override): the global
  // containment switch and whether this deployment can actually ENFORCE
  // containment. Optimistic `true` so a capable host never flashes the warning.
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [enforcementActive, setEnforcementActive] = useState(true);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: read the session's current override when this menu mounts (open)
  useEffect(() => {
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
  }, [sessionId]);

  const handleChange = async (next: string) => {
    const m = next as Mode;
    const prev = mode;
    setMode(m);
    try {
      const res = await fetch(`/api/egress/session/${encodeURIComponent(sessionId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ override: overrideFromMode(m) }),
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
  // silently implying protection. Mirrors the Settings → Network egress banner,
  // condensed for the menu.
  const showEnforcementWarning = mode !== undefined && sessionContained && !enforcementActive;

  return (
    <div data-testid="session-egress-mode">
      <DropdownMenuLabel>Network access</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mode ?? "inherit"} onValueChange={(v) => void handleChange(v)}>
        <DropdownMenuRadioItem value="inherit">Inherit global</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="contained">Contained</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="open">Open</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      {showEnforcementWarning && (
        <div
          className="flex items-start gap-1.5 px-2 py-1.5 text-xs text-(--color-warning)"
          data-testid="session-egress-enforcement-warning"
        >
          <WarningIcon size={ICON_SIZE.XS} weight="fill" className="mt-0.5 shrink-0" />
          <span>Not enforced on this deployment — contained sessions fail to start. See install notes.</span>
        </div>
      )}
    </div>
  );
}
