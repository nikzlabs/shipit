/**
 * docs/252 — the **one** card Settings → Services is built from.
 *
 * Before this, the list rendered two different things: string-delivered
 * credentials got a bordered card with a service name and a billing-mode pill,
 * while an account-backed subscription (Anthropic, OpenAI) got a bare,
 * borderless `ProviderAccountsCard` sitting *outside* the card list and titled
 * after the *harness* vendor ("Claude subscriptions"). Two components, two
 * visual languages, one list — which is what read as "elements from the old
 * system and from the new system".
 *
 * So the chrome lives here and nowhere else, and both bodies are children of
 * it. The card is deliberately dumb: it owns the border, the header (avatar,
 * service name, billing-mode pill, credential count, one action), the model
 * chips and the shaded routing band, and it owns no credential logic at all.
 * Which rows go inside, and what the routing band contains, is the caller's.
 *
 * The header names the **service** (`Anthropic`), never the harness that
 * happens to drive it (`Claude`). A credential belongs to a service; the
 * harness is a separate axis this feature exists to stop conflating with it.
 */

import type { ReactNode } from "react";
import { Badge } from "../ui/badge.js";
import type { BillingMode, ServiceDef } from "../../../server/shared/catalogue/index.js";

export const MODE_LABEL: Record<BillingMode, string> = { sub: "Subscription", key: "API key" };

/**
 * The avatar. An initial rather than a vendor logo: the catalogue carries no
 * artwork, and a letter is honest about that while still giving the eye a fixed
 * left edge to scan down. Derived from the service name so a new catalogue row
 * needs no asset.
 */
function ServiceAvatar({ service }: { service: ServiceDef }) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) text-xs font-semibold text-(--color-text-secondary)"
      aria-hidden="true"
      data-testid={`service-avatar-${service.id}`}
    >
      {service.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ServiceCard({
  service,
  billingMode,
  credentialCount,
  countNoun,
  description,
  action,
  models,
  routing,
  routingTitle,
  children,
  testId,
}: {
  service: ServiceDef;
  billingMode: BillingMode;
  /**
   * How many credentials this `(service, mode)` holds. Rendered as a pill only
   * past one — "1 account" is a count nobody needed counting.
   */
  credentialCount: number;
  /** "account" for a login-backed mode, "credential" for a supplied secret. */
  countNoun: string;
  description: string;
  /** The single header action — "Add account", "Add another". */
  action?: ReactNode;
  models: string[];
  /**
   * The shaded band under the body. Given a heading rather than left inline
   * because these controls answer a different question from the rows above
   * them ("which of these next?" vs "which do I have?"), and inline radios
   * between the rows and the chips read as neither.
   */
  routing?: ReactNode;
  routingTitle?: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div
      // `shrink-0` is load-bearing, not decoration. The panel is a
      // `flex-col h-full overflow-y-auto`, and `overflow-hidden` — which is what
      // clips the routing band into the rounded corners — resets this card's
      // `min-height: auto` to 0, so without it every card collapses to a bare
      // 1px line under the column's height constraint.
      className="shrink-0 overflow-hidden rounded-md border border-(--color-border-secondary)"
      data-testid={testId}
    >
      <div className="space-y-3 p-3">
        <div className="flex items-start gap-3">
          <ServiceAvatar service={service} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium text-(--color-text-primary)">{service.name}</h3>
              <Badge
                className={
                  billingMode === "sub"
                    ? "px-1.5 text-[10px] bg-(--color-accent-subtle) text-(--color-accent)"
                    : "px-1.5 text-[10px]"
                }
                variant={billingMode === "sub" ? "default" : "success"}
                data-testid={`service-mode-pill-${testId}`}
              >
                {MODE_LABEL[billingMode]}
              </Badge>
              {credentialCount > 1 && (
                <Badge className="px-1.5 text-[10px]" data-testid={`service-count-pill-${testId}`}>
                  {credentialCount} {countNoun}s
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-(--color-text-tertiary)">{description}</p>
          </div>
          {action}
        </div>

        {children}

        {models.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {models.map((id) => (
              <span
                key={id}
                className="rounded border border-(--color-border-secondary) bg-(--color-bg-secondary) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-tertiary)"
              >
                {id}
              </span>
            ))}
          </div>
        )}
      </div>

      {routing && (
        <div
          className="border-t border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-3"
          data-testid={`service-routing-${testId}`}
        >
          {routingTitle && (
            <p className="mb-2 text-[10px] uppercase tracking-wider text-(--color-text-tertiary)">
              {routingTitle}
            </p>
          )}
          {routing}
        </div>
      )}
    </div>
  );
}

/**
 * The subscription card with exactly one credential.
 *
 * Kept, where the API-key card's "no failover here" sentence was cut, because
 * the two absences are not the same absence: a key card can *never* route, so
 * explaining it is noise repeated once per key service, while this one names a
 * capability the user can reach by doing one thing. It sits in the routing slot
 * so the band is where routing always is, present or not.
 */
export function NothingToRouteYet({ noun }: { noun: string }) {
  return (
    <p className="text-xs text-(--color-text-tertiary)" data-testid="service-routing-empty">
      One {noun} — nothing to route between yet. Add a second to choose an order and a strategy.
    </p>
  );
}
