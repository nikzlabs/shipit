// eslint-disable-next-line no-restricted-imports -- useEffect: load the global egress allowlist on mount (external system sync)
import { useEffect, useState } from "react";
import { TrashIcon, PencilSimpleIcon, ShieldCheckIcon, CheckIcon, XIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { Alert } from "./ui/banner.js";
import { useEgressStore } from "../stores/egress-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { EgressAllowlistEntry, EgressAllowlistSource } from "../../server/shared/types.js";

/** Provenance chip metadata per source — label + Badge variant. */
const SOURCE_META: Record<EgressAllowlistSource, { label: string; variant: "default" | "info" | "success" }> = {
  builtin: { label: "Default", variant: "default" },
  operator: { label: "Operator", variant: "default" },
  mcp: { label: "MCP", variant: "info" },
  "user-global": { label: "Added", variant: "success" },
  "user-session": { label: "This session", variant: "success" },
};

/** Toggle switch matching the Settings dialog style. */
function ToggleSwitch({ enabled, onToggle, testId }: { enabled: boolean; onToggle: (v: boolean) => void; testId?: string }) {
  return (
    <button
      onClick={() => onToggle(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-[background-color] duration-(--duration-fast) ${
        enabled ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
      }`}
      role="switch"
      aria-checked={enabled}
      data-testid={testId}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-(--duration-fast) ${
          enabled ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/** One editable allowlist row (user-added: removable + editable). */
function AllowlistRow({
  entry,
  onRemove,
  onEdit,
}: {
  entry: EgressAllowlistEntry;
  onRemove: () => void;
  onEdit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.host);
  const meta = SOURCE_META[entry.source];

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== entry.host) onEdit(next);
    else setDraft(entry.host);
  };

  return (
    <li
      className="flex items-center justify-between gap-2 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-1.5"
      data-testid={`settings-egress-row-${entry.host}`}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { setDraft(entry.host); setEditing(false); }
          }}
          className="flex-1 rounded bg-(--color-bg-tertiary) border border-(--color-border-focus) px-2 py-1 text-sm font-mono text-(--color-text-primary) focus:outline-none"
          data-testid={`settings-egress-edit-input-${entry.host}`}
        />
      ) : (
        <span className="flex-1 truncate text-sm text-(--color-text-primary) font-mono">{entry.host}</span>
      )}

      <Badge variant={meta.variant}>{meta.label}</Badge>

      {entry.removable && (
        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <button
                onClick={commit}
                className="text-(--color-text-tertiary) hover:text-(--color-success) transition-[color] duration-(--duration-fast)"
                aria-label="Save"
                data-testid={`settings-egress-edit-save-${entry.host}`}
              >
                <CheckIcon size={ICON_SIZE.SM} />
              </button>
              <button
                onClick={() => { setDraft(entry.host); setEditing(false); }}
                className="text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast)"
                aria-label="Cancel"
              >
                <XIcon size={ICON_SIZE.SM} />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => { setDraft(entry.host); setEditing(true); }}
                className="text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast)"
                aria-label={`Edit ${entry.host}`}
                data-testid={`settings-egress-edit-${entry.host}`}
              >
                <PencilSimpleIcon size={ICON_SIZE.SM} />
              </button>
              <button
                onClick={onRemove}
                className="text-(--color-text-tertiary) hover:text-(--color-error) transition-[color] duration-(--duration-fast)"
                aria-label={`Remove ${entry.host}`}
                data-testid={`settings-egress-host-remove-${entry.host}`}
              >
                <TrashIcon size={ICON_SIZE.SM} />
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Settings → Network — "Network egress" (docs/172 / SHI-90).
 *
 * A **global-only** first-class allowlist editor: the default-on containment
 * toggle and the *global* effective allowlist with provenance — user-added
 * entries are removable/editable; built-in / operator / MCP entries are shown
 * read-only so the user can see *why* each host is reachable. The view is loaded
 * with **no session in scope** (`load(null)`), so per-session ("This session")
 * entries never appear here and every editable row is global — the Settings
 * dialog holds app-wide settings only.
 *
 * The one per-*session* egress control — the containment override (Inherit /
 * Contained / Open) — deliberately lives on the session's own menu in the
 * sidebar (Session settings → `SessionSettingsDialog.tsx`), not in this global
 * dialog. (The
 * blocked-egress card's "Add to allowlist" persists to the *global* scope, so it
 * shows up in this editor too.) Egress is a container-start choice, so the copy
 * states changes apply on the next restart.
 */
export function SettingsEgress() {
  const loaded = useEgressStore((s) => s.loaded);
  const entries = useEgressStore((s) => s.entries) ?? [];
  const globalEnabled = useEgressStore((s) => s.globalEnabled);
  const enforcementActive = useEgressStore((s) => s.enforcementActive);
  const defaultsCustomized = useEgressStore((s) => s.defaultsCustomized);

  const [hostInput, setHostInput] = useState("");
  const [busy, setBusy] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: fetch the GLOBAL effective allowlist when the panel opens
  useEffect(() => {
    // Load with no session in scope: Settings → Network is global-only, so the
    // effective list must exclude per-session ("This session") entries. The
    // per-session containment override lives on the session's own menu instead.
    void useEgressStore.getState().load(null).catch((err: unknown) => {
      console.error("[settings] failed to load egress allowlist:", err);
    });
  }, []);

  const toast = (message: string) => useUiStore.getState().setToast({ message });

  const handleToggle = async (v: boolean) => {
    try {
      await useEgressStore.getState().setGlobalEnabled(v);
    } catch (err) {
      toast("Failed to update egress containment setting");
      console.error("[settings] egress toggle failed:", err);
    }
  };

  const handleAdd = async () => {
    const host = hostInput.trim();
    if (!host || busy) return;
    setBusy(true);
    try {
      // Adds from the global Settings dialog always land at global scope;
      // per-session adds happen on the blocked-egress card instead.
      await useEgressStore.getState().addHost(host, "global");
      setHostInput("");
    } catch (err) {
      toast(`Failed to add ${host} to the allowlist`);
      console.error("[settings] egress add host failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (entry: EgressAllowlistEntry) => {
    // Global-only view, so every editable entry is global-scoped.
    try {
      await useEgressStore.getState().removeHost(entry.host, "global");
    } catch (err) {
      toast(`Failed to remove ${entry.host} from the allowlist`);
      console.error("[settings] egress remove host failed:", err);
    }
  };

  const handleEdit = async (entry: EgressAllowlistEntry, next: string) => {
    try {
      await useEgressStore.getState().editHost(entry.host, next, "global");
    } catch (err) {
      toast(`Failed to update ${entry.host}`);
      console.error("[settings] egress edit host failed:", err);
    }
  };

  const handleRestoreDefaults = async () => {
    try {
      await useEgressStore.getState().restoreDefaults();
    } catch (err) {
      toast("Failed to restore default allowlist");
      console.error("[settings] egress restore defaults failed:", err);
    }
  };

  // Built-in defaults are overridable, so they live in the editable list
  // alongside user-added hosts. Operator (deployment env) + MCP (connected
  // servers) hosts are derived live and shown read-only.
  const editableEntries = entries.filter((e) => e.removable);
  const derivedEntries = entries.filter((e) => !e.removable);

  // Containment POLICY says "contain" but the deployment can't ENFORCE it
  // (enforcement off, or no NET_ADMIN sidecar image). Warn rather than show a
  // reassuring "Contained" — a contained session would fail closed / run open.
  // Global-only view, so the policy is the global switch.
  const showEnforcementWarning = loaded && globalEnabled && !enforcementActive;

  return (
    <div className="space-y-4" data-testid="settings-egress">
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

        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Contain outbound network access</span>
            <p className="text-xs text-(--color-text-tertiary)">
              On (recommended): default-deny egress with an allowlist and inline prompts. Off: unrestricted
              egress, no prompts. Applies the next time each session&rsquo;s container starts.
            </p>
          </div>
          <ToggleSwitch enabled={globalEnabled} onToggle={(v) => void handleToggle(v)} testId="settings-egress-contained" />
        </div>

        {showEnforcementWarning && (
          <Alert
            variant="warning"
            data-testid="settings-egress-enforcement-warning"
          >
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

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-(--color-text-secondary)">Allowlist</span>
          {defaultsCustomized && (
            <button
              type="button"
              onClick={() => void handleRestoreDefaults()}
              className="text-xs text-(--color-text-link) hover:underline"
              data-testid="settings-egress-restore-defaults"
            >
              Restore defaults
            </button>
          )}
        </div>
        <p className="text-xs text-(--color-text-tertiary)">
          Hosts the agent may reach. The shipped defaults are listed below and can be removed or
          edited — &ldquo;Restore defaults&rdquo; brings them back. Prefix with a dot
          (e.g. <code className="text-(--color-text-secondary)">.example.com</code>) to also match subdomains.
          Changes apply on the next container start.
        </p>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={hostInput}
            placeholder="api.example.com or .example.com"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setHostInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleAdd(); } }}
            className="flex-1 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
            data-testid="settings-egress-host-input"
          />
          <Button
            variant="primary"
            size="md"
            disabled={busy || !hostInput.trim()}
            onClick={() => void handleAdd()}
            className="rounded-md"
            data-testid="settings-egress-host-add"
          >
            Add
          </Button>
        </div>

        {/* Editable entries — built-in defaults + user-added, all removable/editable. */}
        {loaded && editableEntries.length === 0 && (
          <p className="text-xs text-(--color-text-tertiary)" data-testid="settings-egress-empty">
            The allowlist is empty — restore defaults or add a host above.
          </p>
        )}
        {editableEntries.length > 0 && (
          <ul className="flex flex-col gap-1" data-testid="settings-egress-user-list">
            {editableEntries.map((entry) => (
              <AllowlistRow
                key={`${entry.source}:${entry.host}`}
                entry={entry}
                onRemove={() => void handleRemove(entry)}
                onEdit={(next) => void handleEdit(entry, next)}
              />
            ))}
          </ul>
        )}

        {/* Read-only derived entries — operator (deployment) + MCP (connected servers). */}
        {derivedEntries.length > 0 && (
          <div className="space-y-1 pt-1" data-testid="settings-egress-derived">
            <span className="text-xs font-medium text-(--color-text-tertiary)">
              Also allowed — from your deployment &amp; connected MCP servers
            </span>
            <ul className="flex flex-col gap-1">
              {derivedEntries.map((entry) => (
                <li
                  key={`${entry.source}:${entry.host}`}
                  className="flex items-center justify-between gap-2 rounded-md px-3 py-1"
                >
                  <span className="flex-1 truncate text-sm text-(--color-text-secondary) font-mono">{entry.host}</span>
                  <Badge variant={SOURCE_META[entry.source].variant}>{SOURCE_META[entry.source].label}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
