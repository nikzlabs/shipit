import { Badge } from "./ui/badge.js";
import type { BillingMode } from "../../server/shared/catalogue/index.js";

/**
 * docs/252 — how a `(service, billing mode)` pair names its mode, everywhere.
 *
 * The mockups render the mode as a coloured pill (purple `Subscription`, green
 * `API key`) in both Settings and the composer's model menu, and the two are the
 * same statement about the same thing: which credential is paying. They were
 * built twice — a `Badge` on the service card, plain tertiary text in the picker
 * — so the shipped picker read as an afterthought beside the card. One component
 * is what keeps them from drifting again.
 */
export const MODE_LABEL: Record<BillingMode, string> = { sub: "Subscription", key: "API key" };

export function BillingModePill({
  billingMode,
  className = "",
  ...rest
}: {
  billingMode: BillingMode;
  className?: string;
} & Omit<React.ComponentProps<typeof Badge>, "variant" | "children">) {
  return (
    <Badge
      // `default` is the neutral grey badge, so the subscription pill overrides
      // it onto the accent tint — the mock's purple — while `success` already
      // carries the green the key pill wants.
      variant={billingMode === "sub" ? "default" : "success"}
      // `normal-case tracking-normal` is load-bearing, not tidiness: the model
      // menu nests this inside `DropdownMenuLabel`, whose base style is
      // `uppercase tracking-wider`. Without the reset the same pill reads
      // "SUBSCRIPTION" in the menu and "Subscription" on the card — the exact
      // drift this component exists to prevent. It belongs here rather than at
      // the call site so reuse stays context-independent.
      className={`px-1.5 text-[10px] normal-case tracking-normal ${
        billingMode === "sub" ? "bg-(--color-accent-subtle) text-(--color-accent) " : ""
      }${className}`}
      {...rest}
    >
      {MODE_LABEL[billingMode]}
    </Badge>
  );
}
