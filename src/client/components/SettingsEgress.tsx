import { ShieldCheckIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Alert } from "./ui/banner.js";
import { useEgressStore } from "../stores/egress-store.js";
import { DeclaredSettings } from "./Settings/DeclaredSettings.js";
import { useSetting } from "./Settings/declared-setting.js";

/**
 * Settings → Network — "Network egress" (docs/172 / planning#92).
 *
 * A **global-only** first-class allowlist editor: the default-on containment
 * toggle and the *global* effective allowlist with provenance. Both are
 * generated from their declarations (docs/308-data-driven-settings slices 2 and
 * 6) — the toggle as an ordinary row, the allowlist as the component
 * `network.egress.hosts` names — so this file is what is left over: the
 * heading, the explanation, and the enforcement warning.
 *
 * The one per-*session* egress control — the containment override (Inherit /
 * Contained / Open) — deliberately lives on the session's own menu in the
 * sidebar (Session settings → `SessionSettingsDialog.tsx`), not in this global
 * dialog. (The blocked-egress card's "Add to allowlist" persists to the
 * *global* scope, so it shows up in this editor too.) Egress is a
 * container-start choice, so the copy states changes apply on the next restart.
 */
export function SettingsEgress() {
  const loaded = useEgressStore((s) => s.loaded);
  const enforcementActive = useEgressStore((s) => s.enforcementActive);
  /*
    The warning is about the toggle right above it, so it reads the same value
    the toggle does — the setting's own, rather than this panel's copy of it in
    the allowlist view. The two agree, and reading one of them means they cannot
    disagree for the round trip after a change.
  */
  const contained = useSetting("network.egressContained").value === true;

  const showEnforcementWarning = loaded && contained && !enforcementActive;

  return (
    <div className="space-y-4" data-testid="settings-egress">
      <DeclaredSettings
        tab="network"
        notes={{
          "": (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-(--color-text-secondary)"><ShieldCheckIcon size={ICON_SIZE.SM} /></span>
                <h3 className="text-sm font-medium text-(--color-text-primary)">Network egress</h3>
              </div>
              <p className="text-sm text-(--color-text-secondary)">
                When contained, session containers can only reach an allowlist of known hosts (the agent&rsquo;s
                API, your git host, package registries, and your connected MCP servers). This is the main
                defense against a prompt-injected agent exfiltrating your credentials.
              </p>
            </div>
          ),
        }}
        /* Both of these report on the containment toggle rather than on the
           section, and a section `note` renders above its rows. */
        rowNotes={{
          "network.egressContained": (
            <div className="space-y-3">
              {showEnforcementWarning && (
                <Alert variant="warning" data-testid="settings-egress-enforcement-warning">
                  <span className="mt-0.5 shrink-0 text-(--color-warning)"><WarningIcon size={ICON_SIZE.SM} weight="fill" /></span>
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-(--color-warning)">Contained — NOT enforced on this deployment</p>
                    <p className="text-xs text-(--color-text-tertiary)">
                      The containment policy is on, but this deployment can&rsquo;t enforce it. Build/provide the egress
                      sidecar image, or this host can&rsquo;t run the required NET_ADMIN sidecar — see the install notes.
                      Until then, contained sessions fail to start (or run with open egress if containment is disabled).
                    </p>
                  </div>
                </Alert>
              )}
              <p className="text-xs text-(--color-text-tertiary)">
                To contain or open a single session, use <span className="text-(--color-text-secondary)">Network access</span> on
                that session&rsquo;s menu in the sidebar.
              </p>
            </div>
          ),
        }}
      />
    </div>
  );
}
