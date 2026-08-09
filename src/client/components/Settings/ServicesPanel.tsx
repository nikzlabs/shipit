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
 * Two card bodies, because credentials genuinely arrive two ways:
 *
 *   - **account-backed subscriptions** (Anthropic, OpenAI) render the existing
 *     `ProviderAccountsCard`, which owns the login flow, the account order and
 *     the routing settings. Not a new implementation of any of that;
 *   - **string-delivered credentials** — an API key, or a subscription
 *     authenticated by one (GLM's coding plan) — render below.
 *
 * An API-key card has **no routing controls at all** — not a disabled group,
 * not an empty section, and no sentence explaining the absence. Keys do not
 * fail over (req 12), so there is nothing to order and nothing to spread. The
 * asymmetry between the two card types is req 12 rendered.
 *
 * **Deliberately not welded to Settings' page chrome.** docs/257's onboarding
 * panel hosts this component as-is — same card list, same dialog, same steps —
 * so it takes no props from the Settings route and renders no dialog shell of
 * its own.
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
import { ProviderAccountsCard } from "./ProviderAccountsCard.js";

const MODE_LABEL: Record<BillingMode, string> = { sub: "Subscription", key: "API key" };

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
   */
  const [revealed, setRevealed] = useState<string[]>([]);

  const configured = catalogueModes().filter(({ service, billingMode }) => {
    const provider = accountProviderFor(service, billingMode);
    return routes.some((r) => r.serviceId === service.id && r.billingMode === billingMode && r.via === "string")
      || (provider !== undefined && accounts.some((a) => a.provider === provider))
      || revealed.includes(credentialModeKey(service.id, billingMode));
  });

  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full" data-testid="services-panel">
      <div>
        <h3 className="text-sm font-medium text-(--color-text-primary)">Services</h3>
        <p className="mt-0.5 text-xs text-(--color-text-tertiary)">
          ShipIt defines the services; you supply the credential. A model is offered once the
          billing mode that carries it has one.
        </p>
      </div>

      {configured.length === 0 ? (
        <div
          className="rounded-md border border-dashed border-(--color-border-secondary) p-6 text-center"
          data-testid="services-empty"
        >
          <p className="text-sm text-(--color-text-secondary)">No services yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-(--color-text-tertiary)">
            Add one to start. ShipIt ships with first-party providers, direct providers and
            gateways.
          </p>
          <Button
            variant="primary"
            size="md"
            className="mt-3 rounded-md"
            onClick={() => setAddOpen(true)}
            data-testid="services-add-empty"
          >
            Add a service
          </Button>
        </div>
      ) : (
        <>
          {configured.map(({ service, billingMode }) => (
            <ServiceModeCard
              key={credentialModeKey(service.id, billingMode)}
              service={service}
              billingMode={billingMode}
              routes={routes.filter(
                (r) => r.serviceId === service.id && r.billingMode === billingMode,
              )}
              agentList={agentList}
            />
          ))}
          <div>
            <Button
              variant="secondary"
              size="md"
              className="rounded-md"
              onClick={() => setAddOpen(true)}
              data-testid="services-add"
            >
              <PlusIcon size={ICON_SIZE.XS} /> Add a service
            </Button>
          </div>
        </>
      )}

      {addOpen && (
        <AddServiceDialog
          onClose={() => setAddOpen(false)}
          onReveal={(modeKey) => setRevealed((current) =>
            current.includes(modeKey) ? current : [...current, modeKey])}
        />
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
  const stringRoutes = routes.filter((r) => r.via === "string");
  const multiple = modeAllowsMultipleCredentials(billingMode);
  return (
    <>
    {/* The docs/150 accounts card, whole: the login flow, the fallback order
        and the routing settings all live there and are not reimplemented here.
        `showApiKeyFallback={false}` because that same credential is this
        service's `(key)` card, one row down. */}
    {provider && (
      <ProviderAccountsCard
        provider={provider}
        agent={agentList.find((a) => a.id === provider)}
        showApiKeyFallback={false}
      />
    )}
    {stringRoutes.length > 0 && (
    <div
      className="rounded-md border border-(--color-border-secondary) p-3 space-y-3"
      data-testid={`service-card-${credentialModeKey(service.id, billingMode)}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-(--color-text-primary)">{service.name}</h3>
            <span className="rounded border border-(--color-border-secondary) px-1.5 py-0.5 text-[10px] text-(--color-text-tertiary)">
              {MODE_LABEL[billingMode]}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-(--color-text-tertiary)">
            {billingMode === "key"
              ? "Metered — no quota to report, so this card shows no usage."
              : "A plan, authenticated by a supplied key."}
          </p>
        </div>
        {multiple && (
          <AddCredentialButton service={service} billingMode={billingMode} />
        )}
      </div>

      <div className="space-y-1.5">
        {stringRoutes.map((route, index) => (
          <CredentialRow
            key={route.id}
            route={route}
            order={
              // req 2's fallback order, and in phase 2 it is not cosmetic: the
              // FIRST credential of a group is the one delivered, so moving a
              // row changes which key sessions receive.
              multiple && stringRoutes.length > 1
                ? { index, total: stringRoutes.length, ids: stringRoutes.map((r) => r.id) }
                : undefined
            }
          />
        ))}
      </div>

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
    </>
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

  const move = async (delta: number): Promise<void> => {
    if (!order) return;
    const next = [...order.ids];
    const to = order.index + delta;
    if (to < 0 || to >= next.length) return;
    [next[order.index], next[to]] = [next[to], next[order.index]];
    setBusy(true);
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
      useUiStore.getState().setToast({ message: "Failed to reorder the credentials" });
      console.error("[services] credential reorder failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/credential-routes/${route.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { routes: CredentialRoute[] };
      useSettingsStore.getState().setCredentialRoutes(data.routes);
    } catch (err) {
      useUiStore.getState().setToast({ message: "Failed to remove the credential" });
      console.error("[services] credential delete failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const replace = async (): Promise<void> => {
    if (!value.trim()) return;
    setBusy(true);
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
      useUiStore.getState().setToast({ message: "Failed to update the credential" });
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
            <p className="text-[10px] uppercase tracking-wider text-(--color-text-tertiary)">
              3 · {acceptsString ? "Paste the key" : "Sign in"}
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
          {acceptsAccount && (
            <Button
              variant={acceptsString ? "secondary" : "primary"}
              size="md"
              className="rounded-md"
              onClick={revealAccountCard}
              data-testid="add-service-continue"
            >
              Continue to sign in
            </Button>
          )}
          {(acceptsString || !billingMode || !service) && (
            <Button
              variant="primary"
              size="md"
              className="rounded-md"
              disabled={!service || !billingMode || !secret.trim() || saving}
              onClick={() => void save()}
              data-testid="add-service-save"
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
