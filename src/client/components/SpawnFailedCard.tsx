

import { WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

export interface SpawnFailedCardProps {

  title?: string;

  reason:
    | "quota_per_turn"
    | "quota_per_parent"
    | "invalid_request"
    | "parent_missing"
    | "error";

  message: string;

  statusCode: number;

  promptPreview?: string;

  shipitSource?: boolean;

  failedAt?: string;
}

function headlineForReason(
  reason: SpawnFailedCardProps["reason"],
  statusCode: number,
  shipitSource: boolean,
): string {

  if (shipitSource && statusCode === 403) {
    return "No write access to the ShipIt repo";
  }
  switch (reason) {
    case "quota_per_turn":
      return shipitSource ? "Per-turn ShipIt-fix limit reached" : "Per-turn spawn limit reached";
    case "quota_per_parent":
      return "Per-session spawn limit reached";
    case "invalid_request":
      return shipitSource ? "ShipIt fix session rejected" : "Spawn request rejected";
    case "parent_missing":
      return "Parent session unavailable";
    case "error":
    default:
      return shipitSource ? "ShipIt fix session failed" : "Spawn failed";
  }
}

export function SpawnFailedCard({
  title,
  reason,
  message,
  statusCode,
  promptPreview,
  shipitSource = false,
}: SpawnFailedCardProps) {
  const headline = headlineForReason(reason, statusCode, shipitSource);
  const displayTitle = title?.trim() || (shipitSource ? "ShipIt fix session" : "Spawned session");

  const showIncidentHint = shipitSource && statusCode === 403;

  return (
    <div
      data-testid="spawn-failed-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-(--color-warning) mt-0.5">
          <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium flex items-center gap-1.5">
            <span>{shipitSource ? "ShipIt fix failed" : "Spawn failed"}</span>
            <span
              className="font-mono text-(--color-text-tertiary)"
              data-testid="spawn-failed-status"
            >
              · {statusCode}
            </span>
          </div>
          <div
            className="text-(--color-text-primary) font-medium truncate"
            title={displayTitle}
            data-testid="spawn-failed-title"
          >
            {displayTitle}
          </div>
        </div>
      </div>

      <div
        className="text-(--color-warning) text-[11px] font-medium"
        data-testid="spawn-failed-headline"
      >
        {headline}
      </div>

      <div
        className="text-(--color-text-secondary) text-[11px] whitespace-pre-wrap break-words"
        data-testid="spawn-failed-message"
      >
        {message}
      </div>

      {promptPreview && (
        <div
          className="rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5 text-[11px] text-(--color-text-tertiary) italic line-clamp-2"
          title={promptPreview}
          data-testid="spawn-failed-prompt"
        >
          “{promptPreview}”
        </div>
      )}

      {showIncidentHint && (
        <div
          className="text-(--color-text-tertiary) text-[11px]"
          data-testid="spawn-failed-incident-hint"
        >
          Ask the Ops agent to produce a structured incident report with source
          references and a patch outline instead.
        </div>
      )}
    </div>
  );
}
