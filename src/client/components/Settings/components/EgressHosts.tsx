/**
 * The global egress allowlist, the panel `network.egress.hosts` names
 * (docs/308-data-driven-settings).
 *
 * It is loaded with **no session in scope** (`load(null)`), so per-session
 * ("This session") entries never appear here and every editable row is global —
 * the Settings dialog holds app-wide settings only.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: load the global egress allowlist on mount (external system sync)
import { useEffect, useState } from "react";
import {
  TrashIcon,
  PencilSimpleIcon,
  CheckIcon,
  XIcon,
  WarningIcon,
  CheckCircleIcon,
  ClockClockwiseIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Button } from "../../ui/button.js";
import { Badge } from "../../ui/badge.js";
import { useEgressStore } from "../../../stores/egress-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { summarizeEgressGrant } from "../../egress-grant-summary.js";
import { SettingCopy, bindSetting } from "../declared.js";
import { RichErrorText } from "../../PrLifecycleCard/RichErrorText.js";
import type {
  EgressAllowlistEntry,
  EgressAllowlistSource,
  EgressHostGrantOutcome,
} from "../../../../server/shared/types.js";

const SOURCE_META: Record<EgressAllowlistSource, { label: string; variant: "default" | "info" | "success" }> = {
  builtin: { label: "Default", variant: "default" },
  operator: { label: "Operator", variant: "default" },
  mcp: { label: "MCP", variant: "info" },
  "user-global": { label: "Added", variant: "success" },
  "user-session": { label: "This session", variant: "success" },
};

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
          aria-label={`Host, editing ${entry.host}`}
          className="flex-1 rounded bg-(--color-bg-tertiary) border border-(--color-border-focus) px-2 py-1 text-sm font-mono text-(--color-text-primary) focus:outline-none"
          data-testid={`settings-egress-edit-input-${entry.host}`}
          {...bindSetting("network.egress.hosts[].host")}
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
                aria-label={`Save ${entry.host}`}
                data-testid={`settings-egress-edit-save-${entry.host}`}
                {...bindSetting("network.egress.hosts[].host")}
              >
                <CheckIcon size={ICON_SIZE.SM} />
              </button>
              <button
                onClick={() => { setDraft(entry.host); setEditing(false); }}
                className="text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast)"
                aria-label={`Stop editing ${entry.host}`}
                {...bindSetting("network.egress.hosts[].host")}
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
                {...bindSetting("network.egress.hosts[].host")}
              >
                <PencilSimpleIcon size={ICON_SIZE.SM} />
              </button>
              <button
                onClick={onRemove}
                className="text-(--color-text-tertiary) hover:text-(--color-error) transition-[color] duration-(--duration-fast)"
                aria-label={`Remove ${entry.host}`}
                data-testid={`settings-egress-host-remove-${entry.host}`}
                {...bindSetting("network.egress.hosts")}
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

function GrantOutcome({
  grant,
  onDismiss,
}: {
  grant: EgressHostGrantOutcome;
  onDismiss: () => void;
}) {
  const summary = summarizeEgressGrant(grant);
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2"
      data-testid="settings-egress-grant"
    >
      <span className="mt-0.5 shrink-0">
        {summary.kind === "excluded" ? (
          <WarningIcon size={ICON_SIZE.SM} className="text-(--color-warning)" />
        ) : summary.kind === "live-everywhere" ? (
          <CheckCircleIcon size={ICON_SIZE.SM} className="text-(--color-success)" />
        ) : (
          <ClockClockwiseIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary)" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-xs text-(--color-text-primary)">
          <RichErrorText text={summary.headline} links={false} />
        </p>
        <p className="text-xs text-(--color-text-tertiary)">{summary.detail}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-[color] duration-(--duration-fast)"
      >
        <XIcon size={ICON_SIZE.SM} />
      </button>
    </div>
  );
}

export function EgressHosts() {
  const loaded = useEgressStore((s) => s.loaded);
  const entries = useEgressStore((s) => s.entries) ?? [];
  const defaultsCustomized = useEgressStore((s) => s.defaultsCustomized);

  const [hostInput, setHostInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<EgressHostGrantOutcome | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: fetch the GLOBAL effective allowlist when the panel opens
  useEffect(() => {
    void useEgressStore.getState().load(null).catch((err: unknown) => {
      console.error("[settings] failed to load egress allowlist:", err);
    });
  }, []);

  const toast = (message: string) => useUiStore.getState().setToast({ message });

  const handleAdd = async () => {
    const host = hostInput.trim();
    if (!host || busy) return;
    setBusy(true);
    setGrant(null);
    try {
      setGrant(await useEgressStore.getState().addHost(host, "global"));
      setHostInput("");
    } catch (err) {
      toast(`Failed to add ${host} to the allowlist`);
      console.error("[settings] egress add host failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (entry: EgressAllowlistEntry) => {
    setGrant(null);
    try {
      await useEgressStore.getState().removeHost(entry.host, "global");
    } catch (err) {
      toast(`Failed to remove ${entry.host} from the allowlist`);
      console.error("[settings] egress remove host failed:", err);
    }
  };

  const handleEdit = async (entry: EgressAllowlistEntry, next: string) => {
    setGrant(null);
    try {
      await useEgressStore.getState().editHost(entry.host, next, "global");
    } catch (err) {
      toast(`Failed to update ${entry.host}`);
      console.error("[settings] egress edit host failed:", err);
    }
  };

  const handleRestoreDefaults = async () => {
    setGrant(null);
    try {
      await useEgressStore.getState().restoreDefaults();
    } catch (err) {
      toast("Failed to restore default allowlist");
      console.error("[settings] egress restore defaults failed:", err);
    }
  };

  const editableEntries = entries.filter((e) => e.removable);
  const derivedEntries = entries.filter((e) => !e.removable);

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <SettingCopy settingKey="network.egress.hosts" />
        {defaultsCustomized && (
          <button
            type="button"
            onClick={() => void handleRestoreDefaults()}
            className="shrink-0 text-xs text-(--color-text-link) hover:underline"
            data-testid="settings-egress-restore-defaults"
            {...bindSetting("network.egress.hosts")}
          >
            Restore defaults
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={hostInput}
          placeholder="api.example.com or .example.com"
          aria-label="Host to allow"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setHostInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleAdd(); } }}
          className="flex-1 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
          data-testid="settings-egress-host-input"
          {...bindSetting("network.egress.hosts[].host")}
        />
        <Button
          variant="primary"
          size="md"
          disabled={busy || !hostInput.trim()}
          onClick={() => void handleAdd()}
          className="rounded-md"
          data-testid="settings-egress-host-add"
          aria-label="Add host to the allowlist"
          {...bindSetting("network.egress.hosts")}
        >
          Add
        </Button>
      </div>

      {grant && <GrantOutcome grant={grant} onDismiss={() => setGrant(null)} />}

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
  );
}
