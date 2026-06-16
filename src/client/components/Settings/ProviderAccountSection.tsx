import { useState } from "react";
import type { AgentId, ProviderAccount } from "../../../server/shared/types.js";
import { Button } from "../ui/button.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";

const providerNames: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

export function ProviderAccountSection({ provider }: { provider: AgentId }) {
  const allAccounts = useSettingsStore((s) => s.providerAccounts);
  const setProviderAccounts = useSettingsStore((s) => s.setProviderAccounts);
  const accounts = allAccounts.filter((account) => account.provider === provider);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draftLabels, setDraftLabels] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  const applyAccounts = (next: ProviderAccount[]) => setProviderAccounts(next);

  const request = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    // Only advertise a JSON content-type when we're actually sending a JSON
    // body. Otherwise Fastify's JSON parser sees Content-Type: application/json
    // with a zero-length body and rejects with FST_ERR_CTP_EMPTY_JSON_BODY
    // (HTTP 400 "Bad Request") before the route handler ever runs — which
    // showed up here as the Disconnect button surfacing a "Bad Request" toast.
    const hasBody = init?.body !== undefined && init?.body !== null;
    const res = await fetch(url, {
      ...init,
      headers: hasBody ? { "Content-Type": "application/json" } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  };

  const createAccount = async () => {
    setCreating(true);
    try {
      const result = await request<{ accounts: ProviderAccount[] }>("/api/provider-accounts", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      applyAccounts(result.accounts);
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to add account" });
    } finally {
      setCreating(false);
    }
  };

  const saveLabel = async (account: ProviderAccount) => {
    const label = (draftLabels[account.id] ?? account.label).trim();
    if (!label || label === account.label) return;
    setSavingId(account.id);
    try {
      const result = await request<{ accounts: ProviderAccount[] }>(`/api/provider-accounts/${provider}/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label }),
      });
      applyAccounts(result.accounts);
      setDraftLabels((current) => {
        const next = { ...current };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by provider account id.
        delete next[account.id];
        return next;
      });
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to rename account" });
    } finally {
      setSavingId(null);
    }
  };

  const makePrimary = async (account: ProviderAccount) => {
    if (account.isPrimary) return;
    setSavingId(account.id);
    try {
      const result = await request<{ accounts: ProviderAccount[] }>(`/api/provider-accounts/${provider}/${account.id}/primary`, {
        method: "POST",
      });
      applyAccounts(result.accounts);
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to update primary account" });
    } finally {
      setSavingId(null);
    }
  };

  const disconnect = async (account: ProviderAccount) => {
    setSavingId(account.id);
    try {
      const result = await request<{ accounts: ProviderAccount[] }>(`/api/provider-accounts/${provider}/${account.id}`, {
        method: "DELETE",
      });
      applyAccounts(result.accounts);
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to disconnect account" });
    } finally {
      setSavingId(null);
    }
  };

  // docs/150 — kick off the account-scoped login. The pending sign-in URL/code
  // surfaces through the existing per-agent sign-in card (it rides the same
  // `agent_auth_*` SSE family); the row's status pill updates from the
  // `provider_accounts` broadcast, so we just fire the request here.
  const connect = async (account: ProviderAccount) => {
    setSavingId(account.id);
    try {
      await request(`/api/provider-accounts/${provider}/${account.id}/login`, { method: "POST" });
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to start sign-in" });
    } finally {
      setSavingId(null);
    }
  };

  const cancelLogin = async (account: ProviderAccount) => {
    setSavingId(account.id);
    try {
      await request(`/api/provider-accounts/${provider}/${account.id}/login/cancel`, { method: "POST" });
    } catch (err) {
      useUiStore.getState().setToast({ message: err instanceof Error ? err.message : "Failed to cancel sign-in" });
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-(--color-text-primary)">Agent accounts</h3>
          <p className="text-xs text-(--color-text-tertiary)">Stored subscription identities for {providerNames[provider]}.</p>
        </div>
        <Button
          variant="secondary"
          size="md"
          onClick={() => void createAccount()}
          disabled={creating}
          className="rounded-md"
          data-testid={`provider-account-add-${provider}`}
        >
          {creating ? "Adding..." : "Add"}
        </Button>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-sm text-(--color-text-secondary)">
          No stored {providerNames[provider]} accounts. Reserved env/API-key auth may still be available.
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => {
            const draft = draftLabels[account.id] ?? account.label;
            const busy = savingId === account.id;
            return (
              <div
                key={account.id}
                className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 space-y-3"
                data-testid={`provider-account-row-${account.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <input
                      value={draft}
                      onChange={(e) => setDraftLabels((current) => ({ ...current, [account.id]: e.target.value }))}
                      onBlur={() => void saveLabel(account)}
                      className="w-full rounded-md bg-(--color-bg-primary) border border-(--color-border-secondary) px-2 py-1 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
                      aria-label={`${providerNames[provider]} account label`}
                    />
                    <p className="mt-1 text-[11px] text-(--color-text-tertiary) truncate">{account.id}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {account.isPrimary && (
                      <span className="rounded px-1.5 py-0.5 text-[11px] bg-(--color-accent-subtle) text-(--color-accent)">Primary</span>
                    )}
                    <span className="rounded px-1.5 py-0.5 text-[11px] bg-(--color-bg-hover) text-(--color-text-secondary)">
                      {account.status.replace("_", " ")}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {account.status === "authenticating" ? (
                    <Button
                      variant="ghost"
                      size="md"
                      onClick={() => void cancelLogin(account)}
                      disabled={busy}
                      className="rounded-md"
                      data-testid={`provider-account-cancel-login-${account.id}`}
                    >
                      Cancel sign-in
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="md"
                      onClick={() => void connect(account)}
                      disabled={busy}
                      className="rounded-md"
                      data-testid={`provider-account-connect-${account.id}`}
                    >
                      {account.status === "ready" ? "Reconnect" : "Connect"}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => void makePrimary(account)}
                    disabled={busy || account.isPrimary}
                    className="rounded-md"
                  >
                    Make primary
                  </Button>
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => void disconnect(account)}
                    disabled={busy}
                    className="rounded-md text-(--color-error) hover:text-(--color-error)"
                  >
                    {busy ? "Working..." : "Disconnect"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
