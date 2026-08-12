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
 * service name, billing-mode pill, credential count), the model chips and the
 * shaded routing band, and it owns no credential logic at all. Which rows go
 * inside, and what the routing band contains, is the caller's.
 *
 * **It has no header action.** It carried one — "Add account" on an
 * account-backed card, "Add another" on a key one — until docs/252 req 17 made
 * the panel's "Add a service" the single way in. What is left is a card that
 * shows and manages what exists.
 *
 * The header names the **service** (`Anthropic`), never the harness that
 * happens to drive it (`Claude`). A credential belongs to a service; the
 * harness is a separate axis this feature exists to stop conflating with it.
 *
 * **One header line and the credentials — nothing else** (docs/252 req 19).
 * Measured at 470px, the Anthropic subscription card was 272px holding 39px of
 * credential, and the DeepSeek key card 148px holding the same 39px. What filled
 * the rest was a description sentence, an account empty-state box, a sentence
 * about environment variables and a row of model-id chips that grows with the
 * catalogue — none of it saying anything about *this* install. Two of those are
 * deleted at the caller; the two this component owned are gone from here:
 *
 * - The `description` prop. "Connect one or more subscriptions. ShipIt fails
 *   over between them when one runs out." is stated by the routing band, which
 *   appears exactly when there is something to route between; "Metered — no
 *   quota to report" is the **API key** pill, one control to the left.
 * - The chip row, which is **moved rather than deleted**: it becomes the
 *   `N models` control in the top-right corner, naming them on hover.
 */

import type { ReactNode } from "react";
import { Badge } from "../ui/badge.js";
import { WithTooltip } from "../ui/tooltip.js";
import { BillingModePill, MODE_LABEL } from "../BillingModePill.js";
import type { BillingMode, ServiceDef } from "../../../server/shared/catalogue/index.js";

// The label and the pill are shared with the composer's model menu, which makes
// the same statement about the same pair. Re-exported because this module was
// where both used to live.
export { MODE_LABEL };

/**
 * The avatar. An initial rather than a vendor logo: the catalogue carries no
 * artwork, and a letter is honest about that while still giving the eye a fixed
 * left edge to scan down. Derived from the service name so a new catalogue row
 * needs no asset.
 */
function ServiceAvatar({ service }: { service: ServiceDef }) {
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-(--color-border-secondary) bg-(--color-bg-secondary) text-[10px] font-semibold text-(--color-text-secondary)"
      aria-hidden="true"
      data-testid={`service-avatar-${service.id}`}
    >
      {service.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * **The model list, reachable without occupying the card** (docs/252 req 19,
 * the human's own placement: "a 'models' chip or icon, maybe on the right top
 * corner").
 *
 * The ids were a wrapped row of monospace chips under the credentials — the one
 * element on the card that grows with ShipIt's catalogue rather than with the
 * user's setup, so an eight-model service spent three lines saying something
 * the user reads once and then never again. The count is what is worth a
 * glance; the names are worth a hover.
 *
 * A `<button>` rather than a `<span>`, and not because it does anything: a
 * tooltip must open on keyboard focus as well as on hover, and only a focusable
 * element can be tabbed to. `type="button"` keeps it out of any enclosing form.
 */
function ModelsControl({ models, testId }: { models: string[]; testId: string }) {
  return (
    <WithTooltip
      side="left"
      label={
        <span className="flex max-w-56 flex-col gap-0.5 font-mono text-[10px]">
          {models.map((id) => <span key={id}>{id}</span>)}
        </span>
      }
    >
      <button
        type="button"
        className="shrink-0 cursor-default rounded px-1 py-0.5 text-[10px] text-(--color-text-tertiary) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary) focus:outline-none focus-visible:bg-(--color-bg-hover)"
        data-testid={`service-models-${testId}`}
      >
        {models.length} model{models.length === 1 ? "" : "s"}
      </button>
    </WithTooltip>
  );
}

export function ServiceCard({
  service,
  billingMode,
  credentialCount,
  countNoun,
  models,
  routing,
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
  models: string[];
  /**
   * The shaded band under the body.
   *
   * It lost its `routingTitle` with the compaction, and the string did not go
   * with it: "How ShipIt picks between these accounts" is now the segmented
   * control's own accessible name (`role="radiogroup"`, in `CredentialRouting`)
   * rather than a line of uppercase above it. It is deliberately **not** a
   * tooltip — a tooltip needs a hoverable trigger of its own, the two segments
   * fill the group's box, so every hover would land on a segment and the
   * group's tooltip would either never open or fight the one that does.
   */
  routing?: ReactNode;
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
      <div className="space-y-1.5 p-2">
        {/* One line: avatar, name, mode, count — and the models control pinned
            to the far corner, which is the only thing on the card that is about
            ShipIt's catalogue rather than about the user's setup. */}
        <div className="flex items-center gap-2">
          <ServiceAvatar service={service} />
          <h3 className="truncate text-xs font-medium text-(--color-text-primary)">{service.name}</h3>
          <BillingModePill
            billingMode={billingMode}
            data-testid={`service-mode-pill-${testId}`}
          />
          {credentialCount > 1 && (
            <Badge className="px-1.5 text-[10px]" data-testid={`service-count-pill-${testId}`}>
              {credentialCount} {countNoun}s
            </Badge>
          )}
          <span className="flex-1" />
          {models.length > 0 && <ModelsControl models={models} testId={testId} />}
        </div>

        {children}
      </div>

      {routing && (
        <div
          className="border-t border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5"
          data-testid={`service-routing-${testId}`}
        >
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
