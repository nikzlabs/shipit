// useEffect is used solely for its cleanup: a pending cutoff edit must be
// persisted when the control unmounts (closing Settings), which no event
// handler can observe.
// eslint-disable-next-line no-restricted-imports -- unmount flush, see above
import { useEffect, useRef, useState } from "react";
import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { AgentOption } from "../../agent-types.js";
import type { AgentId, ProviderAccount } from "../../../server/shared/types.js";
import { credentialModeKey } from "../../../server/shared/types/domain-types/credential-route.js";
import { nativeServiceForHarness } from "../../../server/shared/catalogue/index.js";
import { Button } from "../ui/button.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { ClaudeAuthDiagnostics } from "../../stores/settings-store.js";
import {
  useSettingsStore,
  providerAccountAuthKey,
  EMPTY_CLAUDE_AUTH_DIAGNOSTICS,
} from "../../stores/settings-store.js";

/**
 * docs/252 phase 2 — the key the routing settings for this provider's accounts
 * are stored under.
 *
 * Always the SUBSCRIPTION mode of the harness's own vendor: order, spreading
 * and the cutoffs are answers to "which of these accounts next?", and req 12
 * keeps that question inside one subscription mode. Mirrors
 * `routingSettingsKeyFor` on the server, which is what writes these entries.
 */
function routingKeyFor(provider: AgentId): string {
  return credentialModeKey(nativeServiceForHarness(provider) ?? provider, "sub");
}

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
 * docs/257 req 5 — an inline result or failure, rendered where it happened.
 *
 * Two kinds, because req 5 moves both halves: a failure to report, and the
 * *result* of a successful disconnect ("moved N sessions"), which used to be a
 * global toast as well.
 */
interface Notice {
  kind: "error" | "info";
  message: string;
}

function NoticeLine({
  notice,
  onDismiss,
  testId,
}: {
  notice: Notice;
  /** Present on card-level notices, which have no row to disappear with. */
  onDismiss?: () => void;
  testId: string;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-xs ${
        notice.kind === "error"
          ? "border-(--color-error) text-(--color-error)"
          : "border-(--color-border-secondary) text-(--color-text-secondary)"
      }`}
      role={notice.kind === "error" ? "alert" : "status"}
      data-testid={testId}
    >
      <span className="min-w-0">{notice.message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
          data-testid={`${testId}-dismiss`}
        >
          <XIcon size={ICON_SIZE.XS} />
        </button>
      )}
    </div>
  );
}

/**
 * The **single** subscription connect surface (docs/150 req 16) — rendered by
 * Settings → Agent → {Claude,Codex} *and* by first-run onboarding.
 *
 * Before this, connecting the *first* account went through the provider-wide
 * `ClaudeAuthCard` / `CodexAuthCard` ("Sign in" on a singleton card) while
 * connecting a *second* account went through a per-account row — two different
 * flows, different endpoints, different state slots, for the same user intent.
 * Req 16 makes them one: every account, including the first, is a row, and
 * "Add account" is the only way to connect one. Both singleton cards and the
 * endpoints behind them have since been deleted (req 19), so this is not just
 * the preferred path — it is the only one.
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
  compact = false,
  showApiKeyFallback = true,
}: {
  provider: AgentId;
  agent: AgentOption | undefined;
  /** Only reached through the API-key disclosure, so optional alongside it. */
  onSubmitApiKey?: (key: string) => Promise<void> | void;
  onClearApiKey?: () => Promise<void> | void;
  /**
   * Density-only variant for the onboarding modal, which stacks two of these
   * in a fixed-height pane. It drops the failover explainer — which describes
   * what happens *between* accounts to a user who has none yet — and nothing
   * else. Same rows, same endpoints, same state: req 16 is about the flow not
   * diverging, and this changes only how much prose sits above it.
   */
  compact?: boolean;
  /**
   * docs/252 phase 2 — render the collapsed API-key disclosure. Default true so
   * every existing caller is unchanged; Settings → Services passes false,
   * because there the key is a first-class `(service, key)` card of its own.
   */
  showApiKeyFallback?: boolean;
}) {
  const allAccounts = useSettingsStore((s) => s.providerAccounts);
  const setProviderAccounts = useSettingsStore((s) => s.setProviderAccounts);
  const accountAuths = useSettingsStore((s) => s.providerAccountAuths);
  const accountAuthErrors = useSettingsStore((s) => s.providerAccountAuthErrors);
  const setProviderAccountAuth = useSettingsStore((s) => s.setProviderAccountAuth);
  const allDiagnostics = useSettingsStore((s) => s.claudeAuthDiagnostics);

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
  /**
   * docs/257 req 5 — where a result or a failure lands.
   *
   * This card used to report add, rename, reorder, disconnect, connect, cancel
   * and code submission through a global `toast()`, and a *successful*
   * disconnect reported "moved N sessions" the same way. Req 5 says both halves
   * belong next to the step that produced them: an error that appears somewhere
   * else on screen and then disappears defeats the point of a setup panel whose
   * whole job is to keep the ask in front of the user.
   *
   * Moved for BOTH hosts rather than branching on one: an onboarding-only error
   * path through the single component req 7 exists to keep single is exactly the
   * drift req 7 forbids — and a toast is a global side effect fired from inside
   * a panel, so it cannot be scoped to its host anyway.
   *
   * Row-scoped where a row exists, card-scoped where it does not: "Add account"
   * fails before there is a row, and a *successful* disconnect deletes the row
   * its result describes.
   */
  const [rowNotices, setRowNotices] = useState<Record<string, Notice>>({});
  const [cardNotice, setCardNotice] = useState<Notice | null>(null);
  /** Card-level notices pushed from outside the card — see the store field. */
  const externalNotice = useSettingsStore((s) => s.providerAccountNotices[provider]);
  const setExternalNotice = useSettingsStore((s) => s.setProviderAccountNotice);

  const name = providerNames[provider];

  /** This row's own Claude sign-in diagnostics (docs/150), empty if it has none. */
  const diagnosticsFor = (accountId: string): ClaudeAuthDiagnostics =>
    allDiagnostics[accountId] ?? EMPTY_CLAUDE_AUTH_DIAGNOSTICS;

  /** Accounts a pinned session could be moved to — connected, and not this one. */
  const otherReadyAccounts = (excludeId: string) =>
    accounts.filter((account) => account.id !== excludeId && account.status === "ready");

  const messageOf = (err: unknown, fallback: string): string =>
    err instanceof Error && err.message ? err.message : fallback;

  /** Post a failure on one account's row, replacing whatever was there. */
  const failRow = (accountId: string, err: unknown, fallback: string): void => {
    setRowNotices((current) => ({
      ...current,
      [accountId]: { kind: "error", message: messageOf(err, fallback) },
    }));
  };

  /** Drop a row's notice — called as each action starts, so none goes stale. */
  const clearRow = (accountId: string): void => {
    setRowNotices((current) => {
      if (!(accountId in current)) return current;
      const { [accountId]: _cleared, ...rest } = current;
      return rest;
    });
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
    setCardNotice(null);
    setExternalNotice(provider, null);
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
      // Card-scoped: this fails before a row exists to hang it on.
      setCardNotice({ kind: "error", message: messageOf(err, "Failed to add account") });
    } finally {
      setAdding(false);
    }
  };

  const saveLabel = async (account: ProviderAccount) => {
    const label = (draftLabels[account.id] ?? account.label).trim();
    if (!label || label === account.label) return;
    setSavingId(account.id);
    clearRow(account.id);
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
      failRow(account.id, err, "Failed to rename account");
    } finally {
      setSavingId(null);
    }
  };

  const makePrimary = async (account: ProviderAccount) => {
    if (account.isPrimary) return;
    setSavingId(account.id);
    clearRow(account.id);
    try {
      const result = await request<{ accounts: ProviderAccount[] }>(`/api/provider-accounts/${provider}/${account.id}/primary`, {
        method: "POST",
      });
      setProviderAccounts(result.accounts);
    } catch (err) {
      failRow(account.id, err, "Failed to update primary account");
    } finally {
      setSavingId(null);
    }
  };

  /**
   * docs/150 req 2 — move an account one place in the fallback order.
   *
   * Sends the whole order rather than "move this one": the server rejects a
   * partial list, so a card rendered before another tab added an account fails
   * visibly instead of quietly demoting it to the end.
   */
  const moveAccount = async (account: ProviderAccount, direction: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    const from = ids.indexOf(account.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    setSavingId(account.id);
    clearRow(account.id);
    try {
      const result = await request<{ accounts: ProviderAccount[] }>(`/api/provider-accounts/${provider}/order`, {
        method: "PUT",
        body: JSON.stringify({ accountIds: next }),
      });
      setProviderAccounts(result.accounts);
    } catch (err) {
      failRow(account.id, err, "Failed to reorder accounts");
    } finally {
      setSavingId(null);
    }
  };

  /**
   * Disconnect, resolving the pinned-session case inline rather than by toast.
   *
   * When the account's pinned sessions have somewhere to go, the server answers
   * with the accounts they could move to (req 9). That is a question, so it gets
   * asked here — a row-local picker — instead of being flattened into an error
   * toast the user can only retry verbatim.
   *
   * When they have nowhere to go, there is no question: the server disconnects
   * (req 23) and reports which sessions it left without an account, and this
   * says so afterwards. It is deliberately not a confirmation prompt — the
   * button that deletes an *unpinned* account's credentials doesn't ask either,
   * and the last account was precisely the case that used to have no way
   * through.
   */
  const disconnect = async (account: ProviderAccount, replacementAccountId?: string) => {
    setSavingId(account.id);
    clearRow(account.id);
    setCardNotice(null);
    try {
      const query = replacementAccountId
        ? `?replacementAccountId=${encodeURIComponent(replacementAccountId)}`
        : "";
      const result = await request<{
        accounts: ProviderAccount[];
        switchedSessionIds: string[];
        strandedSessionIds?: string[];
      }>(
        `/api/provider-accounts/${provider}/${account.id}${query}`,
        { method: "DELETE" },
      );
      setProviderAccounts(result.accounts);
      setPendingDisconnect(null);
      // Card-scoped, and not by preference: a successful disconnect deletes the
      // row this result is about, so there is no row left to render it on.
      const stranded = result.strandedSessionIds?.length ?? 0;
      if (result.switchedSessionIds.length > 0) {
        setCardNotice({
          kind: "info",
          message: `Moved ${result.switchedSessionIds.length} session(s) to the replacement account.`,
        });
      } else if (stranded > 0) {
        setCardNotice({
          kind: "info",
          message: `Disconnected. ${stranded} session(s) have no connected ${name} account — connect one before their next turn.`,
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
        failRow(account.id, err, "Failed to disconnect account");
      }
    } finally {
      setSavingId(null);
    }
  };

  const connect = async (account: ProviderAccount) => {
    setSavingId(account.id);
    clearRow(account.id);
    setExternalNotice(provider, null);
    try {
      await startLogin(account.id);
    } catch (err) {
      failRow(account.id, err, "Failed to start sign-in");
    } finally {
      setSavingId(null);
    }
  };

  const cancelLogin = async (account: ProviderAccount) => {
    setSavingId(account.id);
    clearRow(account.id);
    try {
      await request(`/api/provider-accounts/${provider}/${account.id}/login/cancel`, { method: "POST" });
      setProviderAccountAuth(provider, account.id, null);
    } catch (err) {
      failRow(account.id, err, "Failed to cancel sign-in");
    } finally {
      setSavingId(null);
    }
  };

  const submitAuthCode = async (account: ProviderAccount) => {
    const code = authCodes[account.id]?.trim();
    if (!code) return;
    setSavingId(account.id);
    clearRow(account.id);
    try {
      await request(`/api/provider-accounts/${provider}/${account.id}/login/code`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
    } catch (err) {
      failRow(account.id, err, "Failed to submit authorization code");
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
      await onSubmitApiKey?.(trimmed);
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

  /**
   * docs/150 — the provider runs ONE login process, so only one row can be
   * signing in at a time. The server enforces it (409); this just stops the
   * user walking into that refusal, and says why on hover instead of after
   * the click.
   */
  const signingIn = accounts.find((account) => account.status === "authenticating");
  const blockedBy = (accountId: string): string | undefined =>
    signingIn && signingIn.id !== accountId
      ? `Finish or cancel the sign-in on "${signingIn.label}" first.`
      : undefined;

  return (
    <div className="space-y-3" data-testid={`provider-accounts-card-${provider}`}>
      <div
        className={`flex justify-between gap-3 ${compact ? "items-center" : "items-start"}`}
        data-testid={`provider-accounts-header-${provider}`}
      >
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
          {(!installed || !compact) && (
            <p className="mt-0.5 text-xs text-(--color-text-tertiary)">
              {!installed
                ? `${name} CLI is not installed.`
                : "Connect one or more subscriptions. ShipIt fails over between them when one runs out."}
            </p>
          )}
        </div>
        <Button
          variant="secondary"
          size="md"
          onClick={() => void addAccount()}
          disabled={adding || !installed || !!signingIn}
          {...(signingIn ? { title: `Finish or cancel the sign-in on "${signingIn.label}" first.` } : {})}
          className="rounded-md shrink-0"
          data-testid={`provider-account-add-${provider}`}
        >
          {adding ? "Adding..." : "Add account"}
        </Button>
      </div>

      {externalNotice && (
        <NoticeLine
          notice={{ kind: "error", message: externalNotice }}
          onDismiss={() => setExternalNotice(provider, null)}
          testId={`provider-accounts-external-notice-${provider}`}
        />
      )}
      {cardNotice && (
        <NoticeLine
          notice={cardNotice}
          onDismiss={() => setCardNotice(null)}
          testId={`provider-accounts-notice-${provider}`}
        />
      )}

      {accounts.length === 0 ? (
        <div
          className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-sm text-(--color-text-secondary)"
          data-testid={`provider-accounts-empty-${provider}`}
        >
          No {name} subscription connected yet. Use <span className="text-(--color-text-primary)">Add account</span> to sign in.
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((account, accountIndex) => {
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
                    {/* req 2 — the fallback order, only meaningful with more
                        than one account to fall back between. */}
                    {accounts.length > 1 && (
                      <span className="flex items-center gap-0.5" data-testid={`provider-account-order-${account.id}`}>
                        <button
                          onClick={() => void moveAccount(account, -1)}
                          disabled={busy || accountIndex === 0}
                          aria-label={`Move ${account.label} earlier in the fallback order`}
                          className="rounded px-1 py-0.5 text-[11px] text-(--color-text-secondary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:hover:bg-transparent"
                          data-testid={`provider-account-move-up-${account.id}`}
                        >
                          <CaretUpIcon size={ICON_SIZE.XS} />
                        </button>
                        <button
                          onClick={() => void moveAccount(account, 1)}
                          disabled={busy || accountIndex === accounts.length - 1}
                          aria-label={`Move ${account.label} later in the fallback order`}
                          className="rounded px-1 py-0.5 text-[11px] text-(--color-text-secondary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:hover:bg-transparent"
                          data-testid={`provider-account-move-down-${account.id}`}
                        >
                          <CaretDownIcon size={ICON_SIZE.XS} />
                        </button>
                      </span>
                    )}
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

                {rowNotices[account.id] && (
                  <NoticeLine
                    notice={rowNotices[account.id]}
                    testId={`provider-account-notice-${account.id}`}
                  />
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
                    its diagnostics stay reachable. docs/150 — read this row's
                    own buffer: the output belongs to the account whose attempt
                    produced it, not to the provider. */}
                {provider === "claude" && pendingAuth && diagnosticsFor(account.id).entries.length > 0 && (
                  <details className="group" data-testid={`provider-account-diagnostics-${account.id}`}>
                    <summary className="cursor-pointer select-none text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors">
                      Claude CLI output ({diagnosticsFor(account.id).entries.length})
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-(--color-bg-primary) border border-(--color-border-secondary) p-2 font-mono text-[var(--font-size-code)] text-(--color-text-secondary)">
                      {diagnosticsFor(account.id).entries.map((entry) =>
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
                      disabled={busy || !!blockedBy(account.id)}
                      {...(blockedBy(account.id) ? { title: blockedBy(account.id) } : {})}
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

      {/* docs/150 reqs 4-6 — proactive failover cutoffs. Only rendered with two
          or more accounts: with one there is nowhere to fail over to, so the
          control would set a number that can never do anything (req 15 —
          connecting a second account is what turns failover on). */}
      {accounts.length > 1 && (
        <>
          <SelectionModeControl provider={provider} name={name} />
          <FailoverCutoffControls provider={provider} name={name} />
        </>
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

      {/* Metered-billing fallback — deliberately not an "account".
          docs/252 phase 2 — Settings → Services renders this same credential as
          its own `(service, key)` card, so this disclosure is suppressed there
          rather than offering a second editor for one fact. It stays wherever
          the accounts card is the ONLY credential surface: the per-agent tabs,
          and first-run onboarding, where a user with no subscription needs a
          way in (req 2). */}
      {showApiKeyFallback && (
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
      )}
    </div>
  );
}

/**
 * docs/150 req 21 — how this provider's accounts relate to each other.
 *
 * Worded around the accounts, not the algorithm: the real question a user can
 * answer is "are these two the same kind of account or not?", and the ordering
 * behavior follows from that. Naming the mechanism instead ("least recently
 * used") would ask them to reason about scheduling to pick correctly.
 *
 * Rendered above the cutoffs because it changes what the cutoffs *mean*: under
 * balancing, work moves between accounts continuously and a cutoff is the point
 * an account drops out of the rotation, rather than the point work leaves it.
 */
function SelectionModeControl({ provider, name }: { provider: AgentId; name: string }) {
  const stored = useSettingsStore((s) => s.accountSelectionMode[routingKeyFor(provider)]);
  const mode = stored ?? "strict";
  const [saving, setSaving] = useState(false);

  const save = async (next: "strict" | "balanced"): Promise<void> => {
    if (next === mode) return;
    const previous = mode;
    useSettingsStore.getState().setAccountSelectionMode(routingKeyFor(provider), next);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountSelectionMode: { [routingKeyFor(provider)]: next } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      useSettingsStore.getState().setAccountSelectionMode(routingKeyFor(provider), previous);
      useUiStore.getState().setToast({ message: `Failed to update ${name} account order` });
      console.error("[settings] account selection mode save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const option = (value: "strict" | "balanced", label: string, hint: string) => (
    <label className="flex items-start gap-2 text-xs cursor-pointer">
      <input
        type="radio"
        name={`selection-mode-${provider}`}
        checked={mode === value}
        disabled={saving}
        onChange={() => void save(value)}
        aria-label={`${name} account selection: ${label}`}
        className="mt-0.5 accent-(--color-accent)"
        data-testid={`selection-mode-${provider}-${value}`}
      />
      <span>
        <span className="text-(--color-text-secondary)">{label}</span>
        <span className="block text-(--color-text-tertiary)">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="px-1 space-y-2" data-testid={`selection-mode-${provider}`}>
      {option(
        "strict",
        "Use in order",
        "New sessions start on the first account that has quota. Best when the accounts differ — a bigger plan first, a smaller one as backup.",
      )}
      {option(
        "balanced",
        "Spread across accounts",
        "New sessions go to whichever account has been used least, so quota drains evenly. Best when the accounts are equivalent.",
      )}
    </div>
  );
}

const CUTOFF_KEYS = ["session", "weekly"] as const;
type CutoffKey = (typeof CUTOFF_KEYS)[number];

/** What a provider with no stored cutoffs behaves as, server-side. */
const DEFAULT_CUTOFFS: Record<CutoffKey, number> = { session: 90, weekly: 90 };

const currentCutoffs = (provider: AgentId): Record<CutoffKey, number> =>
  useSettingsStore.getState().failoverCutoffs[routingKeyFor(provider)] ?? DEFAULT_CUTOFFS;

/**
 * Persist one cutoff. Deliberately a module-level function over the store,
 * not a closure over component state: it is called from an unmount cleanup,
 * where the component's state and its setters are already gone.
 */
async function saveCutoff(
  provider: AgentId,
  name: string,
  key: CutoffKey,
  raw: string,
): Promise<void> {
  const value = Number.parseInt(raw, 10);
  // The server validates 1-100 and 400s otherwise; don't send a value the
  // user is still mid-typing (an empty field parses to NaN).
  if (!Number.isInteger(value) || value < 1 || value > 100) return;
  const before = currentCutoffs(provider);
  if (value === before[key]) return;
  useSettingsStore.getState().setFailoverCutoffs(routingKeyFor(provider), { ...before, [key]: value });
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ failoverCutoffs: { [routingKeyFor(provider)]: { [key]: value } } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Roll back only our own optimistic write, and only if it is still the
    // value on screen — a slow failure must not clobber a newer edit or the
    // other field, both of which can land while this request is in flight.
    const now = currentCutoffs(provider);
    if (now[key] === value) {
      useSettingsStore.getState().setFailoverCutoffs(routingKeyFor(provider), { ...now, [key]: before[key] });
    }
    useUiStore.getState().setToast({ message: `Failed to update ${name} failover cutoff` });
    console.error("[settings] failover cutoff save failed:", err);
  }
}

/**
 * docs/150 reqs 4-6 — the two proactive cutoffs for one provider.
 *
 * Deliberately worded as "start using the next account at N%", not "limit":
 * crossing a cutoff moves *new* work, it does not stop the account working. An
 * account past its cutoff is still used when no account is under one, which is
 * what keeps a low setting from stranding quota.
 *
 * The inputs are controlled by a per-field draft, and a draft commits on Enter,
 * on blur, and — the case that used to lose edits silently — on unmount. These
 * were `defaultValue` + `onBlur` alone, so closing the Settings dialog straight
 * after typing (Escape, the close button, a click outside) unmounted the input
 * without ever firing blur and discarded the edit with no feedback at all.
 *
 * There is deliberately no debounced save-while-typing: it would PUT the "8" on
 * the way to "85", and unmount-commit already covers everything a debounce
 * would have. Nothing pending is left to a timer.
 *
 * A committed draft is cleared, so the field falls back to the store value —
 * which is what makes a failed save's rollback visible rather than sitting
 * behind a stale uncontrolled DOM value.
 */
function FailoverCutoffControls({ provider, name }: { provider: AgentId; name: string }) {
  const stored = useSettingsStore((s) => s.failoverCutoffs[routingKeyFor(provider)]);
  const cutoffs = stored ?? DEFAULT_CUTOFFS;
  const [drafts, setDrafts] = useState<Partial<Record<CutoffKey, string>>>({});

  // The unmount cleanup and the commit path both need the drafts as of *now*,
  // not as of the render they closed over.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // Mount-only, cleanup-only: flushing a pending edit when the control goes
  // away is the whole point, and `provider`/`name` identify which control that
  // is for its entire lifetime.
  // eslint-disable-next-line no-restricted-syntax -- cleanup on unmount; see above
  useEffect(() => () => {
    for (const key of CUTOFF_KEYS) {
      const raw = draftsRef.current[key];
      if (raw !== undefined) void saveCutoff(provider, name, key, raw);
    }
  }, [provider, name]);

  const commit = (key: CutoffKey) => {
    const raw = draftsRef.current[key];
    if (raw === undefined) return;
    // Drop the draft before saving so a second commit for the same edit (blur
    // right after Enter) is a no-op instead of a duplicate PUT. An invalid or
    // unchanged value is dropped too: nothing was saved, so the field snapping
    // back to the stored number is the honest thing to show.
    const { [key]: _committed, ...rest } = draftsRef.current;
    draftsRef.current = rest;
    setDrafts(rest);
    void saveCutoff(provider, name, key, raw);
  };

  const field = (key: CutoffKey, label: string) => (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-(--color-text-secondary)">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min={1}
          max={100}
          value={drafts[key] ?? String(cutoffs[key])}
          onChange={(e) => {
            const next = e.target.value;
            setDrafts((current) => ({ ...current, [key]: next }));
          }}
          onKeyDown={(e) => { if (e.key === "Enter") commit(key); }}
          onBlur={() => commit(key)}
          aria-label={`${name} ${label} failover cutoff, percent`}
          className="w-16 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-2 py-1 text-right text-xs text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
          data-testid={`failover-cutoff-${provider}-${key}`}
        />
        <span className="text-(--color-text-tertiary)">%</span>
      </span>
    </label>
  );

  return (
    <div className="px-1 space-y-2" data-testid={`failover-cutoffs-${provider}`}>
      <p className="text-xs text-(--color-text-tertiary)">
        Start new work on the next account once an account passes these. Accounts past their
        cutoff are still used when no other account is below one, so nothing is stranded.
      </p>
      {field("session", "Short window")}
      {field("weekly", "Weekly")}
    </div>
  );
}
