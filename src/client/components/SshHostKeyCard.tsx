/**
 * SshHostKeyCard — what server key ShipIt pinned, or refused (docs/305 req 9,
 * req 13).
 *
 * The first connection to a destination records the server's host key only if
 * the orchestrator sees that same key at the configured address itself, and the
 * fingerprint has to reach the user so they can compare it with the server. Two
 * refusals are otherwise invisible — the agent only sees `ssh` fail — so each
 * gets a card: a key that does not match the recorded one, and a first key the
 * orchestrator could not observe at the address.
 *
 * Terminal on creation, no lifecycle: the payload arrives whole on the chat
 * message and the component renders straight from props.
 */

import { KeyIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type {
  SshHostKeyCard as SshHostKeyCardData,
  SshHostKeyScanFailureKind,
} from "../../server/shared/types.js";

const SCAN_FAILURE_TEXT: Record<SshHostKeyScanFailureKind, string> = {
  "no-answer": "nothing answered there",
  timeout: "the check timed out",
  "scan-failed": "ShipIt could not run the check",
  "unsupported-type": "ShipIt cannot check that key type",
  "endpoint-changed": "the destination was edited mid-check",
};

function headline(card: SshHostKeyCardData): string {
  if (card.kind === "mismatch") return `${card.label} presented a different host key — refused`;
  if (card.kind === "unverified") return `Could not verify ${card.label}'s host key — refused`;
  return `Recorded the host key for ${card.label}`;
}

function body(card: SshHostKeyCardData): string {
  if (card.kind === "mismatch") {
    return `ShipIt will not authenticate to ${card.address} until the recorded key matches again. `
      + "If you rebuilt the server, forget the recorded key in Settings → Integrations.";
  }
  if (card.scanFailure === "endpoint-changed") {
    return `This destination was edited while ShipIt was checking its host key, so what the check `
      + `found no longer said anything about ${card.address}. Nothing was recorded, and the next `
      + "connection checks the new address.";
  }
  if (card.kind === "unverified") {
    const saw = card.scannedFingerprint
      ? "a different key answered"
      : SCAN_FAILURE_TEXT[card.scanFailure ?? "no-answer"];
    return `ShipIt records a host key only after seeing it at the destination's own address, and `
      + `${saw} at ${card.address}. Nothing was recorded. Check the address and port on the `
      + "destination in Settings → Integrations, and that the server is reachable from ShipIt.";
  }
  return `Compare this with the server's own fingerprint before you rely on ${card.address}.`;
}

export function SshHostKeyCard({ card }: { card: SshHostKeyCardData }) {
  const warn = card.kind !== "recorded";
  return (
    <div
      data-testid="ssh-host-key-card"
      className={`w-full rounded-lg border overflow-hidden text-xs ${
        warn
          ? "border-(--color-warning)/50 bg-(--color-warning-subtle)"
          : "border-(--color-border-secondary) bg-(--color-bg-secondary)"
      }`}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span
          className={`shrink-0 mt-0.5 grid place-items-center w-7 h-7 rounded-lg border border-(--color-border-secondary) ${
            warn
              ? "bg-(--color-warning-subtle) text-(--color-warning)"
              : "bg-(--color-accent-subtle) text-(--color-accent)"
          }`}
        >
          {warn
            ? <WarningIcon size={ICON_SIZE.SM} weight="fill" />
            : <KeyIcon size={ICON_SIZE.SM} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-(--color-text-primary)">{headline(card)}</div>
          <p className="mt-1 text-(--color-text-secondary)">{body(card)}</p>
          <dl className="mt-2 flex flex-col gap-1">
            <div className="flex gap-2">
              <dt className="text-(--color-text-tertiary) w-20 shrink-0">
                {warn ? "Presented" : "Fingerprint"}
              </dt>
              <dd className="font-mono break-all text-(--color-text-primary)">
                {card.keyType} {card.fingerprint}
              </dd>
            </div>
            {card.kind === "mismatch" && card.recordedFingerprint && (
              <div className="flex gap-2">
                <dt className="text-(--color-text-tertiary) w-20 shrink-0">Recorded</dt>
                <dd className="font-mono break-all text-(--color-text-primary)">{card.recordedFingerprint}</dd>
              </div>
            )}
            {card.kind === "unverified" && card.scannedFingerprint && (
              <div className="flex gap-2">
                <dt className="text-(--color-text-tertiary) w-20 shrink-0">Seen at address</dt>
                <dd className="font-mono break-all text-(--color-text-primary)">
                  {card.scannedKeyType ? `${card.scannedKeyType} ` : ""}{card.scannedFingerprint}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>
  );
}
