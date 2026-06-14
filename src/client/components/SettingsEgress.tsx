import { useEffect, useState } from "react";
import { TrashIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useEgressStore } from "../stores/egress-store.js";
import { useUiStore } from "../stores/ui-store.js";

/** Toggle switch matching the Settings dialog style. */
function ToggleSwitch({ enabled, onToggle, testId }: { enabled: boolean; onToggle: (v: boolean) => void; testId?: string }) {
  return (
    <button
      onClick={() => onToggle(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
      }`}
      role="switch"
      aria-checked={enabled}
      data-testid={testId}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/**
 * Settings → Advanced → "Network egress" section (docs/172 / SHI-90).
 *
 * Renders the default-on containment toggle (Contained vs Open) and the
 * allowlist editor. Egress is a container-start choice, so the copy states that
 * changes apply on the next container restart rather than implying an instant
 * effect. All mutations go through the browser-only `/api/egress/*` routes via
 * `useEgressStore`; failures roll back and surface a toast.
 */
export function SettingsEgress() {
  const loaded = useEgressStore((s) => s.loaded);
  const globalEnabled = useEgressStore((s) => s.globalEnabled);
  const globalHosts = useEgressStore((s) => s.globalHosts);
  const [hostInput, setHostInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useEgressStore.getState().load().catch((err: unknown) => {
      console.error("[settings] failed to load egress settings:", err);
    });
  }, []);

  const handleToggle = async (v: boolean) => {
    try {
      await useEgressStore.getState().setGlobalEnabled(v);
    } catch (err) {
      useUiStore.getState().setToast({ message: "Failed to update egress containment setting" });
      console.error("[settings] egress toggle failed:", err);
    }
  };

  const handleAdd = async () => {
    const host = hostInput.trim();
    if (!host || busy) return;
    setBusy(true);
    try {
      await useEgressStore.getState().addHost(host);
      setHostInput("");
    } catch (err) {
      useUiStore.getState().setToast({ message: `Failed to add ${host} to the allowlist` });
      console.error("[settings] egress add host failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (host: string) => {
    try {
      await useEgressStore.getState().removeHost(host);
    } catch (err) {
      useUiStore.getState().setToast({ message: `Failed to remove ${host} from the allowlist` });
      console.error("[settings] egress remove host failed:", err);
    }
  };

  return (
    <div className="space-y-3" data-testid="settings-egress">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon size={ICON_SIZE.SM} className="text-(--color-text-secondary)" />
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
        <ToggleSwitch
          enabled={globalEnabled}
          onToggle={(v) => void handleToggle(v)}
          testId="settings-egress-contained"
        />
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium text-(--color-text-secondary)">Allowlist</span>
        <p className="text-xs text-(--color-text-tertiary)">
          Extra hosts the agent may reach, in addition to the built-ins. Prefix with a dot
          (e.g. <code className="text-(--color-text-secondary)">.example.com</code>) to also match subdomains.
          New hosts apply on the next container start.
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
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAdd();
              }
            }}
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

        {loaded && globalHosts.length === 0 && (
          <p className="text-xs text-(--color-text-tertiary)" data-testid="settings-egress-empty">
            No custom hosts yet — the built-in allowlist still applies.
          </p>
        )}
        {globalHosts.length > 0 && (
          <ul className="flex flex-col gap-1" data-testid="settings-egress-host-list">
            {globalHosts.map((host) => (
              <li
                key={host}
                className="flex items-center justify-between rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-1.5"
              >
                <span className="text-sm text-(--color-text-primary) font-mono">{host}</span>
                <button
                  onClick={() => void handleRemove(host)}
                  className="text-(--color-text-tertiary) hover:text-(--color-error) transition-colors"
                  aria-label={`Remove ${host}`}
                  data-testid={`settings-egress-host-remove-${host}`}
                >
                  <TrashIcon size={ICON_SIZE.SM} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
