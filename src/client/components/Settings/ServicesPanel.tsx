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

import { useState } from "react";
import { CaretDownIcon, CaretUpIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
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
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { AddAccountButton, ProviderAccountRows, useProviderAccounts } from "./ProviderAccountRows.js";
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

export function ServicesPanel({ agentList = [] }: { agentList?: AgentOption[] }) {
  const routes = useSettingsStore((s) => s.credentialRoutes);
  const accounts = useSettingsStore((s) => s.providerAccounts);
  const notices = useSettingsStore((s) => s.providerAccountNotices);
  const [addOpen, setAddOpen] = useState(false);
  /**
   * Modes the user picked in the dialog that have no credential yet.
   *
   * An account-backed subscription cannot be connected by pasting anything —
   * it needs a login, which `ProviderAccountsCard` owns. Without this the
   * dialog was a dead end: picking OpenAI → Subscription told the user to press
   * "Add account on its card" while no such card existed, because a card only
   * appeared once an account already did. Revealing the card is the handoff,
   * and it keeps the screen's "only what you configured" property for everyone
   * who has not asked for it.
   *
   * It lives in the UI store rather than here because Settings renders its tabs
   * through Radix `TabsContent`, which UNMOUNTS the inactive one: as component
   * state the reveal was lost by switching to any other Settings tab and back,
   * and the only route back to "Add account" was to walk the whole add-flow
   * again. `settingsTab` sits in the same store for the same reason.
   */
  const revealed = useUiStore((s) => s.revealedServiceModes);

  /**
   * docs/257 req 5 — a card with something to say stays on screen.
   *
   * Without this clause, disconnecting the LAST account of a service removed
   * the account and this filter dropped the card in the same commit — so the
   * result of that disconnect ("N sessions have no connected account") was
   * mounted and unmounted together and the user never saw which sessions the
   * removal had stranded. Found by cross-backend review; the notice being in
   * the store rather than in the card's own state is what makes rendering it
   * again possible at all.
   */
  const configured = catalogueModes().filter(({ service, billingMode }) => {
    const provider = accountProviderFor(service, billingMode);
    return routes.some((r) => r.serviceId === service.id && r.billingMode === billingMode && r.via === "string")
      || (provider !== undefined
        && accounts.some((a) => a.serviceId === service.id && a.billingMode === billingMode))
      || (provider !== undefined && notices[provider] !== undefined)
      || revealed.includes(credentialModeKey(service.id, billingMode));
  });

  const cards = configured.map(({ service, billingMode }) => (
    <ServiceModeCard
      key={credentialModeKey(service.id, billingMode)}
      service={service}
      billingMode={billingMode}
      routes={routes.filter((r) => r.serviceId === service.id && r.billingMode === billingMode)}
      agentList={agentList}
    />
  ));

  const dialog = addOpen && (
    <AddServiceDialog
      onClose={() => setAddOpen(false)}
      onReveal={(modeKey) => useUiStore.getState().revealServiceMode(modeKey)}
    />
  );

  // The heading and the button share one row, and "nothing configured" is the
  // caption under that heading rather than a box of its own: empty, the whole
  // panel is two lines and a button.
  const empty = configured.length === 0;

  return (
    <div className="flex flex-col gap-3" data-testid="services-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-(--color-text-primary)">Services</h3>
          <p
            className="mt-0.5 text-xs text-(--color-text-tertiary)"
            // The empty state keeps its own test id, because "nothing
            // configured" is still a distinct state — it is just said in a line
            // now instead of a dashed box.
            {...(empty ? { "data-testid": "services-empty" } : {})}
          >
            {empty
              ? "Connect one to start — a subscription you already pay for, or an API key."
              : "ShipIt defines the services; you supply the credential."}
          </p>
        </div>
        <Button
          variant={empty ? "primary" : "secondary"}
          // The standard height, not `sm`: this is the panel's one action, and
          // the row it sits in is compact enough without shrinking the target.
          size="md"
          className="rounded-md shrink-0"
          onClick={() => setAddOpen(true)}
          data-testid={empty ? "services-add-empty" : "services-add"}
        >
          <PlusIcon size={ICON_SIZE.XS} /> Add a service
        </Button>
      </div>

      {cards}
      <InstalledHarnesses agentList={agentList} />
      {dialog}
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
}: {
  service: ServiceDef;
  billingMode: BillingMode;
  routes: CredentialRoute[];
  agentList: AgentOption[];
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
   */
  const mixedDelivery = provider !== undefined && stringRoutes.length > 0;
  /**
   * What one credential of this mode *is*, in the user's words. An
   * account-backed subscription has accounts; everything else has credentials,
   * and calling a pasted key an "account" is the conflation this whole feature
   * removes. A mixed card holds both, so it says the wider word.
   */
  const noun = provider && !mixedDelivery ? "account" : "credential";
  /** The credentials the routing controls actually route between. */
  const routedCredentials = provider ? accounts : stringRoutes;
  const routedNoun = provider ? "account" : "credential";

  // req 12 — `key` is single-credential by definition, so an API-key card gets
  // no routing band at all: not a disabled group, not an empty section, and no
  // sentence explaining the absence.
  const routing = !multiple ? undefined : routedCredentials.length > 1 ? (
    <>
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
    </>
  ) : routedCredentials.length === 1 ? (
    // Exactly one, never zero: with none connected the card is already asking
    // for the first one, and "nothing to route between yet" under that ask
    // states the obvious twice.
    <NothingToRouteYet noun={routedNoun} />
  ) : undefined;

  return (
    <ServiceCard
      service={service}
      billingMode={billingMode}
      credentialCount={credentialCount}
      countNoun={noun}
      description={
        provider
          ? "Connect one or more subscriptions. ShipIt fails over between them when one runs out."
          : billingMode === "key"
            ? "Metered — no quota to report, so this card shows no usage."
            : "A plan, authenticated by a supplied key."
      }
      action={
        provider ? (
          <AddAccountButton provider={provider} agent={agentList.find((a) => a.id === provider)} />
        ) : multiple ? (
          <AddCredentialButton service={service} billingMode={billingMode} />
        ) : undefined
      }
      models={modelIds(service, billingMode)}
      routing={routing}
      routingTitle={
        routedCredentials.length > 1 ? `How ShipIt picks between these ${routedNoun}s` : undefined
      }
      testId={`service-card-${credentialModeKey(service.id, billingMode)}`}
    >
      {/* The docs/150 account rows, whole: the login flow and the fallback
          order live there and are not reimplemented here. */}
      {provider && (
        <ProviderAccountRows
          provider={provider}
          agent={agentList.find((a) => a.id === provider)}
        />
      )}
      {stringRoutes.length > 0 && (
        <div className="space-y-1.5">
          {mixedDelivery && (
            <p
              className="text-xs text-(--color-text-tertiary)"
              data-testid={`service-string-fallback-${credentialModeKey(service.id, billingMode)}`}
            >
              Supplied by an environment variable, and used only while no account above is
              connected — ShipIt does not move onto it when the accounts run out.
            </p>
          )}
          {stringRoutes.map((route, index) => (
            <CredentialRow
              key={route.id}
              route={route}
              order={
                // req 2's fallback order, and it is not cosmetic: the FIRST
                // credential of a group is the one delivered, so moving a row
                // changes which key sessions receive.
                //
                // Never offered on a mixed card: the reorder endpoint requires
                // EVERY route of the `(service, mode)` exactly once
                // (`reorderCredentialRoutes`), and the account rows are in that
                // set — so a list of just these ids is a 400. There is nothing
                // to order anyway, since the env token is not in the accounts'
                // failover chain.
                multiple && !mixedDelivery && stringRoutes.length > 1
                  ? { index, total: stringRoutes.length, ids: stringRoutes.map((r) => r.id) }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </ServiceCard>
  );
}

interface RowOrder {
  index: number;
  total: number;
  /** Every id in the group, in current order — the reorder endpoint takes the complete set. */
  ids: string[];
}

function CredentialRow({ route, order }: { route: CredentialRoute; order?: RowOrder }) {
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
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

  const move = async (delta: number): Promise<void> => {
    if (!order) return;
    const next = [...order.ids];
    const to = order.index + delta;
    if (to < 0 || to >= next.length) return;
    [next[order.index], next[to]] = [next[to], next[order.index]];
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/credential-routes/${route.serviceId}/${route.billingMode}/order`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeIds: next }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { routes: CredentialRoute[] };
      useSettingsStore.getState().setCredentialRoutes(data.routes);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to reorder the credentials");
      console.error("[services] credential reorder failed:", err);
    } finally {
      setBusy(false);
    }
  };

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

  const replace = async (): Promise<void> => {
    if (!value.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/credential-routes/${route.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { routes: CredentialRoute[] };
      useSettingsStore.getState().setCredentialRoutes(data.routes);
      setValue("");
      setReplacing(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to update the credential");
      console.error("[services] credential update failed:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-2"
      data-testid={`credential-row-${route.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          {order && (
            <span className="flex items-center gap-0.5" data-testid={`credential-order-${route.id}`}>
              <button
                onClick={() => void move(-1)}
                disabled={busy || order.index === 0}
                aria-label={`Move ${route.label} earlier in the fallback order`}
                className="rounded px-1 py-0.5 text-[11px] text-(--color-text-secondary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:hover:bg-transparent"
                data-testid={`credential-move-up-${route.id}`}
              >
                <CaretUpIcon size={ICON_SIZE.XS} />
              </button>
              <button
                onClick={() => void move(1)}
                disabled={busy || order.index === order.total - 1}
                aria-label={`Move ${route.label} later in the fallback order`}
                className="rounded px-1 py-0.5 text-[11px] text-(--color-text-secondary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:hover:bg-transparent"
                data-testid={`credential-move-down-${route.id}`}
              >
                <CaretDownIcon size={ICON_SIZE.XS} />
              </button>
            </span>
          )}
          <span className="truncate text-xs text-(--color-text-primary)">{route.label}</span>
          {order && route.isPrimary && (
            <span className="rounded bg-(--color-bg-primary) px-1 py-0.5 text-[10px] text-(--color-text-tertiary)">
              Primary
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={() => setReplacing((v) => !v)}
            className="rounded px-1.5 py-0.5 text-[11px] text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
            data-testid={`credential-replace-${route.id}`}
          >
            Replace
          </button>
          <button
            onClick={() => void remove()}
            disabled={busy}
            aria-label={`Remove ${route.label}`}
            className="rounded px-1.5 py-0.5 text-[11px] text-(--color-text-secondary) hover:bg-(--color-bg-hover) disabled:opacity-40"
            data-testid={`credential-remove-${route.id}`}
          >
            <TrashIcon size={ICON_SIZE.XS} />
          </button>
        </div>
      </div>
      {error && (
        <p
          className="mt-2 text-xs text-(--color-text-error)"
          role="alert"
          data-testid={`credential-error-${route.id}`}
        >
          {error}
        </p>
      )}
      {replacing && (
        <div className="mt-2 flex gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste the new key"
            aria-label={`New credential for ${route.label}`}
            className="flex-1 rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1 text-xs text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none"
            data-testid={`credential-replace-input-${route.id}`}
          />
          <Button
            variant="secondary"
            size="sm"
            className="rounded-md"
            disabled={busy || !value.trim()}
            onClick={() => void replace()}
            data-testid={`credential-replace-submit-${route.id}`}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Add another" for a subscription that can hold several credentials (req 12). */
function AddCredentialButton({
  service,
  billingMode,
}: {
  service: ServiceDef;
  billingMode: BillingMode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="rounded-md shrink-0"
        onClick={() => setOpen(true)}
        data-testid={`service-add-credential-${credentialModeKey(service.id, billingMode)}`}
      >
        Add another
      </Button>
      {open && (
        <AddServiceDialog
          initialService={service}
          initialMode={billingMode}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The add-flow: service → billing mode → credential.
 *
 * Step 2 exists because the two modes are **not interchangeable** (req 5): they
 * can offer different models and they bill differently, so the user picks one
 * per credential rather than discovering later which one a turn resolved to. It
 * is skipped when a service has only one mode — a one-option choice is not a
 * choice.
 */
function AddServiceDialog({
  initialService,
  initialMode,
  onClose,
  onReveal,
}: {
  initialService?: ServiceDef;
  initialMode?: BillingMode;
  onClose: () => void;
  /**
   * Hand off to the accounts card for a mode that is connected by signing in
   * rather than by pasting a secret. Absent from the "Add another" entry point,
   * which is only ever opened on a card that already exists.
   */
  onReveal?: (modeKey: string) => void;
}) {
  const [service, setService] = useState<ServiceDef | undefined>(initialService);
  const [billingMode, setBillingMode] = useState<BillingMode | undefined>(initialMode);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const pickService = (next: ServiceDef): void => {
    setService(next);
    setBillingMode(next.modes.length === 1 ? next.modes[0].kind : undefined);
    setError("");
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

  const revealAccountCard = (): void => {
    if (!service || !billingMode) return;
    onReveal?.(credentialModeKey(service.id, billingMode));
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
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
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
                onClick={() => setBillingMode(m.kind)}
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
              <p className="text-xs text-(--color-text-secondary)" data-testid="add-service-account-only">
                {service.name}&rsquo;s {MODE_LABEL[billingMode].toLowerCase()} can be connected by
                signing in. <b>Continue</b> opens its card, where <b>Add account</b> starts the login
                — ShipIt never sees your password.
              </p>
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
          <Button variant="ghost" size="md" className="rounded-md" onClick={onClose}>
            Cancel
          </Button>
          {/*
            Button order follows the same rule as the heading: the account path
            is primary wherever it exists, and *Save* steps down to secondary
            rather than disappearing — the key is still a working way to connect
            Anthropic's subscription, just not the one being recommended.
          */}
          {(acceptsString || !billingMode || !service) && (
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
          {acceptsAccount && (
            <Button
              variant="primary"
              size="md"
              className="rounded-md"
              onClick={revealAccountCard}
              data-testid="add-service-continue"
            >
              Continue to sign in
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
