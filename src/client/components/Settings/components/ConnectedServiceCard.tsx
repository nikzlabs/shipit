/**
 * The shell both brokered connections render into: a brand mark, the declared
 * words, the *Managed by ShipIt* badge, and whatever the connection itself has
 * to say beneath them.
 *
 * It is presentation and nothing else — no store, no fetch, no key of its own.
 * The two cards it serves differ in what a connection MEANS (an account, a set
 * of reachable teams) and in the route that stores the credential; the frame
 * around that was the same twice.
 *
 * The label and the description are the DECLARATION's, marked so the coverage
 * walk compares them against it — a card that wrote its own words is exactly
 * what docs/308-data-driven-settings removes.
 */

import type { ReactNode } from "react";
import { StatusDot } from "../../ui/status-dot.js";
import { ManagedByShipItBadge } from "../../ManagedByShipItBadge.js";
import { settingCopy } from "../setting-copy.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

export function ConnectedServiceCard({
  settingKey,
  mark,
  headerAction,
  children,
  testId,
}: {
  settingKey: SettingKey;
  /** The service's brand glyph. The tile around it belongs to the card. */
  mark: ReactNode;
  /** Disconnect, when there is a credential to disconnect. */
  headerAction?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  const { label, description } = settingCopy(settingKey);
  return (
    <div
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start gap-3 p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) text-(--color-text-primary)">
          {mark}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium text-(--color-text-primary)">
              {label}
            </h3>
            <ManagedByShipItBadge />
          </div>
          <p className="mt-1 text-xs text-(--color-text-secondary)">
            {description}
          </p>
        </div>
        {headerAction && <div className="ml-auto shrink-0">{headerAction}</div>}
      </div>
      <div className="h-px bg-(--color-border-secondary)" />
      <div className="space-y-3 p-3">{children}</div>
    </div>
  );
}

/** Whether the credential is stored, said the same way on both cards. */
export function ConnectionStatus({
  connected,
  detail,
  testId,
}: {
  connected: boolean;
  /** What being connected means here — the account, or what it can reach. */
  detail: string;
  testId: string;
}) {
  return (
    <p
      className="flex items-center gap-1.5 text-xs text-(--color-text-secondary)"
      data-testid={testId}
    >
      <StatusDot status={connected ? "success" : "info"} />
      {detail}
    </p>
  );
}
