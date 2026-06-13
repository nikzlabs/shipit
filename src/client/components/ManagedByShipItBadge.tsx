import { ShieldCheckIcon } from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { ICON_SIZE } from "../design-tokens.js";

/**
 * Marks a first-party integration whose credentials ShipIt brokers — they
 * never enter the session container (GitHub, Linear). The visible cue for the
 * security-model difference vs. user-configured MCP servers, which carry the
 * credentials you give them into the box (docs/201).
 */
export function ManagedByShipItBadge() {
  return (
    <Badge variant="info" className="gap-1 whitespace-nowrap">
      <ShieldCheckIcon size={ICON_SIZE.XS} weight="fill" />
      Managed by ShipIt
    </Badge>
  );
}
