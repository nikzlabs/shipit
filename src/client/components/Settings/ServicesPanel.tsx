/**
 * docs/252 phase 2 — Settings → Services.
 *
 * **A list of what you configured, not of what exists.** It starts empty; the
 * catalogue appears inside the "Add a service" dialog, at the moment it is a
 * choice. That keeps the screen proportional to the user's setup rather than to
 * ShipIt's — the rejected layout (a Connected/Available listing of everything
 * ShipIt knows) grew with the catalogue whether or not any of it was used. The
 * discoverability cost was weighed and accepted: someone who needs OpenRouter
 * or Vercel is looking for it and will find it one click in.
 *
 * **One card per `(service, billing mode)`** — exactly the picker's grouping
 * (req 5). An earlier draft made every credential its own row, so two Anthropic
 * subscriptions were two rows here and one group in the picker, with the two
 * surfaces counting differently.
 *
 * **And one card *component*.** Credentials arrive two ways — a login-backed
 * account (Anthropic, OpenAI) or a supplied string (an API key, or a
 * subscription authenticated by one, like GLM's coding plan) — and for a while
 * each way brought its own card with it: the string one bordered and inside
 * this list, the account one borderless, titled after the *harness* vendor, and
 * rendered *outside* it. Now `ServiceCard` owns the chrome for both and the two
 * delivery shapes are just two bodies inside it. A mode that takes both at once
 * (Anthropic's subscription accepts an OAuth account *and* an env-supplied
 * token) is still ONE card, with both bodies stacked — collapsing to a single
 * body is what would hide a credential the user could then neither see nor
 * revoke.
 *
 * An API-key card has **no routing controls at all** — not a disabled group,
 * not an empty section, and no sentence explaining the absence. Keys do not
 * fail over (req 12), so there is nothing to order and nothing to spread. The
 * asymmetry between the two card types is req 12 rendered.
 *
 * **Deliberately not welded to Settings' page chrome.** docs/257's onboarding
 * panel hosts this component as-is — same card list, same dialog, same steps —
 * so it takes no props from the Settings route, renders no dialog shell of its
 * own, and brings **no padding and no scroll container**: each host frames it
 * (Settings with the tab padding every other tab uses, onboarding inside its
 * card). Since the per-vendor Claude/Codex tabs were removed, it is also the
 * *only* place a credential of any kind is added, seen or revoked.
 *
 * **One dense layout, both hosts.** The heading, the caption and the "Add a
 * service" button share one row, and "no services yet" is that caption rather
 * than a dashed box with two paragraphs and a third copy of the button. It was
 * written at Settings-page density and then hosted in the chat pane, where a
 * three-line header and a six-unit empty state pushed the one control the panel
 * exists for below the fold — but the compact form is no worse on the Settings
 * page, so there is one layout rather than a variant per host.
 *
 * **The background-work model is NOT here.** It is a setting about services
 * rather than a service, it has a working default that follows whatever the
 * install can run (`BackgroundWorkSection`, "ShipIt's default"), and a first-run
 * user has nothing to decide about it — so onboarding must not spend its screen
 * asking. Since the panel is shared, the section moved out to the Settings tab
 * that hosts it, which is also where someone who wants to pin it goes looking.
 */

import { useRef, useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { AgentOption } from "../../agent-types.js";
import type { AgentId, CredentialRoute } from "../../../server/shared/types.js";
import { credentialModeKey } from "../../../server/shared/types/domain-types/credential-route.js";
import {
  allServices,
  harnessForNativeService,
  modeAllowsMultipleCredentials,
  modeCredentialFor,
  type BillingMode,
  type ServiceDef,
} from "../../../server/shared/catalogue/index.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.js";
import { DropdownMenuItem } from "../ui/dropdown-menu.js";
import { providerAccountAuthKey, useSettingsStore } from "../../stores/settings-store.js";
import { CredentialRowShell } from "./CredentialRowShell.js";
import { useRowDrag, type RowDragProps } from "./useRowDrag.js";
import {
  AccountChallenge,
  ChallengePlaceholder,
  AuthPanel,
  ClaudeAuthOutput,
  useAuthStatus,
  ProviderAccountRows,
  abandonAccount,
  cancelAccountLogin,
  createAccount,
  isUnconnectedAttempt,
  providerAccountsOf,
  signInBlockedReason,
  startAccountLogin,
  useAllProviderAccounts,
  useProviderAccounts,
} from "./ProviderAccountRows.js";
import { MODE_LABEL, NothingToRouteYet, ServiceCard } from "./ServiceCard.js";
import { CredentialSelectionModeControl, FailoverCutoffControls } from "./CredentialRouting.js";

/** Every `(service, mode)` the catalogue declares, flattened in catalogue order. */
function catalogueModes(): { service: ServiceDef; billingMode: BillingMode }[] {
  return allServices().flatMap((service) =>
    service.modes.map((mode) => ({ service, billingMode: mode.kind })),
  );
}

function modelIds(service: ServiceDef, billingMode: BillingMode): string[] {
  return service.modes.find((m) => m.kind === billingMode)?.models.map((m) => m.id) ?? [];
}

/**
 * The harness whose accounts belong to this `(service, mode)`, when the mode is
 * account-backed at all.
 *
 * Read from the catalogue rather than from the credential list because the two
 * feeds update independently: connecting an account broadcasts
 * `provider_accounts` (14 call sites) and not `credential_routes`, so a panel
 * that decided "is this account-backed?" from the route list would not notice
 * the first account connected in another tab until a reload. The catalogue
 * answers the question that does not change, and the live account list answers
 * the one that does.
 */
function accountProviderFor(service: ServiceDef, billingMode: BillingMode): AgentId | undefined {
  if (!modeCredentialFor(service.id, billingMode, "account")) return undefined;
  return harnessForNativeService(service.id);
}

/**
 * An attempt the add-flow would **adopt** rather than compete with: the one it
 * is already conducting, or one stranded by a reload — invisible in the panel
 * ({@link isUnconnectedAttempt}) and holding the provider's single login slot
 * with nothing on screen to release it.
 *
 * One function because the answer is read in three places — the render, the
 * click that starts a sign-in, and the check for whether one can start — and a
 * second copy of the rule is how they come to disagree.
 */
function adoptableAttempt(
  accounts: CredentialRoute[],
  signInAccountId?: string,
): CredentialRoute | undefined {
  return (signInAccountId ? accounts.find((a) => a.id === signInAccountId) : undefined)
    ?? accounts.find(isUnconnectedAttempt);
}

/**
 * **Signing in is the whole of step 3 for this mode** — it accepts an account
 * and nothing else, so the step has no field to fill in and no choice to make.
 *
 * Read from the catalogue, and the reason it is a question at all: OpenAI's
 * subscription is account-only, so its step 3 was one button over one sentence
 * — a click that asked nothing and could only be answered one way. Anthropic's
 * subscription is not, because it also takes an env-supplied token, so its step
 * really does have something to look at and the sign-in stays a decision.
 */
function signInIsTheWholeStep(service: ServiceDef, billingMode: BillingMode): boolean {
  return !!modeCredentialFor(service.id, billingMode, "account")
    && !modeCredentialFor(service.id, billingMode, "string");
}

/**
 * **Leave the sign-in this dialog was hosting, without taking a credential with
 * it.**
 *
 * The rule the dialog had was "abandon whatever `signInAccountId` names", which
 * was right while every id it held was one it had minted. Req 19's reconnect
 * breaks that: the id is now sometimes an account the user has been using for
 * months, and abandoning it DELETES it — so changing your mind about
 * re-authenticating would revoke the working credential. The worst thing this
 * feature could ship, and a guard test pins it.
 *
 * So the question is asked of the row rather than of how the dialog came by it:
 * `isUnconnectedAttempt` is exactly "this has never been a credential", it is
 * the same predicate the panel uses to decide what to list, and the two must
 * agree — anything the panel hides, this must clean up.
 *
 * Either way the LOGIN is cancelled. It is a live process on the provider's
 * side, and leaving one running against a row is how the next sign-in ends up
 * refused with a 409 nobody can clear from the UI.
 */
function standDown(provider: AgentId, account: CredentialRoute | undefined): void {
  if (!account) return;
  if (isUnconnectedAttempt(account)) void abandonAccount(provider, account.id);
  else void cancelAccountLogin(provider, account.id);
}

export function ServicesPanel({ agentList = [] }: { agentList?: AgentOption[] }) {
  const routes = useSettingsStore((s) => s.credentialRoutes);
  const accounts = useSettingsStore((s) => s.providerAccounts);
  const notices = useSettingsStore((s) => s.providerAccountNotices);
  /**
   * The accounts the user *has*, which is not every row the store holds: a
   * sign-in in flight has a row and is not a credential yet. See
   * {@link isUnconnectedAttempt} — deriving it from the account is what stops
   * the panel flickering a card in and out around one.
   */
  const connectedAccounts = accounts.filter((a) => !isUnconnectedAttempt(a));
  /**
   * **The panel's one dialog, and the whole of how it was opened** (req 19).
   *
   * `null` is closed. `{}` is *Add a service* from the top. A reconnect fills
   * all three fields, which is exactly the input the dialog's step 3 already
   * takes — `(service, mode, accountId)` — so reconnect is this component
   * entered differently rather than a `ReconnectDialog`.
   *
   * Held as one object rather than an `addOpen` boolean beside a
   * `reconnectTarget`, because two flags is how a panel comes to have two
   * dialogs: the second state ends up mounting its own.
   */
  const [dialog, setDialog] = useState<
    { service?: ServiceDef; mode?: BillingMode; accountId?: string } | null
  >(null);

  /**
   * **A service appears once it has a credential — never before** (req 17).
   *
   * There used to be a fourth clause here: modes the user had *picked* in the
   * dialog, held in the UI store as `revealedServiceModes`. It existed because
   * the dialog was a dead end for a subscription connected by signing in —
   * picking OpenAI → Subscription told the user to press "Add account on its
   * card" while no such card existed — so the dialog revealed an empty card for
   * the button to live on. That hand-off is gone: the sign-in happens inside the
   * dialog now, and the account exists before any card does.
   *
   * Deleting the clause is also the fix for what the reveal cost. The other
   * three all have a way out — remove the key, disconnect the account, dismiss
   * the notice — and a revealed mode had none, so a user who chose a
   * subscription and stopped was left with a service they could not remove.
   *
   * The notice clause (docs/257 req 5) stays: disconnecting the LAST account
   * removes the account and would drop the card in the same commit, so the
   * result of that disconnect would mount and unmount together and the user
   * would never see which sessions the removal stranded.
   */
  const configured = catalogueModes().filter(({ service, billingMode }) => {
    const provider = accountProviderFor(service, billingMode);
    return routes.some((r) => r.serviceId === service.id && r.billingMode === billingMode && r.via === "string")
      || (provider !== undefined
        && connectedAccounts.some((a) => a.serviceId === service.id && a.billingMode === billingMode))
      || (provider !== undefined && notices[provider] !== undefined);
  });

  const cards = configured.map(({ service, billingMode }) => (
    <ServiceModeCard
      key={credentialModeKey(service.id, billingMode)}
      service={service}
      billingMode={billingMode}
      routes={routes.filter((r) => r.serviceId === service.id && r.billingMode === billingMode)}
      agentList={agentList}
      onReconnect={(accountId) => {
        /**
         * **Open the dialog first, then start the login** — in that order, and
         * both from the click.
         *
         * The order is the fix. The row used to post `/login` itself and render
         * `AccountChallenge` inline, and that component returns `null` until
         * the auth URL arrives, so the row showed *nothing* between the click
         * and the URL. Opening first means the dialog's step 3 is on screen
         * from the first frame, with its waiting panel, its phase message and
         * its CLI output buffer — the surface built to fill exactly that gap.
         *
         * The login runs here rather than inside the dialog because the click
         * IS the event: a dialog that started its own login would have to do it
         * on mount, which this codebase spends `eslint-disable` lines avoiding.
         * `cancelAccountLogin` first, because the CLI outlives the browser and
         * an adopted attempt may still have one running — without it the start
         * is a 409.
         */
        const provider = accountProviderFor(service, billingMode);
        if (!provider) return;
        setDialog({ service, mode: billingMode, accountId });
        void (async () => {
          try {
            await cancelAccountLogin(provider, accountId);
            await startAccountLogin(provider, accountId);
          } catch {
            // Swallowed on purpose: the dialog is already showing this
            // account's sign-in, and a start that never happened lands there
            // as the stalled state with its own *Try again* — reporting it
            // twice would put the same failure on the card behind the modal.
          }
        })();
      }}
    />
  ));

  // "Nothing configured" is the caption under the heading rather than a box of
  // its own: empty, the whole panel is two lines and a button.
  const empty = configured.length === 0;

  return (
    <div className="flex flex-col gap-3" data-testid="services-panel">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Services</h3>
        <p
          className="mt-0.5 text-xs text-(--color-text-tertiary)"
          // The empty state keeps its own test id, because "nothing configured"
          // is still a distinct state — it is just said in a line now instead of
          // a dashed box.
          {...(empty ? { "data-testid": "services-empty" } : {})}
        >
          {empty
            ? "Connect one to start — a subscription you already pay for, or an API key."
            : "ShipIt defines the services; you supply the credential."}
        </p>
      </div>

      {cards}

      {/*
        **The add control follows the list**, which is one rule covering both
        states: empty it lands directly under the ask, and with cards it lands
        under them — the same left edge as everything above it either way. It sat
        opposite the heading first, which is where a section action usually goes
        and is exactly the problem: the eye finishes the caption on the left and
        the only control is in the far corner, across a gap of nothing. That is
        worse here than in an ordinary settings section, because for a first-run
        user this button is not *an* action on the panel, it is the whole panel.
      */}
      <div>
        <Button
          variant={empty ? "primary" : "secondary"}
          // Standard height, not `sm`: the row is compact enough without
          // shrinking the target.
          size="md"
          className="rounded-md"
          onClick={() => setDialog({})}
          data-testid={empty ? "services-add-empty" : "services-add"}
        >
          <PlusIcon size={ICON_SIZE.XS} /> Add a service
        </Button>
      </div>

      <InstalledHarnesses agentList={agentList} />
      {/*
        **One mount site, whichever way the dialog was opened.** A copy of step
        3 in a row, a second `Dialog` mounted from `ProviderAccountRows`, or a
        "reconnect mode" branch that re-implements the panel are all the wrong
        seam: the dialog's step 3 is already parameterised by
        `(service, mode, accountId)`, and that is the entire input reconnect
        has. A test asserts exactly one `add-service-dialog` is mounted.
      */}
      {dialog && (
        <AddServiceDialog
          {...(dialog.service ? { initialService: dialog.service } : {})}
          {...(dialog.mode ? { initialMode: dialog.mode } : {})}
          {...(dialog.accountId ? { reconnectAccountId: dialog.accountId } : {})}
          agentList={agentList}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/**
 * What can actually *drive* the credentials above — read-only, and the other
 * half of "can this install run a turn".
 *
 * docs/252 separates the service that bills a model from the harness that runs
 * it, so a stored credential is not by itself runnable: req 8's eligibility is
 * a join, and a model only becomes selectable when an installed harness can
 * carry it. That makes "which harnesses are installed" a fact this screen
 * cannot leave unsaid — without it, a user who has pasted a working key and
 * still cannot chat has nothing on screen explaining the gap, and the same
 * blank is what docs/257 req 8 warns about when it says storing a credential
 * has not finished onboarding.
 *
 * It is a **statement, not a control**: harnesses are installed in the image,
 * not from the browser, so there is nothing to press here. Per-harness the row
 * says whether that harness has a model this install can run
 * (`hasRunnableModels`), because that is the join above rendered — a harness
 * with none is exactly the case a credential above is about to fix.
 */
function InstalledHarnesses({ agentList }: { agentList: AgentOption[] }) {
  const installed = agentList.filter((a) => a.installed);
  // Nothing known yet (the agent list arrives with the bootstrap) reads the
  // same as "none installed" if we render the empty case, so say nothing until
  // there is something to say.
  if (agentList.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5" data-testid="installed-harnesses">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Installed harnesses</h3>
      {installed.length === 0 ? (
        <p className="text-xs text-(--color-text-tertiary)">
          None. A service credential cannot run a turn on its own — this install has no harness
          to drive it.
        </p>
      ) : (
        // One per line: they are facts to read down, not chips to scan across,
        // and a wrapped row put two harnesses on one line in the onboarding
        // panel and one per line in Settings for no reason but the width
        // available. `items-start` keeps each row the width of its own content
        // rather than stretching the fill across the panel.
        <ul className="flex flex-col items-start gap-1">
          {installed.map((agent) => (
            <li
              key={agent.id}
              className="flex items-center gap-1.5 rounded-md bg-(--color-bg-secondary) px-2 py-1 text-xs text-(--color-text-secondary)"
              data-testid={`installed-harness-${agent.id}`}
            >
              <span
                aria-hidden
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  agent.hasRunnableModels ? "bg-(--color-success)" : "bg-(--color-text-tertiary)"
                }`}
              />
              {agent.name}
              {!agent.hasRunnableModels && (
                <span className="text-(--color-text-tertiary)">· no model it can run yet</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ServiceModeCard({
  service,
  billingMode,
  routes,
  agentList,
  onReconnect,
}: {
  service: ServiceDef;
  billingMode: BillingMode;
  routes: CredentialRoute[];
  agentList: AgentOption[];
  /** Passed through to the account rows — see their prop's docstring. */
  onReconnect: (accountId: string) => void;
}) {
  // A mode can hold BOTH shapes at once — Anthropic's subscription takes an
  // OAuth account and an env-supplied token — so this renders whichever are
  // present rather than choosing one. Collapsing to a single body is what would
  // hide a credential the user could then neither see nor revoke.
  const provider = accountProviderFor(service, billingMode);
  // The rows' own narrowing, not a second one that looks like it — see the
  // hook. A card with `provider === undefined` has no account body, so the
  // placeholder harness it is called with contributes nothing.
  const providerAccounts = useProviderAccounts(provider ?? "claude");
  const accounts = provider ? providerAccounts : [];
  const stringRoutes = routes.filter((r) => r.via === "string");
  const multiple = modeAllowsMultipleCredentials(billingMode);
  // Counted from both feeds rather than from `routes` alone: `credentialRoutes`
  // is a superset of `providerAccounts` on the wire, but the two are broadcast
  // by different events, so a freshly connected account is in one and not yet
  // in the other.
  const credentialCount = accounts.length + stringRoutes.length;
  /**
   * A mode holding BOTH shapes at once — Anthropic's subscription takes an
   * OAuth account *and* an env-supplied token.
   *
   * Rare, and load-bearing for everything below, because **the two shapes are
   * not one routing pool**: `selectAccountForTurn` answers for the accounts,
   * and phase 5 decided that an `all_exhausted` account walk is returned
   * unchanged rather than falling through to this mode's env-delivered token
   * (`service-routing.ts`). Presenting the total as one number and offering
   * "spread across accounts" over it would describe a pool the server does not
   * have.
   *
   * **Both shapes PRESENT, not both shapes possible.** This read
   * `provider !== undefined && stringRoutes.length > 0` — "this mode can take
   * an account, and holds a string" — which is a different question, and req
   * 20 turned the difference into a visible bug. Anthropic's subscription can
   * take an account; a dogfood install has none and two supplied credentials,
   * and those two ARE one routing pool. Reading "can" for "does" told the card
   * they were a mixed pair, so it offered no order between them and no routing
   * band at all — two credentials the user could neither order nor choose
   * between. It was unreachable before adoption, because the second string
   * credential was invisible.
   */
  const mixedDelivery = accounts.length > 0 && stringRoutes.length > 0;
  /**
   * What one credential of this mode *is*, in the user's words. An
   * account-backed subscription has accounts; everything else has credentials,
   * and calling a pasted key an "account" is the conflation this whole feature
   * removes. A mixed card holds both, so it says the wider word.
   */
  /**
   * What the header's count pill calls the things it is counting.
   *
   * "account" only when every counted credential IS one — the same
   * present-not-possible correction as `mixedDelivery`. Reading it off
   * `provider` said "2 accounts" over two supplied credentials on a card with
   * no account at all, which is precisely the account/credential conflation
   * this whole feature exists to remove.
   */
  const noun = accounts.length > 0 && stringRoutes.length === 0 ? "account" : "credential";
  /**
   * The credentials the routing controls actually route between.
   *
   * The accounts when there are any, and otherwise the strings — **not** "the
   * accounts whenever the mode could have some". The same correction as
   * `mixedDelivery` above and for the same reason: a mode that accepts an
   * account but currently holds two supplied credentials has a real pool of
   * two, and reading the empty account list as the pool left it with no
   * controls at all.
   */
  const routedByAccount = accounts.length > 0;
  const routedCredentials = routedByAccount ? accounts : stringRoutes;
  const routedNoun = routedByAccount ? "account" : "credential";
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState("");

  /**
   * req 21 — a dropped row rewrites the group's whole order.
   *
   * Owned by the card rather than by the row, because the endpoint takes the
   * complete set and only the card holds it. That is the same reason the carets
   * this replaces had to be handed an `ids` array: a row can say where it
   * landed, never what the list now is.
   */
  const reorderStrings = async (routeIds: string[]): Promise<void> => {
    setReordering(true);
    setReorderError("");
    try {
      const res = await fetch(`/api/credential-routes/${service.id}/${billingMode}/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeIds }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { routes: CredentialRoute[] };
      useSettingsStore.getState().setCredentialRoutes(data.routes);
    } catch (err) {
      setReorderError(err instanceof Error && err.message ? err.message : "Failed to reorder the credentials");
      console.error("[services] credential reorder failed:", err);
    } finally {
      setReordering(false);
    }
  };

  const stringDrag = useRowDrag(
    stringRoutes.map((r) => r.id),
    (next) => void reorderStrings(next),
    reordering,
  );

  // req 12 — `key` is single-credential by definition, so an API-key card gets
  // no routing band at all: not a disabled group, not an empty section, and no
  // sentence explaining the absence.
  //
  // req 19 — one row: the segmented control on the left, the cutoffs on the
  // right. The band's four explanatory strings are kept in tooltips on those
  // same controls (`CredentialRouting`), not deleted with the lines they were
  // on.
  const routing = !multiple ? undefined : routedCredentials.length > 1 ? (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <CredentialSelectionModeControl
        serviceId={service.id}
        billingMode={billingMode}
        serviceName={service.name}
        noun={routedNoun}
      />
      {/* D14 / planning#339 — a cutoff is a percentage of a *reported* quota,
          and only account-backed subscriptions report one today. On a
          string-delivered plan the control would set a number that can never
          fire, which is the dishonesty req 10 refuses one surface over. */}
      {provider && accounts.length > 1 && (
        <FailoverCutoffControls
          serviceId={service.id}
          billingMode={billingMode}
          serviceName={service.name}
          provider={provider}
        />
      )}
    </div>
  ) : routedCredentials.length === 1 ? (
    // Exactly one, never zero: with none connected the card is already asking
    // for the first one, and "nothing to route between yet" under that ask
    // states the obvious twice.
    <NothingToRouteYet noun={routedNoun} />
  ) : undefined;

  // req 17 — **no card action of any kind.** A card shows what is there and
  // lets the user manage it; everything is added through the panel's one "Add a
  // service" button, including the second account of a service and the second
  // key of a subscription that allows several. This card used to carry "Add
  // account" for one delivery shape and "Add another" for the other — two doors
  // into one dialog, permanently on screen, for something done rarely.
  return (
    <ServiceCard
      service={service}
      billingMode={billingMode}
      credentialCount={credentialCount}
      countNoun={noun}
      models={modelIds(service, billingMode)}
      routing={routing}
      testId={`service-card-${credentialModeKey(service.id, billingMode)}`}
    >
      {/* The docs/150 account rows, whole: the login flow and the fallback
          order live there and are not reimplemented here. */}
      {provider && (
        <ProviderAccountRows
          provider={provider}
          agent={agentList.find((a) => a.id === provider)}
          billingMode={billingMode}
          onReconnect={onReconnect}
        />
      )}
      {stringRoutes.length > 0 && (
        <div className="space-y-1">
          {/*
            **The environment-variable sentence is gone** (req 19/20), and not
            because it was verbose. Its first clause — "Supplied by an
            environment variable" — was simply FALSE: the panel printed it for
            every `via: "string"` row on an account-backed card, and those rows
            are ordinary stored credentials with no recorded provenance. The
            rows that prompted the report had been added by hand through the
            dialog. Its second clause is true and is reqs 12/13, which do not
            need printing on every card to stay true.

            Req 20 removes the distinction the sentence was reaching for: a
            deployment-supplied credential is adopted into an ordinary row at
            boot (`adoptEnvCredentials`), so there is no longer a category of
            credential that behaves differently from one the user added.
          */}
          {stringRoutes.map((route) => (
            <StringCredentialRow
              key={route.id}
              route={route}
              // req 2's fallback order, and it is not cosmetic: the FIRST
              // credential of a group is the one delivered, so moving a row
              // changes which key sessions receive.
              //
              // Never offered on a mixed card: the reorder endpoint requires
              // EVERY route of the `(service, mode)` exactly once
              // (`reorderCredentialRoutes`), and the account rows are in that
              // set — so a list of just these ids is a 400. There is nothing to
              // order anyway, since the env token is not in the accounts'
              // failover chain.
              drag={multiple && !mixedDelivery ? stringDrag(route.id) : undefined}
            />
          ))}
          {reorderError && (
            <p
              className="px-1 text-[11px] text-(--color-error)"
              role="alert"
              data-testid={`credential-reorder-error-${credentialModeKey(service.id, billingMode)}`}
            >
              {reorderError}
            </p>
          )}
        </div>
      )}
    </ServiceCard>
  );
}

/**
 * A string-delivered credential: the same `label · quota · ⋯` row an account
 * gets, with a key's verbs in the menu.
 *
 * **Rename is new here.** `PATCH /api/credential-routes/:id` has always taken a
 * label patch and nothing in the UI ever reached it, so a key was stuck with
 * whatever `generatedLabel` called it — "Anthropic key", "Anthropic key 2" —
 * for the life of the install. A row that can be reordered but not named is
 * exactly the asymmetry req 19 is closing between the two row types.
 *
 * **No quota pill, and no sentence about the absence.** A key reports no quota
 * (req 10) and a string-delivered subscription reports none until its reader
 * lands (planning#339); either way the slot is simply empty, which is what the
 * whole column already means everywhere else.
 */
function StringCredentialRow({
  route,
  drag,
}: {
  route: CredentialRoute;
  drag?: RowDragProps | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [value, setValue] = useState("");
  /**
   * docs/257 req 5 — reorder / remove / replace failures render on the row that
   * produced them, not as a global toast.
   *
   * Reachable during onboarding, and not only afterwards: between docs/252
   * phases 2 and 3 a user can add a DeepSeek or OpenRouter key from the
   * onboarding panel and get a card whose `canRunTurns` stays false, so these
   * rows exist while the panel is still on screen.
   */
  const [error, setError] = useState("");

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/credential-routes/${route.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { routes: CredentialRoute[] };
      useSettingsStore.getState().setCredentialRoutes(data.routes);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to remove the credential");
      console.error("[services] credential delete failed:", err);
    } finally {
      setBusy(false);
    }
  };

  /** One PATCH for both verbs — the endpoint takes either field, or both. */
  const patch = async (body: { label: string } | { secret: string }): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/credential-routes/${route.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { routes: CredentialRoute[] };
      useSettingsStore.getState().setCredentialRoutes(data.routes);
      setValue("");
      setReplacing(false);
      setRenaming(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to update the credential");
      console.error("[services] credential update failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const commitRename = (): void => {
    const label = draftLabel.trim();
    // Unchanged or empty still closes the field — see the account row's
    // `saveLabel` for why: the open state must not survive a no-op save.
    if (!label || label === route.label) { setRenaming(false); return; }
    void patch({ label });
  };

  return (
    <CredentialRowShell
      testId={`credential-row-${route.id}`}
      label={route.label}
      {...(drag ? { drag } : {})}
      menuLabel={`Manage ${route.label}`}
      menu={
        <>
          <DropdownMenuItem
            onSelect={() => { setDraftLabel(route.label); setRenaming(true); }}
            data-testid={`credential-rename-${route.id}`}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setReplacing(true)}
            data-testid={`credential-replace-${route.id}`}
          >
            Replace secret
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void remove()}
            disabled={busy}
            className="text-(--color-error) hover:text-(--color-error) focus:text-(--color-error)"
            data-testid={`credential-remove-${route.id}`}
          >
            Remove
          </DropdownMenuItem>
        </>
      }
      error={
        error ? (
          <p
            className="px-1 pb-1 text-[11px] text-(--color-error)"
            role="alert"
            data-testid={`credential-error-${route.id}`}
          >
            {error}
          </p>
        ) : undefined
      }
    >
      {renaming && (
        <input
          autoFocus
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={commitRename}
          aria-label={`Name for ${route.label}`}
          className="mt-1 w-full rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-1.5 py-0.5 text-xs text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
          data-testid={`credential-rename-input-${route.id}`}
        />
      )}
      {replacing && (
        <div className="mt-1 flex gap-1">
          <input
            autoFocus
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setReplacing(false); }}
            placeholder="Paste the new key"
            aria-label={`New credential for ${route.label}`}
            className="min-w-0 flex-1 rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-1.5 py-0.5 text-xs text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
            data-testid={`credential-replace-input-${route.id}`}
          />
          <Button
            variant="secondary"
            size="sm"
            className="rounded"
            disabled={busy || !value.trim()}
            onClick={() => void patch({ secret: value })}
            data-testid={`credential-replace-submit-${route.id}`}
          >
            Save
          </Button>
        </div>
      )}
    </CredentialRowShell>
  );
}

/**
 * The add-flow: service → billing mode → credential — **the only way any
 * credential is added** (req 17).
 *
 * Step 2 exists because the two modes are **not interchangeable** (req 5): they
 * can offer different models and they bill differently, so the user picks one
 * per credential rather than discovering later which one a turn resolved to. It
 * is skipped when a service has only one mode — a one-option choice is not a
 * choice.
 *
 * **Step 3 signs the user in, here, rather than sending them somewhere to do
 * it.** For an account-backed mode it used to end with "Continue to sign in",
 * which closed the dialog and revealed an empty service card carrying an "Add
 * account" button — a hand-off inside a flow the user had already started, and
 * the source of a listed service with no credential and no way to remove it.
 * Now pressing the button creates the account and starts the login, and the
 * provider's challenge renders in this dialog: the same `AccountChallenge` the
 * account row renders, never a second copy of it (docs/150 req 16).
 *
 * **An attempt is the dialog's, and only the dialog's.** `POST
 * /api/provider-accounts` creates the account row before the login completes,
 * because the login needs something to hang on — but a row that has never
 * authenticated is not a credential, so nothing else lists it
 * ({@link isUnconnectedAttempt}). Every way out of this dialog abandons it, and
 * the panel behind never gains or loses a card while the user is still in here.
 */
function AddServiceDialog({
  initialService,
  initialMode,
  reconnectAccountId,
  agentList = [],
  onClose,
}: {
  initialService?: ServiceDef;
  initialMode?: BillingMode;
  /**
   * **Reconnect: an account that already exists, signing in again** (req 19).
   *
   * It is deliberately the ONLY thing that distinguishes a reconnect from an
   * add, because everything else it needs was already here.
   * `initialService`/`initialMode` skip steps 1 and 2, so the dialog opens on
   * step 3; `signInAccountId` already means "the account this dialog's sign-in
   * belongs to", so reconnect seeds it with an **existing** id instead of one
   * the dialog minted; and `startSignIn`'s adopt-don't-create branch then
   * cancels any stale login and starts a fresh one against it — the same call
   * an add makes after its create.
   *
   * The one consequence to state, because a test pins it: an existing account
   * is not an attempt (`isUnconnectedAttempt` is false once it has an
   * `externalId`), so **cancelling a reconnect must leave it connected and in
   * the same position**. `cancel` abandons only what this dialog created.
   */
  reconnectAccountId?: string;
  /** Only to tell whether the harness that runs a sign-in is installed. */
  agentList?: AgentOption[];
  onClose: () => void;
}) {
  const [service, setService] = useState<ServiceDef | undefined>(initialService);
  const [billingMode, setBillingMode] = useState<BillingMode | undefined>(initialMode);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [startingSignIn, setStartingSignIn] = useState(false);
  /**
   * The attempt this dialog is conducting.
   *
   * Held by id and re-read from the store on every render rather than kept as a
   * snapshot: the row's `status` is what says the sign-in finished, and it
   * arrives on the `provider_accounts` broadcast, not from the call that
   * started it. Nothing outside this dialog needs it — the panel decides what
   * to list from the accounts themselves ({@link isUnconnectedAttempt}), which
   * is what keeps the two from disagreeing for a frame.
   */
  const [signInAccountId, setSignInAccountId] = useState<string | undefined>(reconnectAccountId);
  /** The user has left. Read by `startSignIn` after every await — see `cancel`. */
  const left = useRef(false);
  /**
   * **A reconnect has actually taken effect** — the account has been observed
   * to leave `ready`.
   *
   * Needed because a reconnect starts from a *connected* account, and
   * `signedIn` below is `status === "ready"`. Without this the dialog opens on
   * "Connected. Anthropic subscription is ready" with a *Done* button, for the
   * ~50 ms until the server's `authenticating` broadcast lands: a flash of the
   * flow's LAST screen at the moment the user asked to start it again.
   *
   * Adjusted during render rather than in an effect, which is what makes it a
   * frame-exact answer instead of a frame-late one. A start that fails outright
   * leaves the account `ready` and this `false`, which is precisely the
   * `signInStalled` shape — so that path ends on *Try again*, not on a wait
   * with no end.
   */
  const [reconnectLeftReady, setReconnectLeftReady] = useState(reconnectAccountId === undefined);

  /**
   * **Choosing the mode starts its sign-in, when signing in is all the step
   * would offer** (req 18).
   *
   * Picking OpenAI → Subscription used to land on a sentence and one button
   * reading "Sign in to OpenAI": nothing to read, nothing to decide, and no
   * other way forward — the user's click had already said everything the button
   * asked. So the same click starts the login, and the step the user arrives at
   * is the one carrying the code.
   *
   * It does **not** apply to a mode that also takes a key (Anthropic's
   * subscription): there the step has a field, so starting a login the user did
   * not ask for would pre-empt a real choice.
   *
   * Nothing auto-starts that would fail on arrival — a missing harness or
   * another sign-in in flight leaves the step as it was, saying so, with the
   * button to retry once the way is clear.
   */
  const pickMode = (forService: ServiceDef, mode: BillingMode): void => {
    setBillingMode(mode);
    const provider = accountProviderFor(forService, mode);
    if (!provider || !signInIsTheWholeStep(forService, mode)) return;
    if (!(agentList.find((a) => a.id === provider)?.installed ?? true)) return;
    const known = providerAccountsOf(useSettingsStore.getState().providerAccounts, provider);
    if (signInBlockedReason(known, adoptableAttempt(known, signInAccountId)?.id)) return;
    void startSignIn(forService, mode);
  };

  const pickService = (next: ServiceDef): void => {
    setService(next);
    setError("");
    // A one-option choice is not a choice, so a single-mode service goes
    // straight to step 3 — and if that step is only a sign-in, straight into it.
    if (next.modes.length === 1) pickMode(next, next.modes[0].kind);
    else setBillingMode(undefined);
  };

  // A mode's two delivery shapes are independent, and Anthropic's subscription
  // accepts BOTH — an OAuth account and an env-supplied token. Treating "takes
  // an account" as "takes nothing else" would hide the token input; treating
  // "takes a string" as "needs no sign-in" is what left signing in unreachable
  // from this dialog. So both affordances render on their own terms.
  const acceptsString =
    service && billingMode ? !!modeCredentialFor(service.id, billingMode, "string") : false;
  const acceptsAccount =
    service && billingMode ? !!modeCredentialFor(service.id, billingMode, "account") : false;

  /** This step signs itself in (req 18) — so it owns what the footer shows. */
  const autoStarts = service && billingMode ? signInIsTheWholeStep(service, billingMode) : false;
  const signInProvider = service && billingMode ? accountProviderFor(service, billingMode) : undefined;
  // Called unconditionally, narrowed after — a hook cannot hide behind the
  // step the user has reached.
  // Attempts included: this is the one caller that is conducting one.
  const providerAccounts = useAllProviderAccounts(signInProvider ?? "claude");
  const accounts = signInProvider ? providerAccounts : [];
  const signInAccount = signInAccountId
    ? accounts.find((a) => a.id === signInAccountId)
    : undefined;
  /**
   * The sign-in finished — **read off the row, not off the call that started
   * it.** That call returns long before the user has finished on the provider's
   * page; what says it worked is the account turning `ready` on the
   * `provider_accounts` broadcast. Derived rather than watched, so the dialog
   * needs no effect and survives a reload mid-challenge exactly as the row does.
   */
  if (!reconnectLeftReady && signInAccount && signInAccount.status !== "ready") {
    setReconnectLeftReady(true);
  }
  const signedIn = signInAccount?.status === "ready" && reconnectLeftReady;
  const harnessInstalled = signInProvider
    ? (agentList.find((a) => a.id === signInProvider)?.installed ?? true)
    : true;
  const adoptable = adoptableAttempt(accounts, signInAccountId);
  /**
   * docs/150 — the provider runs ONE login process, so a second one is a 409.
   * Said here rather than after the click.
   *
   * Measured against the attempt we would **adopt**, not against
   * `signInAccountId` alone. A stranded attempt is `authenticating` and
   * invisible in the panel, so reading it as somebody else's sign-in disabled
   * the one button that could recover it: the flow refused to start, citing a
   * row the user could not see, and there was no other way to reach it. A
   * *connected* row re-authenticating still blocks, which is the case the guard
   * is actually for.
   */
  const blockedBySignIn = signInProvider ? signInBlockedReason(accounts, adoptable?.id) : undefined;
  /**
   * **An attempt that stopped without connecting** — no live challenge, not
   * ready, but this dialog's account still there.
   *
   * Two different things arrive here and both used to dead-end. A login that
   * never *started* (CLI spawn failure, a 409 race) leaves the account with no
   * challenge at all; and a challenge the provider then *rejects* clears
   * `providerAccountAuths` and files the reason under
   * `providerAccountAuthErrors`, which this dialog did not read — so
   * `AccountChallenge` rendered nothing, *Sign in* was already hidden, and the
   * only retry left was the Connect button on the card behind the modal. That
   * is precisely the hand-off req 17 deletes, rebuilt by accident on the error
   * path. Found by cross-backend review.
   *
   * **"No challenge yet" is not one of them.** The provider's code arrives on a
   * broadcast a moment after the login starts, so between the two this dialog
   * holds an `authenticating` row and nothing else — which read as stalled and
   * said "the sign-in stopped" about a sign-in that was starting normally. It
   * was a flash behind a button press before; with the sign-in starting on the
   * mode click (req 18) it would be the screen the user lands on. So a stopped
   * attempt has to have *stopped*: the requests done, and then either a reason
   * filed against it or a status that is no longer `authenticating`.
   *
   * `startingSignIn` is in the test because the row is created **before** the
   * login is asked for, and it is created `unavailable` — so between the two
   * requests the account is neither authenticating nor failed. Measured live,
   * that was a 35 ms flash of "the sign-in stopped" on the way to the code.
   *
   * The status clause is kept, rather than trusting `authError` alone, for the
   * login that dies without filing a reason: the row falls back out of
   * `authenticating`, and a stalled state with a *Try again* is the only thing
   * standing between that and a dialog waiting for a code that will never come.
   */
  const authKey = signInProvider && signInAccountId
    ? providerAccountAuthKey(signInProvider, signInAccountId)
    : undefined;
  /** Only Claude narrates; for Codex this is empty and the box just pulses. */
  const authStatus = useAuthStatus(signInProvider === "claude" ? signInAccountId : undefined);
  const pendingAuth = useSettingsStore((s) => (authKey ? s.providerAccountAuths[authKey] : undefined));
  const authError = useSettingsStore((s) => (authKey ? s.providerAccountAuthErrors[authKey] : undefined));
  const signInStalled = !!signInAccount && !signedIn && !pendingAuth && !startingSignIn
    && (!!authError || signInAccount.status !== "authenticating");

  /**
   * The `(service, mode)` are arguments rather than closure reads because
   * {@link pickMode} calls this from the very click that chose them: `service`
   * and `billingMode` are still the previous render's values there. Both
   * default to state for the ordinary caller — the button.
   */
  const startSignIn = async (
    forService = service,
    forMode = billingMode,
  ): Promise<void> => {
    const provider = forService && forMode ? accountProviderFor(forService, forMode) : undefined;
    if (!provider) return;
    // Read now, not at the last render, for the same reason.
    const known = providerAccountsOf(useSettingsStore.getState().providerAccounts, provider);
    setStartingSignIn(true);
    setError("");
    try {
      /**
       * **Adopt an attempt rather than starting a second one.** Three cases,
       * one line: this dialog's own attempt (*Try again* after a failure), an
       * attempt stranded by a reload — invisible in the panel now, and holding
       * the provider's single login slot with nothing on screen to release it —
       * and, otherwise, no attempt yet, so make one.
       */
      const existing = adoptableAttempt(known, signInAccountId);
      const account = existing ?? await createAccount(provider, known.map((a) => a.id));
      if (!account) {
        setError("Could not start the sign-in — no account was created.");
        return;
      }
      // Taken BEFORE the login starts, on purpose: the account exists from the
      // moment it is created, so learning its id only after the login had also
      // started left a failed start un-abandonable — Cancel with nothing to
      // delete, and a retry creating a second orphan each time.
      setSignInAccountId(account.id);
      /**
       * **Whoever leaves last cleans up.** `cancel` can only abandon an id it
       * has, and until the line above runs it has none — so a user who chose
       * the mode and pressed Esc while the create was still in flight closed
       * the dialog over an account that then appeared behind them: hidden by
       * `isUnconnectedAttempt`, holding the provider's login slot, with nothing
       * on screen to release it. Since the sign-in now starts on the mode click
       * (req 18), that window is no longer one the user has to be quick to hit.
       *
       * A ref rather than state, because what is being asked is "has this
       * component been left?" and the answer must not be a render behind the
       * question. Found by the independent review.
       */
      // `standDown`, not `abandonAccount`: `account` here is the row this
      // dialog will sign in, and on a reconnect that is a connected credential
      // rather than an attempt — deleting it because the user pressed Esc
      // during the round-trip would revoke it. See that function.
      if (left.current) {
        standDown(provider, account);
        return;
      }
      // An adopted attempt may still have a login running against it (the CLI
      // outlives the browser). Cancelling first is what makes the challenge
      // this dialog then shows the live one, rather than a 409.
      if (existing) await cancelAccountLogin(provider, account.id);
      if (left.current) {
        standDown(provider, account);
        return;
      }
      await startAccountLogin(provider, account.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the sign-in");
    } finally {
      setStartingSignIn(false);
    }
  };

  /**
   * **Leaving the flow before it finishes abandons it** — by *Cancel*, by Esc,
   * by the backdrop, by the close button. All four land here, so the account
   * this dialog created and the login it started both go, and nothing
   * unfinished is ever left listed (req 17).
   *
   * An earlier cut made *Cancel* abandon and a dismissal keep, reasoning that
   * the provider may already have authorised the code on screen so the card
   * should carry it to the end. Rejected by the human on the requirement it
   * contradicts: req 17 says a service the user has not finished connecting
   * does not appear, and "unless you pressed Escape" is not a clause anybody
   * would predict. Losing a live challenge is recoverable in one press; a
   * listed service nobody asked for is the bug this feature exists to remove.
   *
   * Not guarded: the component unmounting with a challenge live. It is
   * unreachable in practice — this is a modal, so the tab behind it cannot be
   * switched, and the one unmount that does happen (onboarding yielding the
   * pane) is *caused* by the account connecting, which this no-ops on. A page
   * reload is the honest exception, and no client cleanup covers that anyway:
   * the row is server-side, so it shows up on the card, where Disconnect
   * reaches it.
   */
  const cancel = (): void => {
    // Said before the stand-down, so a `startSignIn` still awaiting a response
    // sees it and cleans up after itself: between the two of them, every
    // account this dialog created is either connected or gone.
    left.current = true;
    if (signInProvider && signInAccountId && !signedIn) {
      standDown(signInProvider, signInAccount);
    }
    onClose();
  };

  const save = async (): Promise<void> => {
    if (!service || !billingMode) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/credential-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: service.id, billingMode, secret }),
      });
      const data = (await res.json()) as { routes?: CredentialRoute[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.routes) useSettingsStore.getState().setCredentialRoutes(data.routes);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the credential");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) cancel(); }}>
      <DialogContent className="max-w-md rounded-lg border-(--color-border-secondary) p-4" data-testid="add-service-dialog">
        <DialogTitle className="text-sm font-semibold">
          Add a service{service ? ` — ${service.name}` : ""}
        </DialogTitle>

        {!service && (
          <div className="mt-3 space-y-1" data-testid="add-service-step-service">
            <p className="text-[10px] uppercase tracking-wider text-(--color-text-tertiary)">
              1 · Which service
            </p>
            {allServices().map((s) => (
              <button
                key={s.id}
                onClick={() => pickService(s)}
                className="flex w-full items-center justify-between gap-3 rounded-md border border-(--color-border-secondary) px-2.5 py-2 text-left text-xs text-(--color-text-primary) hover:bg-(--color-bg-hover)"
                data-testid={`add-service-option-${s.id}`}
              >
                <span className="truncate">{s.name}</span>
                <span className="shrink-0 text-(--color-text-tertiary)">
                  {s.modes.map((m) => MODE_LABEL[m.kind]).join(" · ")}
                </span>
              </button>
            ))}
          </div>
        )}

        {service && !billingMode && (
          <div className="mt-3 space-y-1" data-testid="add-service-step-mode">
            <p className="text-[10px] uppercase tracking-wider text-(--color-text-tertiary)">
              2 · How do you pay for it
            </p>
            {service.modes.map((m) => (
              <button
                key={m.kind}
                onClick={() => pickMode(service, m.kind)}
                className="flex w-full items-center justify-between gap-3 rounded-md border border-(--color-border-secondary) px-2.5 py-2 text-left text-xs text-(--color-text-primary) hover:bg-(--color-bg-hover)"
                data-testid={`add-service-mode-${m.kind}`}
              >
                <span className="truncate">{MODE_LABEL[m.kind]}</span>
                <span className="shrink-0 text-(--color-text-tertiary)">
                  {m.models.length} model{m.models.length === 1 ? "" : "s"}
                </span>
              </button>
            ))}
            <p className="pt-1 text-[11px] text-(--color-text-tertiary)">
              These are not interchangeable: they can offer different models and they bill
              differently, so you pick one per credential.
            </p>
          </div>
        )}

        {service && billingMode && (
          <div className="mt-3 space-y-2" data-testid="add-service-step-credential">
            {/*
              The step is titled for the PRIMARY path, not for whichever shape
              happens to exist. A mode that takes an account is connected by
              signing in — that is what almost everyone does with it — so a mode
              accepting BOTH read as "3 · Paste the key" above prose explaining
              you sign in, with the key field first and *Save* as the primary
              button. Signing in leads; the string stays reachable underneath,
              since Anthropic's subscription genuinely accepts an env-supplied
              token and hiding it is what made signing in unreachable before.
            */}
            <p className="text-[10px] uppercase tracking-wider text-(--color-text-tertiary)">
              3 · {acceptsAccount ? "Sign in" : "Paste the key"}
            </p>
            {acceptsAccount && (
              <div className="space-y-2" data-testid="add-service-account-only">
                {signedIn ? (
                  <p className="text-xs text-(--color-success)" data-testid="add-service-signed-in">
                    Connected. {service.name} {MODE_LABEL[billingMode].toLowerCase()} is ready —
                    its models are selectable now.
                  </p>
                ) : signInStalled ? (
                  // The same panel again, holding the reason and the record: a
                  // failed sign-in is exactly when the CLI's own words matter,
                  // and the copy above says "copy the diagnostic details".
                  <AuthPanel>
                    <p className="text-xs text-(--color-text-error)" data-testid="add-service-signin-stalled">
                      {authError ?? "The sign-in stopped before the account connected."} Try again
                      below, or close this to add nothing.
                    </p>
                    {signInProvider === "claude" && signInAccountId && (
                      <ClaudeAuthOutput accountId={signInAccountId} />
                    )}
                  </AuthPanel>
                ) : signInAccount || startingSignIn ? (
                  <>
                    {pendingAuth && signInAccount ? (
                      // The provider's challenge, in the flow that asked for it —
                      // the same component the account row renders.
                      <AccountChallenge
                        provider={signInProvider ?? "claude"}
                        account={signInAccount}
                        serviceName={service.name}
                        onError={setError}
                      />
                    ) : (
                      /*
                        The same box the code lands in, at the same size, so
                        nothing on the step moves when it does — and it is here
                        from the step's FIRST frame, keyed off `startingSignIn`
                        rather than off the account. Keyed off the account it
                        arrived one request late, so the dialog opened short on
                        a line of prose and then grew by the height of a panel,
                        which is the jump this placeholder exists to remove.
                      */
                      /*
                        **What the sign-in is doing goes IN the box**, not in a
                        block under it: ShipIt's phase message where the link
                        will be, the CLI's latest line where the field will be,
                        and a pulse for the rest. Anthropic's wizard runs about
                        six seconds and narrates the whole way, and a pulse
                        alone reads as stuck. An earlier cut streamed three
                        lines *below* the box, which put the same output on
                        screen twice — live there, and again inside the
                        collapsed buffer the challenge already carries.
                      */
                      <ChallengePlaceholder
                        shape={signInProvider === "claude" ? "paste" : "code"}
                        {...(authStatus ? { status: authStatus } : {})}
                        testId="add-service-signin-starting"
                      >
                        {/* The buffer, collapsed, and in the same place it will
                            be a moment from now — so the panel is the whole of
                            the sign-in and the arrival of the field moves
                            nothing. */}
                        {signInProvider === "claude" && (
                          <ClaudeAuthOutput
                            // No id for the first frames — the account is still
                            // being created — and the control renders anyway,
                            // because appearing later is what grew the panel.
                            {...(signInAccountId ? { accountId: signInAccountId } : {})}
                            evenWhenEmpty
                          />
                        )}
                      </ChallengePlaceholder>
                    )}
                    <p className="text-[11px] text-(--color-text-tertiary)">
                      Keep this open until the account connects — this step will say so.
                      Closing it, however you close it, calls the sign-in off and adds nothing.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-(--color-text-secondary)">
                    {service.name}&rsquo;s {MODE_LABEL[billingMode].toLowerCase()} is connected by
                    signing in, which happens right here — ShipIt never sees your password.
                  </p>
                )}
                {!harnessInstalled && (
                  <p className="text-xs text-(--color-text-error)" data-testid="add-service-harness-missing">
                    The harness that runs this sign-in is not installed, so this subscription
                    cannot be connected on this install.
                  </p>
                )}
                {!signInAccount && blockedBySignIn && (
                  <p className="text-xs text-(--color-text-error)" data-testid="add-service-signin-blocked">
                    {blockedBySignIn}
                  </p>
                )}
              </div>
            )}
            {acceptsString && (
              <>
                {acceptsAccount && (
                  <p
                    className="pt-1 text-[10px] uppercase tracking-wider text-(--color-text-tertiary)"
                    data-testid="add-service-string-alternative"
                  >
                    Or paste a key
                  </p>
                )}
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => { setSecret(e.target.value); setError(""); }}
                  placeholder="sk-…"
                  aria-label={`${service.name} credential`}
                  className="w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5 text-xs text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
                  data-testid="add-service-secret"
                />
                <p className="text-[11px] text-(--color-text-tertiary)">
                  {modeAllowsMultipleCredentials(billingMode)
                    ? "ShipIt fails over between the credentials of one subscription when one runs out."
                    : "One key per service. Metered — no quota to report, so its card shows no usage."}
                </p>
              </>
            )}
            <div className="flex flex-wrap gap-1">
              {modelIds(service, billingMode).map((id) => (
                <span
                  key={id}
                  className="rounded bg-(--color-bg-secondary) px-1.5 py-0.5 text-[10px] text-(--color-text-tertiary)"
                >
                  {id}
                </span>
              ))}
            </div>
          </div>
        )}

        {error && (
          <p className="mt-2 text-xs text-(--color-text-error)" data-testid="add-service-error">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {/* Once the account is connected there is nothing left to call off,
              so the way out stops being "Cancel" and becomes "Done" — which is
              also the confirmation, since the flow's last screen is the one
              saying the service is ready. */}
          {signedIn ? (
            <Button
              variant="primary"
              size="md"
              className="rounded-md"
              onClick={onClose}
              data-testid="add-service-done"
            >
              Done
            </Button>
          ) : (
            <Button variant="ghost" size="md" className="rounded-md" onClick={cancel}>
              Cancel
            </Button>
          )}
          {/*
            Button order follows the same rule as the heading: the account path
            is primary wherever it exists, and *Save* steps down to secondary
            rather than disappearing — the key is still a working way to connect
            Anthropic's subscription, just not the one being recommended.

            **It appears with the field it saves, and not before.** It used to
            render from step 1 (`!billingMode || !service`), where there is
            nothing to save and it is permanently disabled — and, worse, where
            the mode is unknown, so it renders `primary` and then *animates* to
            `secondary` on arriving at a mode with an account path. Sampled per
            frame, the button is disabled the whole way through; what changes is
            its colour, blue to grey over eight frames, which reads exactly as a
            control that was available and then was taken away.
          */}
          {acceptsString && (
            <Button
              variant={acceptsAccount ? "secondary" : "primary"}
              size="md"
              className="rounded-md"
              disabled={!service || !billingMode || !secret.trim() || saving}
              onClick={() => void save()}
              data-testid="add-service-save"
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
          {/*
            **While a sign-in is under way there is one button, and it says
            Cancel** — from the click that starts it, not from the state change
            after. `startingSignIn` is in the test for that reason: the click
            turns the panel above into the waiting box immediately, and without
            this the blue button sat there for a few more frames, through the
            create request, before vanishing. Sampled per frame it is one frame
            of blue, seven of nothing, and then whatever comes next — read from
            the outside as a button that hung around after the UI had moved on
            and was then swapped for a disabled *Save*.

            The rule is uniform across the two kinds of mode. Where the flow
            starts itself (req 18) the user is watching a box fill in, and a
            second button beside it is a live control they did not ask for, in
            the one place where an accidental click restarts the login they are
            in the middle of; where the user pressed the button themselves, it
            has already done its job. Either way: nothing during the start,
            nothing during the wait, nothing while the challenge is up.

            It comes back only when nothing is happening — the attempt stopped,
            or it never started (no harness, another login in flight). The cost,
            chosen knowingly: a login that hangs at `authenticating` without ever
            sending a code offers no one-press retry, and is recovered the way
            everything else in this dialog is, by closing it and starting again.
          */}
          {acceptsAccount && !pendingAuth && !signedIn && !startingSignIn
            && (!signInAccount || signInStalled) && (
            <Button
              // Secondary only where the step signs itself in: there the button
              // is a recovery, not the way forward. Where the user must press
              // it, it is the step's own action and stays primary.
              variant={autoStarts ? "secondary" : "primary"}
              size="md"
              className="rounded-md"
              disabled={!harnessInstalled || !!blockedBySignIn}
              onClick={() => void startSignIn()}
              data-testid="add-service-sign-in"
            >
              {signInStalled ? "Try again" : `Sign in to ${service?.name ?? "the service"}`}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
