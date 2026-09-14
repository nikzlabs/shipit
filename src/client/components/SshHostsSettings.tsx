/**
 * Settings → Integrations → SSH hosts (docs/305-ssh-hosts, req 4).
 *
 * The registry is account-wide and one key per destination (req 11). It is NOT
 * a repo secret and deliberately does not live in Settings → Secrets: a secret
 * resolves into a Compose service, and the agent edits the Compose file.
 *
 * Nothing here can show a private key, because nothing server-side returns one —
 * every read is the public projection. What the user needs from this screen is
 * the `authorized_keys` line to install on the server, and the fingerprint of
 * the host key ShipIt recorded, to compare with the server's own.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: load the account-wide registry when this panel mounts (external system sync)
import { useEffect, useState } from "react";
import { HardDrivesIcon, KeyIcon, PlusIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { CopyButton } from "./ui/copy-button.js";
import { useUiStore } from "../stores/ui-store.js";
import { bindSetting } from "./Settings/declared.js";
import type { SshHostPublic } from "../../server/shared/types.js";

const FIELD_CLASS =
  "w-full bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded px-2.5 py-1.5 "
  + "text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none "
  + "focus:ring-1 focus:ring-(--color-border-focus)";

export function SshHostsSettings() {
  const [hosts, setHosts] = useState<SshHostPublic[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ label: "", address: "", user: "", port: "22" });

  // eslint-disable-next-line no-restricted-syntax -- external system sync: read the registry on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/ssh-hosts");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { hosts: SshHostPublic[] };
        if (!cancelled) setHosts(body.hosts);
      } catch (err) {
        console.error("[ssh-hosts] failed to read the registry:", err);
        if (!cancelled) setHosts([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/ssh-hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: form.label,
          address: form.address,
          user: form.user,
          port: Number(form.port) || 22,
        }),
      });
      const body = (await res.json()) as { host?: SshHostPublic; error?: string };
      if (!res.ok || !body.host) throw new Error(body.error ?? `HTTP ${res.status}`);
      setHosts((prev) => [...(prev ?? []), body.host!]);
      setForm({ label: "", address: "", user: "", port: "22" });
      setAdding(false);
    } catch (err) {
      useUiStore.getState().setToast({ message: `Could not add the SSH host: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (host: SshHostPublic) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ssh-hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHosts((prev) => (prev ?? []).filter((h) => h.id !== host.id));
    } catch (err) {
      useUiStore.getState().setToast({ message: `Could not remove ${host.label}: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const forgetHostKey = async (host: SshHostPublic) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ssh-hosts/${encodeURIComponent(host.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forgetHostKey: true }),
      });
      const body = (await res.json()) as { host?: SshHostPublic };
      if (!res.ok || !body.host) throw new Error(`HTTP ${res.status}`);
      setHosts((prev) => (prev ?? []).map((h) => (h.id === host.id ? body.host! : h)));
    } catch (err) {
      useUiStore.getState().setToast({ message: `Could not forget the host key: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = form.label.trim() && form.address.trim() && form.user.trim();

  return (
    <div className="flex flex-col gap-2" data-testid="ssh-hosts-settings">
      {hosts?.length === 0 && !adding && (
        <p className="text-xs text-(--color-text-tertiary)">
          No destinations yet. ShipIt generates a key per destination; you install its public line on the server.
        </p>
      )}

      {(hosts ?? []).map((host) => (
        <div
          key={host.id}
          className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3"
          data-testid="ssh-host-row"
        >
          <div className="flex flex-wrap items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) text-(--color-text-primary)">
              <HardDrivesIcon size={ICON_SIZE.MD} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-(--color-text-primary)">{host.label}</p>
              <p className="mt-0.5 font-mono text-xs text-(--color-text-secondary)">
                {host.user}@{host.address}{host.port === 22 ? "" : `:${host.port}`}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <CopyButton
                text={host.publicLine}
                label="Copy public key"
                copiedLabel="Copied"
                size="md"
                variant="secondary"
              />
              <Button
                variant="ghost"
                size="md"
                disabled={busy}
                onClick={() => void remove(host)}
                aria-label={`Remove ${host.label}`}
                data-testid="ssh-host-remove"
                {...bindSetting("integrations.sshHosts")}
              >
                <TrashIcon size={ICON_SIZE.SM} />
              </Button>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="flex items-center gap-1.5 text-(--color-text-tertiary)">
              <KeyIcon size={ICON_SIZE.SM} />
              <span className="font-mono break-all">{host.fingerprint}</span>
            </span>
            {host.hostKeyFingerprint ? (
              <span className="flex items-center gap-1.5 text-(--color-text-tertiary)">
                <span>Server key</span>
                <span className="font-mono break-all text-(--color-text-secondary)">
                  {host.hostKeyType} {host.hostKeyFingerprint}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void forgetHostKey(host)}
                  data-testid="ssh-host-forget-key"
                >
                  Forget
                </Button>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-(--color-text-tertiary)">
                <WarningIcon size={ICON_SIZE.SM} />
                Server key not recorded yet — the first connection records it.
              </span>
            )}
          </div>
        </div>
      ))}

      {adding ? (
        <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3">
          <div className="grid grid-cols-2 gap-2">
            <input
              className={FIELD_CLASS}
              placeholder="Name (e.g. prod)"
              aria-label="Name"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <input
              className={FIELD_CLASS}
              placeholder="Hostname or IP"
              aria-label="Address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
            <input
              className={FIELD_CLASS}
              placeholder="User"
              aria-label="User"
              value={form.user}
              onChange={(e) => setForm({ ...form, user: e.target.value })}
            />
            <input
              className={FIELD_CLASS}
              placeholder="Port"
              aria-label="Port"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: e.target.value })}
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="md"
              disabled={!canSubmit || busy}
              onClick={() => void add()}
              data-testid="ssh-host-save"
              {...bindSetting("integrations.sshHosts")}
            >
              Add destination
            </Button>
            <Button variant="ghost" size="md" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            variant="secondary"
            size="md"
            onClick={() => setAdding(true)}
            data-testid="ssh-host-add"
            {...bindSetting("integrations.sshHosts")}
          >
            <PlusIcon size={ICON_SIZE.SM} />
            Add SSH host
          </Button>
        </div>
      )}
    </div>
  );
}
