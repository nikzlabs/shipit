import type { LoginIntegrationId } from "../../../server/shared/catalogue/types.js";
import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { AgentOption } from "../../agent-types.js";
import type { AgentId, CredentialRoute, SubscriptionLimits, SubscriptionLimitsMap } from "../../../server/shared/types.js";
import { getService, loginIntegrationForService, nativeServiceForHarness, subQuotaRefreshable } from "../../../server/shared/catalogue/index.js";
import { Button } from "../ui/button.js";
import { DropdownMenuItem } from "../ui/dropdown-menu.js";
import { SubscriptionLimitPill } from "../SubscriptionLimitsBadge.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { ProviderAccountNotice } from "../../stores/settings-store.js";
import {
  useSettingsStore,
  providerAccountAuthKey,
  EMPTY_CLAUDE_AUTH_DIAGNOSTICS,
} from "../../stores/settings-store.js";
import { CredentialRowShell } from "./CredentialRowShell.js";
import { credentialStatusWord, isUnconnectedAttempt } from "../../utils/credential-state.js";
import { useRowDrag } from "./useRowDrag.js";

/**
 * docs/150-multiple-provider-subscriptions req 16 / docs/252 — the account rows of an account-backed
 * subscription, and the sign-in they share with the add-service dialog.
 *
 * **Nothing here adds an account any more** (docs/252 req 17). The card's "Add
 * account" button is gone; what is left in its place is
 * {@link createAccount}, {@link startAccountLogin} and {@link AccountChallenge},
 * called and rendered by `AddServiceDialog`, which is the one way in. The challenge is a
 * shared component rather than a copy per host for the reason docs/150-multiple-provider-subscriptions req 16
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
 * the rows and the notices they produce. The per-vendor Settings tabs are gone,
 * so Services is the only host.
 *
 * **And the sign-in is not rendered here at all any more** (docs/252 req 19).
 * The row hosted `AccountChallenge` inline, which returns `null` until the auth
 * URL arrives — so between pressing *Reconnect* and the URL landing, the row
 * showed nothing. That is the same "it looks stuck" gap the dialog's step 3 was
 * built to close, so reconnect goes there instead of getting a second, poorer
 * copy of it: `onReconnect` asks `ServicesPanel` to open the one dialog on the
 * one step. What is left of the flow here is `createAccount`,
 * `startAccountLogin`, `AccountChallenge` and `AuthPanel` — exported for that
 * dialog, rendered by it, and by nothing else.
 *
 * Both providers' challenges keep to one slot in it, keyed by
 * {@link providerAccountAuthKey}, so two concurrent sign-ins can't overwrite
 * each other.
 *
 * Pay-as-you-go API keys stay deliberately out of the account list: they are
 * not subscriptions, they never participate in failover (req 12), and they bill
 * differently. They are their own `(service, key)` card one row down.
 */

/** The service whose subscription accounts this harness's login flow produces. */
export function serviceIdForProvider(provider: AgentId): string {
  return nativeServiceForHarness(provider) ?? provider;
}

/**
 * The login flow that connects this harness's accounts.
 *
 * The auth stores are keyed by login flow (see `providerAccountAuthKey`), while
 * these components are still handed a harness — they legitimately need one for
 * harness-shaped questions ("is this CLI installed?"). This is the one hop
 * between the two, so a card converts once instead of every store call
 * guessing. `undefined` means the service has no sign-in at all (a
 * key-only service), in which case there is no challenge to key.
 */
export function loginForProvider(provider: AgentId): LoginIntegrationId | undefined {
  return loginIntegrationForService(serviceIdForProvider(provider));
}

/** The catalogue's name for that service — "Anthropic", never "Claude". */
export function serviceNameForProvider(provider: AgentId): string {
  const serviceId = serviceIdForProvider(provider);
  return getService(serviceId)?.name ?? serviceId;
}

const harnessNames: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
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
 * This harness's accounts, in fallback order — **the connected ones**.
 *
 * Exported so the card that hosts these rows counts exactly what they render.
 * Deriving the count from a second, similar filter is how a header saying
 * "2 accounts" ends up over three rows, which is also why the attempt filter
 * lives here rather than at each call site: rows, count and routing controls
 * are all read from this one list.
 */
export function useProviderAccounts(provider: AgentId): CredentialRoute[] {
  return useAllProviderAccounts(provider).filter((account) => !isUnconnectedAttempt(account));
}

/**
 * Every row this harness has, attempts included — for the one caller that is
 * *conducting* an attempt and needs to see it: `AddServiceDialog`.
 */
export function useAllProviderAccounts(provider: AgentId): CredentialRoute[] {
  return providerAccountsOf(useSettingsStore((s) => s.providerAccounts), provider);
}

/**
 * The same narrowing as a plain function, for a caller that must read the list
 * **inside an event handler** rather than at render: the click that chooses a
 * billing mode also starts that mode's sign-in, and the hook above is keyed on
 * the mode already in state — a render behind.
 */
export function providerAccountsOf(
  allAccounts: CredentialRoute[],
  provider: AgentId,
): CredentialRoute[] {
  // planning#342 — the store holds `CredentialRoute`s, keyed by service. The
  // login flow is still the CLI's, so this narrows by the harness's own vendor
  // rather than by the harness.
  const serviceId = serviceIdForProvider(provider);
  return allAccounts.filter((account) => account.serviceId === serviceId);
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
export async function cancelAccountLogin(provider: AgentId, accountId: string): Promise<void> {
  try {
    await request(`/api/provider-accounts/${provider}/${accountId}/login/cancel`, { method: "POST" });
  } catch {
    // Already finished, already cancelled, or never started.
  }
}

export async function abandonAccount(provider: AgentId, accountId: string): Promise<void> {
  await cancelAccountLogin(provider, accountId);
  try {
    const result = await request<{ accounts: CredentialRoute[] }>(
      `/api/provider-accounts/${provider}/${accountId}`,
      { method: "DELETE" },
    );
    useSettingsStore.getState().setProviderAccounts(result.accounts);
  } catch {
    // Left on the card, where Disconnect reaches it.
  }
  const loginId = loginForProvider(provider);
  if (loginId) useSettingsStore.getState().setProviderAccountAuth(loginId, accountId, null);
}

/** Human-readable "somebody else is signing in" refusal, or `undefined`. */
export function signInBlockedReason(accounts: CredentialRoute[], accountId?: string): string | undefined {
  const signingIn = signingInAccount(accounts);
  if (!signingIn || signingIn.id === accountId) return undefined;
  return `Finish or cancel the sign-in on "${signingIn.label}" first.`;
}

const CHALLENGE_BOX =
  "space-y-2 rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) p-3";

const PULSE = "animate-pulse rounded bg-(--color-bg-secondary)";

/**
 * **One panel per sign-in, and everything about the sign-in is in it.**
 *
 * The same bordered box in every state — waiting, challenge, failure — so what
 * changes as a login proceeds is the box's *contents* and never the page around
 * it. Anything that rendered under the box (a live line, a disclosure, a status)
 * both moved the layout and gave the user two places to look; the rule is now
 * simply that there is one place.
 */
export function AuthPanel({
  busy,
  testId,
  children,
}: {
  busy?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={CHALLENGE_BOX} data-testid={testId} {...(busy ? { "aria-busy": true } : {})}>
      {children}
    </div>
  );
}

/**
 * The panel before the provider's code has arrived: **the same box, at the same
 * size**, saying where the sign-in has got to and pulsing for the rest.
 *
 * It shares {@link AuthPanel} with the real thing rather than approximating it,
 * because the whole job here is that nothing moves when the code lands — a
 * placeholder of a different height is the jump it exists to remove. For the
 * same reason it takes the `shape`: the two providers put different things in
 * that box (OpenAI a code to read, Anthropic a field to paste into), so one
 * placeholder can only be right for one of them.
 *
 * **`status` is what stops it reading as stuck.** A pulse says "something is
 * loading"; it does not say the thing is still going, and Anthropic's wizard
 * runs about six seconds. So ShipIt's phase message takes the slot the link
 * will occupy, and `children` — the collapsed output buffer — sits under it
 * INSIDE the box.
 */
export function ChallengePlaceholder({
  shape,
  status,
  testId,
  children,
}: {
  shape: "code" | "paste";
  /** Where the sign-in has got to, in ShipIt's words. Takes the link's slot. */
  status?: string;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <AuthPanel busy testId={testId}>
      {/* `h-4` / `text-xs`: the link above is inline, so its line box is 16px,
          and the stand-in has to be the same or the box changes height. */}
      {status ? (
        <p className="truncate text-xs leading-4 text-(--color-text-secondary)">{status}</p>
      ) : (
        <div className={`h-4 w-52 ${PULSE}`} />
      )}
      {shape === "code" ? (
        <div>
          <div className={`h-4 w-40 ${PULSE}`} />
          <div className={`mt-1 h-7 w-44 ${PULSE}`} />
        </div>
      ) : (
        // The paste row: a field and its Submit, both at their real heights.
        <div className="flex gap-2">
          <div className={`h-[34px] min-w-0 flex-1 ${PULSE}`} />
          <div className={`h-[34px] w-28 ${PULSE}`} />
        </div>
      )}
      {children}
    </AuthPanel>
  );
}

/**
 * **Where a sign-in has got to, in ShipIt's own words** — the phase message the
 * server broadcasts as the wizard advances.
 *
 * Returned as data rather than rendered, because it belongs *inside*
 * {@link ChallengePlaceholder}: the transient part of a sign-in is one panel,
 * not a stack of things near one.
 */
export function useAuthStatus(accountId: string | undefined): string | undefined {
  const all = useSettingsStore((s) => s.claudeAuthDiagnostics);
  const diagnostics = (accountId ? all[accountId] : undefined) ?? EMPTY_CLAUDE_AUTH_DIAGNOSTICS;
  return diagnostics.message ?? undefined;
}

/**
 * **The whole sign-in buffer, one collapsed control, inside the panel**
 * (docs/150).
 *
 * It is the record you open when something went wrong, and it is the ONLY place
 * the output is spelled out. Two rejected cuts are why that is stated so flatly:
 * a live three-line tail beside it put the same lines on screen twice, and this
 * control sitting *under* the box made the panel one of two places carrying the
 * sign-in.
 *
 * Claude only. Codex's device flow produces no such stream.
 */
export function ClaudeAuthOutput({
  accountId,
  evenWhenEmpty,
}: {
  /**
   * Undefined until the account this sign-in will hang on has been created —
   * a couple of hundred milliseconds into the flow. The control renders
   * anyway, empty, for the reason `evenWhenEmpty` exists: a panel that is
   * about to hold it should not grow when it appears.
   */
  accountId?: string;
  /**
   * Render the control before the first line arrives, for a panel that is
   * about to fill with them.
   *
   * The CLI's first entry lands a few frames after the login starts, so a
   * disclosure that waits for it grew the waiting panel by its own height
   * *after* the panel had already appeared — measured, 302 → 395 → 419 across
   * five frames, which is the second, smaller jump a user notices without
   * being able to say what moved. Reserving it costs a line that says
   * "Claude CLI output" for those few frames.
   */
  evenWhenEmpty?: boolean;
}) {
  // Read the map, then index — never `accountId ? useSettingsStore(...) : …`,
  // which changes the hook count on the render where the id arrives.
  const allDiagnostics = useSettingsStore((s) => s.claudeAuthDiagnostics);
  const diagnostics = (accountId ? allDiagnostics[accountId] : undefined)
    ?? EMPTY_CLAUDE_AUTH_DIAGNOSTICS;
  /**
   * **Open/closed is held in the store, not by the `<details>` element.**
   *
   * One sign-in renders this disclosure from two different components — the
   * waiting panel, then the challenge — so the element is destroyed and rebuilt
   * at the moment the code arrives. Left to itself it comes back closed: a user
   * reading the output had it snap shut under them, and the panel jumped by the
   * height of what they were reading. Keyed by account, so two rows cannot
   * share one answer.
   */
  const open = useSettingsStore((s) => (accountId ? s.claudeAuthOutputOpen[accountId] ?? false : false));
  const setOpen = useSettingsStore((s) => s.setClaudeAuthOutputOpen);
  const { entries } = diagnostics;
  if (entries.length === 0 && !evenWhenEmpty) return null;

  return (
    <details
      className="group"
      open={open}
      onToggle={(event) => { if (accountId) setOpen(accountId, event.currentTarget.open); }}
      data-testid={`provider-account-diagnostics-${accountId ?? "pending"}`}
    >
      <summary className="cursor-pointer select-none text-xs text-(--color-text-link) transition-colors hover:text-(--color-accent)">
        Claude CLI output{entries.length > 0 ? ` (${entries.length})` : ""}
      </summary>
      {/*
        **Pinned to the newest line, by `flex-col-reverse` rather than by a
        scroll effect.** In a reversed column the scroll origin *is* the bottom,
        so a single growing child keeps its end in view while the log streams —
        and a user who scrolls up to read stays where they put themselves, which
        an effect that assigns `scrollTop` on every append would fight. It also
        needs no effect at all, which this codebase restricts on purpose.

        `--font-size-code` (13px) is the size a code block in the chat reads at,
        and this is not that: it is a diagnostic dump, skimmed for the one line
        that explains a failure, and at 13px three entries filled the panel.
        10/14 mono fits a legible page of it in the same space.
      */}
      <div
        className="mt-2 flex max-h-48 flex-col-reverse overflow-auto rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-2"
        data-testid={`provider-account-diagnostics-scroll-${accountId ?? "pending"}`}
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-[14px] text-(--color-text-secondary)">
          {entries.map((entry) =>
            `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.source}: ${entry.message}`,
          ).join("\n")}
        </pre>
      </div>
    </details>
  );
}

/**
 * The provider's login challenge — **one implementation, and now one host.**
 *
 * It renders inside `AddServiceDialog` and nowhere else: docs/252 req 19 moved
 * reconnect into that dialog, so the copy that used to sit on the account row
 * is gone rather than kept in step. It stays a component in this module because
 * docs/150-multiple-provider-subscriptions req 16 already paid for the alternative once — a user's first account
 * connected by different code than their second — and because the dialog is not
 * the natural owner of the two providers' difference: Anthropic hands back an
 * authorization code the user pastes into ShipIt, OpenAI shows a user code the
 * user types on OpenAI's page, and that difference is the only branch.
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
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const loginId = loginForProvider(provider);
  const pendingAuth = loginId ? auths[providerAccountAuthKey(loginId, account.id)] ?? null : null;
  if (!pendingAuth) return null;

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
    <AuthPanel testId={`provider-account-challenge-${account.id}`}>
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

      {/* Claude's CLI-driven sign-in is the one that strands users, so its
        record stays reachable — docs/150 — and it belongs to the attempt that
        produced it, so it is read by account id. Inside the panel, because
        the panel is where the sign-in is. */}
      {provider === "claude" && <ClaudeAuthOutput accountId={account.id} />}
    </AuthPanel>
  );
}

/**
 * This account's quota snapshot, if the provider has reported one.
 *
 * `subscription_limits` is keyed `(service, mode) → routeId`, and an account
 * that has simply been quiet has no entry — which is not the same as 0%. The
 * pill renders either way and says `—` for the windows it has no number for, so
 * the absence is passed through rather than filled in.
 */
function snapshotFor(
  limits: SubscriptionLimitsMap,
  account: CredentialRoute,
): SubscriptionLimits | undefined {
  return limits[`${account.serviceId}:sub`]?.[account.id];
}

export function ProviderAccountRows({
  provider,
  agent,
  billingMode,
  onReconnect,
}: {
  provider: AgentId;
  agent: AgentOption | undefined;
  /**
   * Which mode's quota these rows report. Only a subscription has one (req 10),
   * and an account row only ever belongs to one — but the pill is keyed by
   * `(service, mode)` and this is the caller's fact, not a re-derivation.
   */
  billingMode: string;
  /**
   * Re-run the sign-in for an account, **in the add-service dialog** (req 19).
   *
   * A callback rather than a login started here, because the surface reconnect
   * needs already exists and there must be exactly one of it. This row used to
   * `POST …/login` itself and render `AccountChallenge` inline — and that
   * component returns `null` until the auth URL arrives, so between the click
   * and the URL the row showed nothing at all. The dialog's step 3 closed that
   * gap already: the waiting skeleton, the CLI output buffer, the code field
   * and the failure state are all there. `ServicesPanel` owns the one mount
   * site, so what travels up here is the request, not a second dialog.
   */
  onReconnect: (accountId: string) => void;
}) {
  const accounts = useProviderAccounts(provider);
  const limits = useUiStore((s) => s.subscriptionLimits);
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
  const loginId = loginForProvider(provider);
  const cardNotice = useSettingsStore((s) => (loginId ? s.providerAccountNotices[loginId] : undefined));
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

  /**
   * Close the rename field without saving.
   *
   * A draft's *presence* is what holds the field open now, so dropping it is
   * both the cancel and the close — there is no second "is it open" flag to
   * fall out of step with it.
   */
  const cancelRename = (accountId: string): void => {
    setDraftLabels((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => id !== accountId),
    ));
  };

  const saveLabel = async (account: CredentialRoute) => {
    const label = (draftLabels[account.id] ?? account.label).trim();
    // An empty or unchanged name still CLOSES the field: the draft is what
    // holds it open, so returning early with the draft in place left the user
    // typing into a field that had stopped listening.
    if (!label || label === account.label) {
      cancelRename(account.id);
      return;
    }
    setSavingId(account.id);
    clearRow(account.id);
    try {
      const result = await request<{ accounts: CredentialRoute[] }>(`/api/provider-accounts/${provider}/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label }),
      });
      setProviderAccounts(result.accounts);
      cancelRename(account.id);
    } catch (err) {
      failRow(account.id, err, "Failed to rename account");
    } finally {
      setSavingId(null);
    }
  };

  /**
   * docs/150-multiple-provider-subscriptions req 2 — the fallback order, now set by dropping a row (req 21).
   *
   * *Make primary* went with the carets, and deleting it was the point rather
   * than a consequence: "primary" was never a property. `isPrimary` is stamped
   * on read from position, every writer stores `false`, and the endpoint behind
   * that button was this same reorder with the account moved to the front — a
   * button that reordered, beside the controls that reorder.
   *
   * Sends the whole order rather than "move this one": the server rejects a
   * partial list, so a card rendered before another tab added an account fails
   * visibly instead of quietly demoting it to the end.
   */
  const reorderAccounts = async (nextIds: string[]) => {
    const moved = nextIds.find((id, index) => accounts[index]?.id !== id);
    setSavingId(moved ?? null);
    if (moved) clearRow(moved);
    try {
      const result = await request<{ accounts: CredentialRoute[] }>(`/api/provider-accounts/${provider}/order`, {
        method: "PUT",
        body: JSON.stringify({ accountIds: nextIds }),
      });
      setProviderAccounts(result.accounts);
    } catch (err) {
      if (moved) failRow(moved, err, "Failed to reorder accounts");
    } finally {
      setSavingId(null);
    }
  };

  /**
   * docs/260-turn-level-account-routing req 3 — disconnect is one click. There is no pinned-session
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
    if (loginId) setCardNotice(loginId, null);
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

  const cancelLogin = async (account: CredentialRoute) => {
    setSavingId(account.id);
    clearRow(account.id);
    try {
      await request(`/api/provider-accounts/${provider}/${account.id}/login/cancel`, { method: "POST" });
      if (loginId) setProviderAccountAuth(loginId, account.id, null);
    } catch (err) {
      failRow(account.id, err, "Failed to cancel sign-in");
    } finally {
      setSavingId(null);
    }
  };

  // The challenge itself is the dialog's now (req 19) — this only decides
  // whether the menu's Reconnect can be pressed, which is the same question
  // `AddServiceDialog` asks before it starts one.
  const blockedBy = (accountId: string): string | undefined =>
    signInBlockedReason(accounts, accountId);

  const dragFor = useRowDrag(
    accounts.map((a) => a.id),
    (next) => void reorderAccounts(next),
    savingId !== null,
  );

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
          onDismiss={() => loginId && setCardNotice(loginId, null)}
          testId={`provider-accounts-notice-${provider}`}
        />
      )}

      {/*
        There is no empty state here any more (req 19). It used to print "No
        {service} subscription connected. Add one with Add a service." — above a
        connected credential of that same service, whenever the card held a
        supplied key and no account. Its docstring assumed the only way to reach
        it was a notice holding an empty card open, which stopped being true
        when the two delivery shapes became one card. A card that reaches zero
        accounts and has nothing else to say is removed by the panel, so the box
        was never the thing keeping it on screen.
      */}
      {accounts.length > 0 && (
        <div className="space-y-1">
          {accounts.map((account) => {
            const busy = savingId === account.id;
            const authError = loginId
              ? accountAuthErrors[providerAccountAuthKey(loginId, account.id)] ?? null
              : null;
            const renaming = account.id in draftLabels;
            const blocked = blockedBy(account.id);
            return (
              <CredentialRowShell
                key={account.id}
                testId={`provider-account-row-${account.id}`}
                label={account.label}
                {...(credentialStatusWord(account) ? { status: credentialStatusWord(account) } : {})}
                drag={dragFor(account.id)}
                menuLabel={`Manage ${account.label}`}
                quota={
                  // Only a subscription reports a quota (req 10), and only a
                  // connected one has anything to report. `label` is omitted:
                  // the row to its left IS the account's name.
                  billingMode === "sub" && account.status === "ready" ? (
                    <SubscriptionLimitPill
                      serviceId={account.serviceId}
                      routeId={account.id}
                      {...(snapshotFor(limits, account) ? { snapshot: snapshotFor(limits, account) } : {})}
                      showRefresh={subQuotaRefreshable(account.serviceId)}
                    />
                  ) : undefined
                }
                menu={
                  <>
                    <DropdownMenuItem
                      onSelect={() => setDraftLabels((current) => ({ ...current, [account.id]: account.label }))}
                      data-testid={`provider-account-rename-${account.id}`}
                    >
                      Rename
                    </DropdownMenuItem>
                    {account.status === "authenticating" ? (
                      <DropdownMenuItem
                        onSelect={() => void cancelLogin(account)}
                        disabled={busy}
                        data-testid={`provider-account-cancel-login-${account.id}`}
                      >
                        Cancel sign-in
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => onReconnect(account.id)}
                        disabled={busy || !!blocked}
                        {...(blocked ? { title: blocked } : {})}
                        data-testid={`provider-account-connect-${account.id}`}
                      >
                        {account.status === "ready" ? "Reconnect" : "Connect"}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onSelect={() => void disconnect(account)}
                      disabled={busy}
                      className="text-(--color-error) hover:text-(--color-error) focus:text-(--color-error)"
                      data-testid={`provider-account-disconnect-${account.id}`}
                    >
                      {busy ? "Working…" : "Disconnect"}
                    </DropdownMenuItem>
                  </>
                }
                error={
                  <>
                    {authError && (
                      <p className="px-1 pb-1 text-[11px] text-(--color-error)" data-testid={`provider-account-error-${account.id}`}>
                        {authError}
                      </p>
                    )}
                    {rowNotices[account.id] && (
                      <div className="pb-1 pt-1">
                        <NoticeLine
                          notice={rowNotices[account.id]}
                          testId={`provider-account-notice-${account.id}`}
                        />
                      </div>
                    )}
                  </>
                }
              >
                {/* Rename opens the field the row used to hold permanently —
                    which was most of its 120px, for something done once per
                    account and often never. */}
                {renaming && (
                  <input
                    autoFocus
                    value={draftLabels[account.id] ?? account.label}
                    onChange={(e) => setDraftLabels((current) => ({ ...current, [account.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveLabel(account);
                      if (e.key === "Escape") cancelRename(account.id);
                    }}
                    onBlur={() => void saveLabel(account)}
                    className="mt-1 w-full rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-1.5 py-0.5 text-xs text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
                    aria-label={`${serviceName} account label`}
                    data-testid={`provider-account-rename-input-${account.id}`}
                  />
                )}
              </CredentialRowShell>
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

  const loginId = loginForProvider(provider);
  const clear = async (): Promise<void> => {
    setClearing(true);
    if (loginId) setCardNotice(loginId, null);
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
      if (loginId) {
        setCardNotice(loginId, {
          kind: "error",
          message: messageOf(err, `Failed to clear stored ${serviceName} credentials`),
        });
      }
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
