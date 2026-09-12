import { ShieldCheckIcon } from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { ICON_SIZE } from "../design-tokens.js";

export function ManagedByShipItBadge() {
  return (
    <Badge variant="info" className="gap-1 whitespace-nowrap">
      <ShieldCheckIcon size={ICON_SIZE.XS} weight="fill" />
      Managed by ShipIt
    </Badge>
  );
}
