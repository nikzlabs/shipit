/**
 * The session's SSH destination grants (docs/305-ssh-hosts, req 6).
 *
 * Rendered for EVERY session kind — repo-backed, sandbox and ops — which is why
 * its edit route is its own and not behind the sandbox guard the capability
 * editor next to it uses.
 *
 * Attaching applies live: the server writes the grant, rewrites `~/.ssh`, and
 * reconciles the session's egress, so there is no pending-restart state here.
 * Revoking stops NEW authentications; a connection already authenticated runs
 * until it closes.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: read this session's grants when the dialog opens (external system sync)
import { useEffect, useState } from "react";
import { CheckSquareIcon, SquareIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useUiStore } from "../stores/ui-store.js";
import type { SessionSshHostsView } from "../../server/shared/types.js";

/**
 * The dialog shares one fetch surface with two other sections, so a response
 * that is not this shape must leave the section unrendered rather than throw and
 * take the whole dialog down with it.
 */
function asView(body: unknown): SessionSshHostsView | null {
  const view = body as Partial<SessionSshHostsView> | null;
  if (!view || !Array.isArray(view.hosts) || !Array.isArray(view.granted)) return null;
  return view as SessionSshHostsView;
}

export function SessionSshHostGrants({ sessionId, open }: { sessionId: string; open: boolean }) {
  const [view, setView] = useState<SessionSshHostsView | null>(null);
  const [saving, setSaving] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: read grants when the dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ssh-hosts`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = asView(await res.json());
        if (!cancelled && body) setView(body);
      } catch (err) {
        console.error("[ssh-hosts] failed to read this session's grants:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, open]);

  // A session with no destination in the registry has nothing to grant, and this
  // section shares a dialog with two others — it renders nothing rather than an
  // empty heading.
  if (!view || view.hosts.length === 0) return null;

  const toggle = async (hostId: string) => {
    const granted = view.granted.includes(hostId)
      ? view.granted.filter((id) => id !== hostId)
      : [...view.granted, hostId];
    const previous = view;
    setView({ ...view, granted });
    setSaving(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ssh-hosts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granted }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView(asView(await res.json()) ?? previous);
    } catch (err) {
      setView(previous);
      useUiStore.getState().setToast({ message: "Failed to update this session's SSH destinations" });
      console.error("[ssh-hosts] failed to write grants:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="session-ssh-hosts">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
        SSH destinations
      </p>
      <div className="flex flex-col gap-1">
        {view.hosts.map((host) => {
          const granted = view.granted.includes(host.id);
          return (
            <button
              key={host.id}
              type="button"
              role="checkbox"
              aria-checked={granted}
              aria-label={host.label}
              disabled={saving}
              onClick={() => void toggle(host.id)}
              data-testid="session-ssh-host-toggle"
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                granted
                  ? "border-(--color-accent) bg-(--color-accent-subtle)"
                  : "border-(--color-border-secondary) bg-(--color-bg-secondary) hover:bg-(--color-bg-hover)"
              }`}
            >
              <span className={`shrink-0 ${granted ? "text-(--color-accent)" : "text-(--color-text-tertiary)"}`}>
                {granted
                  ? <CheckSquareIcon size={ICON_SIZE.SM} weight="fill" />
                  : <SquareIcon size={ICON_SIZE.SM} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-(--color-text-primary)">{host.label}</span>
                <span className="block font-mono text-xs text-(--color-text-secondary)">
                  {host.user}@{host.address}{host.port === 22 ? "" : `:${host.port}`}
                </span>
              </span>
              {granted && (
                <span className="shrink-0 text-(--color-text-tertiary)">
                  <TerminalWindowIcon size={ICON_SIZE.SM} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
