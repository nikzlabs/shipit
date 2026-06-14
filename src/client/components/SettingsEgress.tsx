// eslint-disable-next-line no-restricted-imports -- useEffect: load egress allowlist on mount / session change (external system sync)
import { useEffect, useState } from "react";
import { TrashIcon, PencilSimpleIcon, ShieldCheckIcon, CheckIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { useEgressStore, type EgressScope } from "../stores/egress-store.js";
import { useSessionStore } from "../stores/session-store.js";
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

/** Small segmented control (used for the per-session override + add scope). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  testId?: string;
}) {
  return (
    <div className="inline-flex rounded-md border border-(--color-border-secondary) p-0.5" role="group" data-testid={testId}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            data-testid={testId ? `${testId}-${opt.value}` : undefined}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-[color,background-color] duration-(--duration-fast) ${
              active
                ? "bg-(--color-accent) text-(--color-accent-text)"
                : "text-(--color-text-secondary) hover:text-(--color-text-primary)"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
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
 * Settings → Advanced → "Network egress" (docs/172 / SHI-90).
 *
 * A first-class allowlist editor: the default-on containment toggle, a
 * per-session containment override (when a session is open), and the effective
 * allowlist with provenance — user-added entries are removable/editable at
 * global OR per-session scope; built-in / operator / MCP entries are shown
 * read-only so the user can see *why* each host is reachable. Egress is a
 * container-start choice, so the copy states changes apply on the next restart;
 * a user-scoped add to the open session also reloads it live.
 */
export function SettingsEgress() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const loaded = useEgressStore((s) => s.loaded);
  const entries = useEgressStore((s) => s.entries) ?? [];
  const globalEnabled = useEgressStore((s) => s.globalEnabled);
  const override = useEgressStore((s) => s.override);
  const effectiveContained = useEgressStore((s) => s.effectiveContained);
  const defaultsCustomized = useEgressStore((s) => s.defaultsCustomized);

  const [hostInput, setHostInput] = useState("");
  const [addScope, setAddScope] = useState<EgressScope>("global");
  const [busy, setBusy] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: fetch the effective allowlist when the panel opens / the active session changes
  useEffect(() => {
    void useEgressStore.getState().load(sessionId ?? null).catch((err: unknown) => {
      console.error("[settings] failed to load egress allowlist:", err);
    });
  }, [sessionId]);

  const toast = (message: string) => useUiStore.getState().setToast({ message });

  const handleToggle = async (v: boolean) => {
    try {
      await useEgressStore.getState().setGlobalEnabled(v);
    } catch (err) {
      toast("Failed to update egress containment setting");
      console.error("[settings] egress toggle failed:", err);
    }
  };

  const handleOverride = async (mode: "inherit" | "contained" | "open") => {
    const value = mode === "inherit" ? null : mode === "contained";
    try {
      await useEgressStore.getState().setOverride(value);
    } catch (err) {
      toast("Failed to update this session's egress override");
      console.error("[settings] egress override failed:", err);
    }
  };

  const handleAdd = async () => {
    const host = hostInput.trim();
    if (!host || busy) return;
    setBusy(true);
    try {
      await useEgressStore.getState().addHost(host, addScope);
      setHostInput("");
    } catch (err) {
      toast(`Failed to add ${host} to the allowlist`);
      console.error("[settings] egress add host failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (entry: EgressAllowlistEntry) => {
    const scope: EgressScope = entry.source === "user-session" ? "session" : "global";
    try {
      await useEgressStore.getState().removeHost(entry.host, scope);
    } catch (err) {
      toast(`Failed to remove ${entry.host} from the allowlist`);
      console.error("[settings] egress remove host failed:", err);
    }
  };

  const handleEdit = async (entry: EgressAllowlistEntry, next: string) => {
    const scope: EgressScope = entry.source === "user-session" ? "session" : "global";
    try {
      await useEgressStore.getState().editHost(entry.host, next, scope);
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
  const overrideMode: "inherit" | "contained" | "open" = override === null ? "inherit" : override ? "contained" : "open";

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

        {sessionId && (
          <div className="flex items-center justify-between py-1 gap-4" data-testid="settings-egress-session-override">
            <div>
              <span className="text-sm text-(--color-text-primary)">This session</span>
              <p className="text-xs text-(--color-text-tertiary)">
                Override containment for the open session only — currently{" "}
                <span className="text-(--color-text-secondary)">{effectiveContained ? "contained" : "open"}</span>.
                Applies on its next container start.
              </p>
            </div>
            <Segmented
              value={overrideMode}
              onChange={(v) => void handleOverride(v)}
              testId="settings-egress-override"
              options={[
                { value: "inherit", label: "Inherit" },
                { value: "contained", label: "Contained" },
                { value: "open", label: "Open" },
              ]}
            />
          </div>
        )}
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
          {sessionId && (
            <Segmented
              value={addScope}
              onChange={setAddScope}
              testId="settings-egress-add-scope"
              options={[
                { value: "global", label: "Global" },
                { value: "session", label: "This session" },
              ]}
            />
          )}
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
