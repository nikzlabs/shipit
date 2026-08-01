import { useState } from "react";
import type { AgentOption } from "../../agent-types.js";
import type { AgentId, ProviderAccount } from "../../../server/shared/types.js";
import { Button } from "../ui/button.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSettingsStore, providerAccountAuthKey } from "../../stores/settings-store.js";

const providerNames: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** Provider-specific copy for the collapsed pay-as-you-go fallback (req 12). */
const apiKeyCopy: Record<AgentId, { label: string; placeholder: string; prefix: string | null }> = {
  claude: { label: "Anthropic API key", placeholder: "sk-ant-...", prefix: "sk-ant-" },
  codex: { label: "OpenAI API key", placeholder: "sk-...", prefix: "sk-" },
};

/**
 * Settings → Agent → {Claude,Codex} — the **single** subscription connect
 * surface (docs/150 req 16).
 *
 * Before this, connecting the *first* account went through the provider-wide
 * `ClaudeAuthCard` / `CodexAuthCard` ("Sign in" on a singleton card) while
 * connecting a *second* account went through a per-account row — two different
 * flows, different endpoints, different state slots, for the same user intent.
 * Req 16 makes them one: every account, including the first, is a row, and
 * "Add account" is the only way to connect one.
 *
 * The row shell is shared across providers; only the challenge panel differs,
 * because the providers genuinely differ — Anthropic hands back an
 * authorization code the user pastes into ShipIt, OpenAI shows a user code the
 * user types on OpenAI's page. Both variants render in the same slot on the
 * row that started them, keyed by {@link providerAccountAuthKey}, so two
 * concurrent sign-ins can't overwrite each other.
 *
 * Pay-as-you-go API keys stay deliberately out of the account list: they are
 * not subscriptions, they never participate in failover (req 12), and they bill
 * differently. They live in a collapsed disclosure at the bottom with explicit
 * metered-billing copy.
 */
export function ProviderAccountsCard({
  provider,
  agent,
  onSubmitApiKey,
  onClearApiKey,
}: {
  provider: AgentId;
  agent: AgentOption | undefined;
  onSubmitApiKey: (key: string) => Promise<void> | void;
  onClearApiKey?: () => Promise<void> | void;
}) {
  const allAccounts = useSettingsStore((s) => s.providerAccounts);
  const setProviderAccounts = useSettingsStore((s) => s.setProviderAccounts);
  const accountAuths = useSettingsStore((s) => s.providerAccountAuths);
  const accountAuthErrors = useSettingsStore((s) => s.providerAccountAuthErrors);
  const setProviderAccountAuth = useSettingsStore((s) => s.setProviderAccountAuth);
  const diagnostics = useSettingsStore((s) => s.claudeAuthDiagnostics);

  const accounts = allAccounts.filter((account) => account.provider === provider);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draftLabels, setDraftLabels] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [authCodes, setAuthCodes] = useState<Record<string, string>>({});
  const [showApiKeyPanel, setShowApiKeyPanel] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<{ accountId: string; message: string } | null>(null);
  const [replacementChoice, setReplacementChoice] = useState("");

  const name = providerNames[provider];

  /** Accounts a pinned session could be moved to — connected, and not this one. */
  const otherReadyAccounts = (excludeId: string) =>
    accounts.filter((account) => account.id !== excludeId && account.status === "ready");

  const toast = (err: unknown, fallback: string) => {
    useUiStore.getState().setToast({ message: err instanceof Error ? err.message : fallback });
  };

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

  const startLogin = async (accountId: string) => {
    await request(`/api/provider-accounts/${provider}/${accountId}/login`, { method: "POST" });
  };

  /**
   * req 16 — the one connect path. Creating the row and starting its sign-in is
   * a single user action, so "Add account" behaves identically whether this is
   * the first account or the fifth. If the login fails to start, the row still
   * exists and its own Connect button retries; we surface the error rather than
   * rolling the row back, because a half-created account the user can see and
   * delete beats one that vanishes with a toast.
   */
  const addAccount = async () => {
    setAdding(true);
    try {
      const known = new Set(accounts.map((account) => account.id));
      const result = await request<{ accounts: ProviderAccount[] }>("/api/provider-accounts", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      setProviderAccounts(result.accounts);
      const created = result.accounts.find(
        (account) => account.provider === provider && !known.has(account.id),
      );
      if (created) await startLogin(created.id);
    } catch (err) {
      toast(err, "Failed to add account");
    } finally {
      setAdding(false);
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
      setProviderAccounts(result.accounts);
      setDraftLabels((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== account.id),
      ));
    } catch (err) {
      toast(err, "Failed to rename account");
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
      setProviderAccounts(result.accounts);
    } catch (err) {
      toast(err, "Failed to update primary account");
    } finally {
      setSavingId(null);
    }
  };

  /**
   * Disconnect, resolving the pinned-session case inline rather than by toast.
   *
   * The server refuses to strand sessions that are pinned to the account and
   * answers with the list of accounts they could move to instead (req 9). That
   * is a question, so it gets asked here — a row-local picker — instead of
   * being flattened into an error toast the user can only retry verbatim.
   */
  const disconnect = async (account: ProviderAccount, replacementAccountId?: string) => {
    setSavingId(account.id);
    try {
      const query = replacementAccountId
        ? `?replacementAccountId=${encodeURIComponent(replacementAccountId)}`
        : "";
      const result = await request<{ accounts: ProviderAccount[]; switchedSessionIds: string[] }>(
        `/api/provider-accounts/${provider}/${account.id}${query}`,
        { method: "DELETE" },
      );
      setProviderAccounts(result.accounts);
      setPendingDisconnect(null);
      if (result.switchedSessionIds.length > 0) {
        useUiStore.getState().setToast({
          message: `Moved ${result.switchedSessionIds.length} session(s) to the replacement account.`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to disconnect account";
      // Only the "choose a replacement" refusal is answerable in place; a
      // running session (or any other failure) is not something a picker fixes.
      const movable = otherReadyAccounts(account.id);
      if (message.includes("session(s) are pinned") && movable.length > 0) {
        setPendingDisconnect({ accountId: account.id, message });
        setReplacementChoice(movable[0]?.id ?? "");
      } else {
        toast(err, "Failed to disconnect account");
      }
    } finally {
      setSavingId(null);
    }
  };

  const connect = async (account: ProviderAccount) => {
    setSavingId(account.id);
    try {
      await startLogin(account.id);
    } catch (err) {
      toast(err, "Failed to start sign-in");
    } finally {
      setSavingId(null);
    }
  };

  const cancelLogin = async (account: ProviderAccount) => {
    setSavingId(account.id);
    try {
      await request(`/api/provider-accounts/${provider}/${account.id}/login/cancel`, { method: "POST" });
      setProviderAccountAuth(provider, account.id, null);
    } catch (err) {
      toast(err, "Failed to cancel sign-in");
    } finally {
      setSavingId(null);
    }
  };

  const submitAuthCode = async (account: ProviderAccount) => {
    const code = authCodes[account.id]?.trim();
    if (!code) return;
    setSavingId(account.id);
    try {
      await request(`/api/provider-accounts/${provider}/${account.id}/login/code`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
    } catch (err) {
      toast(err, "Failed to submit authorization code");
    } finally {
      setSavingId(null);
    }
  };

  const handleApiKeySubmit = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    const { prefix } = apiKeyCopy[provider];
    if (prefix && !trimmed.startsWith(prefix)) {
      setApiKeyError(`API key must start with ${prefix}`);
      return;
    }
    setApiKeySaving(true);
    setApiKeyError("");
    try {
      await onSubmitApiKey(trimmed);
      setApiKey("");
    } catch {
      setApiKeyError("Failed to set API key.");
    } finally {
      setApiKeySaving(false);
    }
  };

  const handleClearCredentials = async () => {
    if (!onClearApiKey || clearing) return;
    setClearing(true);
    try {
      await onClearApiKey();
    } finally {
      setClearing(false);
    }
  };

  const installed = agent?.installed ?? true;
  const authed = agent?.authConfigured ?? false;

  return (
    <div className="space-y-3" data-testid={`provider-accounts-card-${provider}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                !installed
                  ? "bg-(--color-text-tertiary)"
                  : authed
                    ? "bg-(--color-success)"
                    : "bg-(--color-warning)"
              }`}
              data-testid={`provider-status-dot-${provider}`}
            />
            <h3 className="text-sm font-medium text-(--color-text-primary)">{name} subscriptions</h3>
          </div>
          <p className="mt-0.5 text-xs text-(--color-text-tertiary)">
            {!installed
              ? `${name} CLI is not installed.`
              : "Connect one or more subscriptions. ShipIt fails over between them when one runs out."}
          </p>
        </div>
        <Button
          variant="secondary"
          size="md"
          onClick={() => void addAccount()}
          disabled={adding || !installed}
          className="rounded-md shrink-0"
          data-testid={`provider-account-add-${provider}`}
        >
          {adding ? "Adding..." : "Add account"}
        </Button>
      </div>

      {accounts.length === 0 ? (
        <div
          className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-sm text-(--color-text-secondary)"
          data-testid={`provider-accounts-empty-${provider}`}
        >
          No {name} subscription connected yet. Use <span className="text-(--color-text-primary)">Add account</span> to sign in.
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => {
            const draft = draftLabels[account.id] ?? account.label;
            const busy = savingId === account.id;
            const key = providerAccountAuthKey(provider, account.id);
            const pendingAuth = accountAuths[key] ?? null;
            const authError = accountAuthErrors[key] ?? null;
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
                      aria-label={`${name} account label`}
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

                {/* Shared challenge slot — one shell, two provider variants. */}
                {pendingAuth && (
                  <div
                    className="space-y-2 rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) p-3"
                    data-testid={`provider-account-challenge-${account.id}`}
                  >
                    <a
                      href={pendingAuth.verificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-(--color-text-link) hover:underline"
                    >
                      Open {name} authentication page
                    </a>
                    {pendingAuth.userCode ? (
                      <div>
                        <p className="text-xs text-(--color-text-secondary)">Enter this code on that page:</p>
                        <p
                          className="mt-1 font-mono text-lg tracking-widest text-(--color-text-primary)"
                          data-testid={`provider-account-user-code-${account.id}`}
                        >
                          {pendingAuth.userCode}
                        </p>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          value={authCodes[account.id] ?? ""}
                          onChange={(event) => setAuthCodes((current) => ({ ...current, [account.id]: event.target.value }))}
                          placeholder="Paste authorization code"
                          aria-label={`Authorization code for ${account.label}`}
                          className="min-w-0 flex-1 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
                        />
                        <Button
                          variant="primary"
                          size="md"
                          disabled={busy || !authCodes[account.id]?.trim()}
                          onClick={() => void submitAuthCode(account)}
                        >
                          Submit code
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {authError && (
                  <p className="text-xs text-(--color-error)" data-testid={`provider-account-error-${account.id}`}>
                    {authError}
                  </p>
                )}

                {pendingDisconnect?.accountId === account.id && (
                  <div
                    className="space-y-2 rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) p-3"
                    data-testid={`provider-account-replacement-${account.id}`}
                  >
                    <p className="text-xs text-(--color-text-secondary)">{pendingDisconnect.message}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={replacementChoice}
                        onChange={(event) => setReplacementChoice(event.target.value)}
                        aria-label={`Replacement account for ${account.label}`}
                        className="min-w-0 flex-1 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
                      >
                        {otherReadyAccounts(account.id).map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                        ))}
                      </select>
                      <Button
                        variant="primary"
                        size="md"
                        disabled={busy || !replacementChoice}
                        onClick={() => void disconnect(account, replacementChoice)}
                        data-testid={`provider-account-confirm-replacement-${account.id}`}
                      >
                        Move and disconnect
                      </Button>
                      <Button variant="ghost" size="md" onClick={() => setPendingDisconnect(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {/* Claude's CLI-driven sign-in is the one that strands users, so
                    its diagnostics stay reachable. They're provider-wide today;
                    scoping them per account is a Phase 1 follow-up. */}
                {provider === "claude" && pendingAuth && diagnostics.entries.length > 0 && (
                  <details className="group" data-testid={`provider-account-diagnostics-${account.id}`}>
                    <summary className="cursor-pointer select-none text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors">
                      Claude CLI output ({diagnostics.entries.length})
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-(--color-bg-primary) border border-(--color-border-secondary) p-2 font-mono text-[var(--font-size-code)] text-(--color-text-secondary)">
                      {diagnostics.entries.map((entry) =>
                        `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.source}: ${entry.message}`,
                      ).join("\n")}
                    </pre>
                  </details>
                )}

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

      {/* Escape hatch: stored-but-unverifiable credentials leave the agent
          reading as unauthenticated with no per-account row able to clear them. */}
      {onClearApiKey && accounts.length > 0 && !authed && (
        <div className="px-1" data-testid={`provider-stale-credentials-${provider}`}>
          <p className="text-xs text-(--color-text-tertiary)">Saved credentials couldn&apos;t be verified.</p>
          <button
            onClick={() => void handleClearCredentials()}
            disabled={clearing}
            className="mt-0.5 text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid={`provider-clear-credentials-${provider}`}
          >
            {clearing ? "Clearing..." : "Clear saved credentials"}
          </button>
        </div>
      )}

      {/* Metered-billing fallback — deliberately not an "account". */}
      <div className="px-1">
        <button
          onClick={() => setShowApiKeyPanel((v) => !v)}
          className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors"
          data-testid={`provider-toggle-api-key-${provider}`}
        >
          {showApiKeyPanel ? "Hide API key option" : "Use an API key instead"}
        </button>
        {showApiKeyPanel && (
          <div className="mt-2 space-y-2" data-testid={`provider-api-key-panel-${provider}`}>
            <p className="text-xs text-(--color-text-tertiary)">
              Bills per token against your {provider === "claude" ? "Anthropic" : "OpenAI"} API
              account, not a subscription. ShipIt never fails over onto API billing on its own —
              it is used only while it is the auth you have selected.
            </p>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setApiKeyError(""); }}
              placeholder={apiKeyCopy[provider].placeholder}
              aria-label={apiKeyCopy[provider].label}
              disabled={apiKeySaving}
              className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-gray-500 focus:outline-none focus:border-(--color-border-focus) font-mono"
              data-testid={`provider-api-key-input-${provider}`}
            />
            {apiKeyError && (
              <p className="text-xs text-(--color-error)" data-testid={`provider-api-key-error-${provider}`}>{apiKeyError}</p>
            )}
            <Button
              variant="secondary"
              size="md"
              onClick={() => void handleApiKeySubmit()}
              disabled={!apiKey.trim() || apiKeySaving}
              className="w-full rounded-lg"
              data-testid={`provider-api-key-submit-${provider}`}
            >
              Save API key
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
