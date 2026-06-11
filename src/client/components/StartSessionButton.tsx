/**
 * The "Start session" call-to-action shared by the Issues list rows and the
 * inline issue detail footer (docs/170). Both seed a ShipIt session from an
 * issue, so they share one button: the `cta` Button variant (a subtle accent
 * tint that fills to solid on hover — calm enough to repeat on every list row)
 * plus a rocket that lifts off on hover. Centralized so the treatment can't
 * drift between the two surfaces.
 *
 * Sized with the standard `md` (32px) so it lines up with every other text
 * button in the app — no bespoke height override anymore. Only the `cta`
 * variant and the rocket animation are particular to this button.
 */

import type { MouseEvent } from "react";
import { RocketLaunchIcon } from "@phosphor-icons/react";
import { Button } from "./ui/button.js";
import { cn } from "../utils/cn.js";

export function StartSessionButton({
  label = "Start session",
  disabled,
  title,
  onClick,
  className,
}: {
  /** Button text — the detail footer uses a longer "…from this issue" form. */
  label?: string;
  disabled?: boolean;
  title?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Layout-only classes from the call site (e.g. row width / grid placement). */
  className?: string;
}) {
  return (
    <Button
      variant="cta"
      // Standard `md` height (32px) so this lines up with every other text
      // button. In the Issues list the action cell centers the button on the
      // row's first-line baseline regardless of its height, so it still aligns.
      size="md"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn("group/ss", className)}
    >
      <RocketLaunchIcon
        size={16}
        className="transition-transform duration-200 ease-out group-hover/ss:-translate-y-0.5 group-hover/ss:translate-x-0.5"
      />
      {label}
    </Button>
  );
}
