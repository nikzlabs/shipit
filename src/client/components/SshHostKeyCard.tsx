/**
 * SshHostKeyCard — what server key ShipIt pinned, or refused (docs/305 req 9).
 *
 * The first connection to a destination accepts and records the server's host
 * key, and the fingerprint has to reach the user so they can compare it with the
 * server. A later key that does not match is refused at the signer; the card is
 * how the refusal becomes visible, since the agent only sees `ssh` fail.
 *
 * Terminal on creation, no lifecycle: the payload arrives whole on the chat
 * message and the component renders straight from props.
 */

import { KeyIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { SshHostKeyCard as SshHostKeyCardData } from "../../server/shared/types.js";

export function SshHostKeyCard({ card }: { card: SshHostKeyCardData }) {
  const mismatch = card.kind === "mismatch";
  return (
    <div
      data-testid="ssh-host-key-card"
      className={`w-full rounded-lg border overflow-hidden text-xs ${
        mismatch
          ? "border-(--color-warning)/50 bg-(--color-warning-subtle)"
          : "border-(--color-border-secondary) bg-(--color-bg-secondary)"
      }`}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span
          className={`shrink-0 mt-0.5 grid place-items-center w-7 h-7 rounded-lg border border-(--color-border-secondary) ${
            mismatch
              ? "bg-(--color-warning-subtle) text-(--color-warning)"
              : "bg-(--color-accent-subtle) text-(--color-accent)"
          }`}
        >
          {mismatch
            ? <WarningIcon size={ICON_SIZE.SM} weight="fill" />
            : <KeyIcon size={ICON_SIZE.SM} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-(--color-text-primary)">
            {mismatch
              ? `${card.label} presented a different host key — refused`
              : `Recorded the host key for ${card.label}`}
          </div>
          <p className="mt-1 text-(--color-text-secondary)">
            {mismatch
              ? `ShipIt will not authenticate to ${card.address} until the recorded key matches again. `
                + "If you rebuilt the server, forget the recorded key in Settings → Integrations."
              : `Compare this with the server's own fingerprint before you rely on ${card.address}.`}
          </p>
          <dl className="mt-2 flex flex-col gap-1">
            <div className="flex gap-2">
              <dt className="text-(--color-text-tertiary) w-20 shrink-0">{mismatch ? "Presented" : "Fingerprint"}</dt>
              <dd className="font-mono break-all text-(--color-text-primary)">
                {card.keyType} {card.fingerprint}
              </dd>
            </div>
            {mismatch && card.recordedFingerprint && (
              <div className="flex gap-2">
                <dt className="text-(--color-text-tertiary) w-20 shrink-0">Recorded</dt>
                <dd className="font-mono break-all text-(--color-text-primary)">{card.recordedFingerprint}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>
  );
}
