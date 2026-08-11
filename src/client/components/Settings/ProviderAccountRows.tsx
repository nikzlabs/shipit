import { useState } from "react";
import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { AgentOption } from "../../agent-types.js";
import type { AgentId, CredentialRoute } from "../../../server/shared/types.js";
import { getService, nativeServiceForHarness } from "../../../server/shared/catalogue/index.js";
import { Button } from "../ui/button.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { ProviderAccountNotice } from "../../stores/settings-store.js";
import {
  useSettingsStore,
  providerAccountAuthKey,
  EMPTY_CLAUDE_AUTH_DIAGNOSTICS,
} from "../../stores/settings-store.js";

/**
 * docs/150 req 16 / docs/252 — the account rows of an account-backed
 * subscription, and the sign-in they share with the add-service dialog.
 *
 * **Nothing here adds an account any more** (docs/252 req 17). The card's "Add
 * account" button is gone; what is left in its place is
 * {@link createAccount}, {@link startAccountLogin} and {@link AccountChallenge},
 * called and rendered by `AddServiceDialog`, which is the one way in. The challenge is a
 * shared component rather than a copy per host for the reason docs/150 req 16
 * exists: a user's first account was once connected by different code than
 * their second.
 *
 * This **was** `ProviderAccountsCard`: a card of its own, with its own header,
 * its own status dot, its own routing controls and its own collapsed API-key
 * disclosure. It rendered in three places — the Claude tab, the Codex tab and
 * Settings → Services — and in the last of those it sat *outside* the card
 * list, borderless and titled after the harness vendor, so the one screen that
 * lists credentials showed two different card languages at once.
 *
 * It is now a **body**, not a card. `ServiceCard` owns the chrome for every
 * `(service, billing mode)` alike, `CredentialRouting` owns the routing
 * controls (which were a duplicate of the string-delivered ones keyed on the
 * same setting), and what is left here is the part that is genuinely specific:
 * the rows, the login challenge, and the notices those produce. The per-vendor
 * Settings tabs are gone, so Services is the only host.
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
 * differently. They are their own `(service, key)` card one row down.
 */

/** The service whose subscription accounts this harness's login flow produces. */
export function serviceIdForProvider(provider: AgentId): string {
  return nativeServiceForHarness(provider) ?? provider;
}

/** The catalogue's name for that service — "Anthropic", never "Claude". */
export function serviceNameForProvider(provider: AgentId): string {
  const serviceId = serviceIdForProvider(provider);
  return getService(serviceId)?.name ?? serviceId;
}

const harnessNames: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

function NoticeLine({
  notice,
  onDismiss,
  testId,
}: {
  notice: ProviderAccountNotice;
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
 * This harness's accounts, in fallback order.
 *
 * Exported so the card that hosts these rows counts exactly what they render.
 * Deriving the count from a second, similar filter is how a header saying
 * "2 accounts" ends up over three rows — which is also why `hiddenAccountId`
 * is applied *here* rather than at each call site.
 *
 * **`hiddenAccountId` — an account that exists but is not the panel's yet.**
 * A sign-in needs a row to hang on, so `POST /api/provider-accounts` creates
 * one the instant the user presses *Sign in*, long before anything is
 * connected. Everything that lists accounts would otherwise show it: a card
 * appearing behind the open dialog, with a phantom `authenticating` row, for a
 * service the user is still in the middle of adding — and if they then close
 * the dialog it is deleted again, so the panel gains and loses a card while
 * they watch. While the add-service dialog is hosting that sign-in, it owns it
 * outright; the panel sees the account when the flow ends, which is also when
 * it becomes true that the user has one.
 */
export function useProviderAccounts(provider: AgentId, hiddenAccountId?: string): CredentialRoute[] {
  const allAccounts = useSettingsStore((s) => s.providerAccounts);
  // planning#342 — the store holds `CredentialRoute`s, keyed by service. The
  // login flow is still the CLI's, so this narrows by the harness's own vendor
  // rather than by the harness.
  const serviceId = serviceIdForProvider(provider);
  return allAccounts.filter(
    (account) => account.serviceId === serviceId && account.id !== hiddenAccountId,
  );
}

/**
 * docs/150 — the provider runs ONE login process, so only one row can be
 * signing in at a time. The server enforces it (409); this just stops the user
 * walking into that refusal, and says why on hover instead of after the click.
 */
function signingInAccount(accounts: CredentialRoute[]): CredentialRoute | undefined {
  return accounts.find((account) => account.status === "authenticating");
}

const messageOf = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
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
}

/**
 * Start (or restart) the provider's login for an account that already exists.
 *
 * Exported because the add-service dialog needs it as its own step — see
 * {@link createAccount} for why the two are not one call — and because a failed
 * attempt is retried by calling it again on the same account.
 */
export const startAccountLogin = (provider: AgentId, accountId: string): Promise<unknown> =>
  request(`/api/provider-accounts/${provider}/${accountId}/login`, { method: "POST" });

/**
 * req 17 — create the account row that a sign-in will fill.
 *
 * **Deliberately NOT "create and start the login" in one call**, although that
 * is what the user's single press does. The row is created server-side first
 * and the login started second, so a helper that awaited both before returning
 * would throw on a login-start failure *after* the account existed — leaving
 * the caller without the id of a row it had just caused, and therefore unable
 * to abandon it. That is the orphan req 17 forbids, and it was there until
 * cross-backend review found it. So the caller takes the id first and starts
 * the login itself.
 *
 * The created account is read from the response's own `account` field rather
 * than inferred by diffing the list: two dialogs (two tabs) starting the same
 * provider at once can each see the other's new row in their response, and a
 * diff picks whichever sorts first — so one dialog would go on to cancel and
 * delete the other's attempt. The diff survives only as a fallback for payloads
 * that predate the field.
 *
 * Was `AddAccountButton`, a control on the service card. req 17 removed the
 * card's own way in, so what is left is this function, called from the one
 * flow: `AddServiceDialog`'s last step.
 */
export async function createAccount(
  provider: AgentId,
  knownAccountIds: Iterable<string>,
): Promise<CredentialRoute | undefined> {
  const known = new Set(knownAccountIds);
  const result = await request<{ account?: CredentialRoute; accounts: CredentialRoute[] }>(
    "/api/provider-accounts",
    { method: "POST", body: JSON.stringify({ provider }) },
  );
  useSettingsStore.getState().setProviderAccounts(result.accounts);
  if (result.account) return result.account;
  const serviceId = serviceIdForProvider(provider);
  return result.accounts.find(
    (account) => account.serviceId === serviceId && !known.has(account.id),
  );
}

/**
 * Abandon an account that was created for a sign-in the user then called off.
 *
 * Cancel-then-delete, in that order and both best-effort: the login is a live
 * process on the provider's side, and leaving it running against a row that no
 * longer exists is how a provider ends up refusing the *next* sign-in with a
 * 409 nobody can clear from the UI. A failure on either step is swallowed —
 * the caller is closing a dialog, and the row it could not delete is visible
 * and deletable on the card.
 */
export async function abandonAccount(provider: AgentId, accountId: string): Promise<void> {
  try {
    await request(`/api/provider-accounts/${provider}/${accountId}/login/cancel`, { method: "POST" });
  } catch {
    // Already finished, already cancelled, or never started.
  }
  try {
    const result = await request<{ accounts: CredentialRoute[] }>(
      `/api/provider-accounts/${provider}/${accountId}`,
      { method: "DELETE" },
    );
    useSettingsStore.getState().setProviderAccounts(result.accounts);
  } catch {
    // Left on the card, where Disconnect reaches it.
  }
  useSettingsStore.getState().setProviderAccountAuth(provider, accountId, null);
}

/** Human-readable "somebody else is signing in" refusal, or `undefined`. */
export function signInBlockedReason(accounts: CredentialRoute[], accountId?: string): string | undefined {
  const signingIn = signingInAccount(accounts);
  if (!signingIn || signingIn.id === accountId) return undefined;
  return `Finish or cancel the sign-in on "${signingIn.label}" first.`;
}

/**
 * The provider's login challenge — **one implementation, two hosts.**
 *
 * It renders on the account row and inside the add-service dialog, and it is a
 * component rather than a copy in each because docs/150 req 16 already paid for
 * the alternative once: a user's first account connected by different code than
 * their second. The two providers genuinely differ inside it — Anthropic hands
 * back an authorization code the user pastes into ShipIt, OpenAI shows a user
 * code the user types on OpenAI's page — and that difference is the only branch.
 *
 * It owns the code input and the submit, and reports a failure through
 * `onError` so each host can put it where that host puts failures.
 */
export function AccountChallenge({
  provider,
  account,
  serviceName,
  onError,
}: {
  provider: AgentId;
  account: CredentialRoute;
  serviceName: string;
  onError: (message: string) => void;
}) {
  const auths = useSettingsStore((s) => s.providerAccountAuths);
  const allDiagnostics = useSettingsStore((s) => s.claudeAuthDiagnostics);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingAuth = auths[providerAccountAuthKey(provider, account.id)] ?? null;
  if (!pendingAuth) return null;

  const diagnostics = allDiagnostics[account.id] ?? EMPTY_CLAUDE_AUTH_DIAGNOSTICS;

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await request(`/api/provider-accounts/${provider}/${account.id}/login/code`, {
        method: "POST",
        body: JSON.stringify({ code: trimmed }),
      });
    } catch (err) {
      onError(messageOf(err, "Failed to submit authorization code"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
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
          Open {serviceName} authentication page
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
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Paste authorization code"
              aria-label={`Authorization code for ${account.label}`}
              className="min-w-0 flex-1 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 text-sm text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
            />
            <Button
              variant="primary"
              size="md"
              disabled={busy || !code.trim()}
              onClick={() => void submit()}
            >
              Submit code
            </Button>
          </div>
        )}
      </div>

      {/* Claude's CLI-driven sign-in is the one that strands users, so its
          diagnostics stay reachable. docs/150 — read this account's own buffer:
          the output belongs to the attempt that produced it. */}
      {provider === "claude" && diagnostics.entries.length > 0 && (
        <details className="group" data-testid={`provider-account-diagnostics-${account.id}`}>
          <summary className="cursor-pointer select-none text-xs text-(--color-text-link) transition-colors hover:text-(--color-accent)">
            Claude CLI output ({diagnostics.entries.length})
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) p-2 font-mono text-[var(--font-size-code)] text-(--color-text-secondary)">
            {diagnostics.entries.map((entry) =>
              `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.source}: ${entry.message}`,
            ).join("\n")}
          </pre>
        </details>
      )}
    </>
  );
}

export function ProviderAccountRows({
  provider,
  agent,
  hiddenAccountId,
}: {
  provider: AgentId;
  agent: AgentOption | undefined;
  /** See {@link useProviderAccounts} — an in-flight sign-in the dialog owns. */
  hiddenAccountId?: string;
}) {
  const accounts = useProviderAccounts(provider, hiddenAccountId);
  const setProviderAccounts = useSettingsStore((s) => s.setProviderAccounts);
  const accountAuthErrors = useSettingsStore((s) => s.providerAccountAuthErrors);
  const setProviderAccountAuth = useSettingsStore((s) => s.setProviderAccountAuth);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draftLabels, setDraftLabels] = useState<Record<string, string>>({});
  /**
   * docs/257 req 5 — where a result or a failure lands.
   *
   * This card used to report add, rename, reorder, disconnect, connect, cancel
   * and code submission through a global `toast()`. Req 5 says the result
   * belongs next to the step that produced it: an error that appears somewhere
   * else on screen and then disappears defeats the point of a setup panel whose
   * whole job is to keep the ask in front of the user.
   *
   * Row-scoped where a row exists, card-scoped where it does not: a *successful*
   * disconnect deletes the row its result describes, and the store's card notice
   * outlives it.
   */
  const [rowNotices, setRowNotices] = useState<Record<string, ProviderAccountNotice>>({});
  /**
   * Card-level notices live in the store, not here. See the store field: each
   * one outlives either this component or the row it is about.
   */
  const cardNotice = useSettingsStore((s) => s.providerAccountNotices[provider]);
  const setCardNotice = useSettingsStore((s) => s.setProviderAccountNotice);

  const serviceName = serviceNameForProvider(provider);
  const installed = agent?.installed ?? true;

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

  const saveLabel = async (account: CredentialRoute) => {
    const label = (draftLabels[account.id] ?? account.label).trim();
    if (!label || label === account.label) return;
    setSavingId(account.id);
    clearRow(account.id);
    try {
      const result = await request<{ accounts: CredentialRoute[] }>(`/api/provider-accounts/${provider}/${account.id}`, {
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

  const makePrimary = async (account: CredentialRoute) => {
    if (account.isPrimary) return;
    setSavingId(account.id);
    clearRow(account.id);
    try {
      const result = await request<{ accounts: CredentialRoute[] }>(`/api/provider-accounts/${provider}/${account.id}/primary`, {
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
  const moveAccount = async (account: CredentialRoute, direction: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    const from = ids.indexOf(account.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    setSavingId(account.id);
    clearRow(account.id);
    try {
      const result = await request<{ accounts: CredentialRoute[] }>(`/api/provider-accounts/${provider}/order`, {
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
   * docs/260 req 3 — disconnect is one click. There is no pinned-session
   * question to ask (no session is pinned to anything), no replacement to
   * pick, and nothing to report about moved or stranded sessions: each
   * session's next turn routes among whatever accounts remain. The one
   * refusal the server still makes — a live process running a turn or holding
   * background work on this account (req 13) — is a wait, and its message
   * lands on the row.
   */
  const disconnect = async (account: CredentialRoute) => {
    setSavingId(account.id);
    clearRow(account.id);
    setCardNotice(provider, null);
    try {
      const result = await request<{ accounts: CredentialRoute[] }>(
        `/api/provider-accounts/${provider}/${account.id}`,
        { method: "DELETE" },
      );
      setProviderAccounts(result.accounts);
    } catch (err) {
      failRow(account.id, err, "Failed to disconnect account");
    } finally {
      setSavingId(null);
    }
  };

  const connect = async (account: CredentialRoute) => {
    setSavingId(account.id);
    clearRow(account.id);
    setCardNotice(provider, null);
    try {
      await startAccountLogin(provider, account.id);
    } catch (err) {
      failRow(account.id, err, "Failed to start sign-in");
    } finally {
      setSavingId(null);
    }
  };

  const cancelLogin = async (account: CredentialRoute) => {
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

  // Submitting the authorization code belongs to `AccountChallenge`, which is
  // shared with the add-service dialog — the row only hosts it.
  const blockedBy = (accountId: string): string | undefined =>
    signInBlockedReason(accounts, accountId);

  return (
    <div className="space-y-2" data-testid={`provider-account-rows-${provider}`}>
      {!installed && (
        <NoticeLine
          notice={{ kind: "error", message: `${harnessNames[provider]} CLI is not installed, so this subscription cannot be connected.` }}
          testId={`provider-not-installed-${provider}`}
        />
      )}

      {cardNotice && (
        <NoticeLine
          notice={cardNotice}
          onDismiss={() => setCardNotice(provider, null)}
          testId={`provider-accounts-notice-${provider}`}
        />
      )}

      {accounts.length === 0 ? (
        <div
          className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-xs text-(--color-text-secondary)"
          data-testid={`provider-accounts-empty-${provider}`}
        >
          {/* req 17 — this card has no way in of its own, so the sentence names
              the one that exists rather than a button beside it. Reachable only
              when a notice is holding the card open after the last account was
              disconnected: with no account and nothing to say, the card is gone. */}
          No {serviceName} subscription connected. Add one with{" "}
          <span className="text-(--color-text-primary)">Add a service</span>.
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((account, accountIndex) => {
            const draft = draftLabels[account.id] ?? account.label;
            const busy = savingId === account.id;
            const authError = accountAuthErrors[providerAccountAuthKey(provider, account.id)] ?? null;
            return (
              <div
                key={account.id}
                className="space-y-3 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3"
                data-testid={`provider-account-row-${account.id}`}
              >
                {/* The order carets lead the row, exactly as they do on a
                    string-delivered credential one card down: both row types
                    now live inside the same `ServiceCard`, so a fallback order
                    that reads left-to-right in one and right-to-left in the
                    other is the seam this unification exists to close. */}
                <div className="flex items-start gap-2">
                  {/* req 2 — the fallback order, only meaningful with more
                      than one account to fall back between. */}
                  {accounts.length > 1 && (
                    <span className="mt-1 flex items-center gap-0.5" data-testid={`provider-account-order-${account.id}`}>
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
                  <div className="min-w-0 flex-1">
                    <input
                      value={draft}
                      onChange={(e) => setDraftLabels((current) => ({ ...current, [account.id]: e.target.value }))}
                      onBlur={() => void saveLabel(account)}
                      className="w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1 text-sm text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
                      aria-label={`${serviceName} account label`}
                    />
                    <p className="mt-1 truncate text-[11px] text-(--color-text-tertiary)">{account.id}</p>
                  </div>
                  <div className="mt-1 flex shrink-0 flex-wrap justify-end gap-1.5">
                    {account.isPrimary && (
                      <span className="rounded bg-(--color-accent-subtle) px-1.5 py-0.5 text-[11px] text-(--color-accent)">Primary</span>
                    )}
                    <span className="rounded bg-(--color-bg-hover) px-1.5 py-0.5 text-[11px] text-(--color-text-secondary)">
                      {account.status.replace("_", " ")}
                    </span>
                  </div>
                </div>

                {/* The shared challenge — the same component the add-service
                    dialog renders, so the first sign-in and the fifth are one
                    implementation (docs/150 req 16). */}
                <AccountChallenge
                  provider={provider}
                  account={account}
                  serviceName={serviceName}
                  onError={(message) => setRowNotices((current) => ({
                    ...current,
                    [account.id]: { kind: "error", message },
                  }))}
                />

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

                <div className="flex flex-wrap gap-2">
                  {account.status === "authenticating" ? (
                    <Button
                      variant="ghost"
                      size="sm"
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
                      size="sm"
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
                    size="sm"
                    onClick={() => void makePrimary(account)}
                    disabled={busy || account.isPrimary}
                    className="rounded-md"
                  >
                    Make primary
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
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

      {accounts.length > 0 && !accounts.some((a) => a.status === "ready") && (
        <ClearStoredCredentials provider={provider} serviceName={serviceName} />
      )}
    </div>
  );
}

/**
 * The escape hatch for credentials ShipIt holds and cannot use.
 *
 * Not the same thing as a row's **Disconnect**, which is why it survived the
 * card's removal rather than being folded into one. Disconnect deletes ONE
 * account; `DELETE /api/auth/api-key` is deliberately provider-wide (docs/150
 * req 19) — it clears every account's credentials *and* the singleton
 * pre-account path, which is where a legacy install's unscoped OAuth tokens
 * sit with no row to reach them from. Cross-backend review caught this being
 * dropped with the vendor tab that used to host it.
 *
 * The gate is account-derived, which the old one was not: it hung off
 * `agent.hasRunnableModels`, a HARNESS-wide flag that goes true as soon as any
 * unrelated service has a credential — the same flag that made the old status
 * dot green above "No subscription connected yet" (audit D5). "Rows exist and
 * none of them can authenticate" is the state this button is actually for.
 */
function ClearStoredCredentials({
  provider,
  serviceName,
}: {
  provider: AgentId;
  serviceName: string;
}) {
  const [clearing, setClearing] = useState(false);
  const setCardNotice = useSettingsStore((s) => s.setProviderAccountNotice);

  const clear = async (): Promise<void> => {
    setClearing(true);
    setCardNotice(provider, null);
    try {
      // The response carries the refreshed agent list; the server also fires an
      // SSE `agent_list` broadcast so other open tabs repaint too.
      const result = await request<{ agents?: AgentOption[]; accounts?: CredentialRoute[] }>(
        "/api/auth/api-key",
        { method: "DELETE" },
      );
      if (result.agents) useUiStore.getState().setAgentList(result.agents);
      if (result.accounts) useSettingsStore.getState().setProviderAccounts(result.accounts);
    } catch (err) {
      setCardNotice(provider, {
        kind: "error",
        message: messageOf(err, `Failed to clear stored ${serviceName} credentials`),
      });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="px-1" data-testid={`provider-stale-credentials-${provider}`}>
      <p className="text-xs text-(--color-text-tertiary)">
        None of these {serviceName} credentials could be verified.
      </p>
      <button
        onClick={() => void clear()}
        disabled={clearing}
        className="mt-0.5 text-xs text-(--color-text-link) transition-colors hover:text-(--color-accent) disabled:cursor-not-allowed disabled:opacity-50"
        data-testid={`provider-clear-credentials-${provider}`}
      >
        {clearing ? "Clearing..." : `Clear every stored ${serviceName} credential`}
      </button>
    </div>
  );
}
