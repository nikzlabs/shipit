import { Badge } from "./ui/badge.js";
import type { BillingMode } from "../../server/shared/catalogue/index.js";

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
      variant={billingMode === "sub" ? "default" : "success"}
      className={`px-1.5 text-[10px] normal-case tracking-normal ${
        billingMode === "sub" ? "bg-(--color-accent-subtle) text-(--color-accent) " : ""
      }${className}`}
      {...rest}
    >
      {MODE_LABEL[billingMode]}
    </Badge>
  );
}
