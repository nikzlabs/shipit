/**
 * ReleaseLifecycleCard (docs/171 Phase 1) — the inline card for a chat-initiated
 * release, modeled on PrLifecycleCard. It renders the release state machine
 * (`proposed | tagging | gating | published | deploying | released | failed`)
 * entirely inside ShipIt: version, bump type, gate/CI checks, the tag, grouped
 * notes, a prerelease badge, deploy status, and an overflow-only "View on
 * GitHub" escape hatch.
 *
 * The confirmation control is NOT a shell-shaped affordance (CLAUDE.md §5): it
 * answers the agent's proposal by sending a chat message through the same
 * user-message surface as any other reply — it never runs a command. The
 * orchestrator's release flow reacts to the agent's follow-up turn.
 */

import {
  TagIcon,
  RocketLaunchIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  SealCheckIcon,
  ArrowSquareOutIcon,
  GlobeIcon,
} from "@phosphor-icons/react";
import { useReleaseStore } from "../stores/release-store.js";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { OverflowMenu } from "./ui/overflow-menu.js";
import { DropdownMenuItem } from "./ui/dropdown-menu.js";
import type { ReleaseChecksSummary, GitHubDeploymentStatus } from "../../server/shared/types.js";

export interface ReleaseLifecycleCardProps {
  sessionId: string;
  /** Confirm & publish — sends the "yes, ship it" chat message to the agent. */
  onConfirm: (version: string) => void;
  /** Cancel — sends the cancel chat message and dismisses the card. */
  onCancel: (version: string) => void;
}

function GateIndicator({ checks }: { checks?: ReleaseChecksSummary }) {
  if (!checks || checks.state === "none") return null;
  if (checks.state === "success") {
    return (
      <span
        className="text-(--color-success) text-xs flex items-center gap-1 shrink-0"
        title={`Gate passed — ${checks.passed}/${checks.total} checks`}
      >
        <CheckCircleIcon size={ICON_SIZE.SM} /> Gate {checks.passed}/{checks.total}
      </span>
    );
  }
  if (checks.state === "failure") {
    return (
      <span
        className="text-(--color-error) text-xs flex items-center gap-1 shrink-0"
        title={`Gate failed — ${checks.failed} of ${checks.total} checks`}
      >
        <XCircleIcon size={ICON_SIZE.SM} /> Gate {checks.passed}/{checks.total}
      </span>
    );
  }
  return (
    <span
      className="text-(--color-warning) text-xs flex items-center gap-1 shrink-0 animate-pulse"
      title="Release gate running"
    >
      <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin" /> Gate running
    </span>
  );
}

function DeploymentRow({ deployments }: { deployments?: GitHubDeploymentStatus[] }) {
  if (!deployments || deployments.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {deployments.map((d, i) => (
        <div key={`${d.environment}-${i}`} className="text-xs flex items-center gap-1 text-(--color-text-secondary)">
          <GlobeIcon size={ICON_SIZE.XS} />
          {d.environmentUrl ? (
            <a href={d.environmentUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {d.environment}
            </a>
          ) : (
            <span>{d.environment}</span>
          )}
          <span className="text-(--color-text-tertiary)">— {d.state}</span>
        </div>
      ))}
    </div>
  );
}

/** Truncated, monospace-free notes preview / published notes. */
function Notes({ notes }: { notes?: string }) {
  if (!notes?.trim()) return null;
  return (
    <div className="mt-2 text-xs text-(--color-text-secondary) whitespace-pre-wrap max-h-40 overflow-y-auto rounded-md bg-(--color-bg-tertiary) p-2">
      {notes.trim()}
    </div>
  );
}

export function ReleaseLifecycleCard({ sessionId, onConfirm, onCancel }: ReleaseLifecycleCardProps) {
  const card = useReleaseStore((s) => s.cardBySession[sessionId]);
  const dismiss = useReleaseStore((s) => s.dismiss);
  if (!card) return null;

  const { phase, version, tag, prerelease, bumpType, versionSource } = card;
  const releaseUrl = card.release?.htmlUrl;

  const headerIcon =
    phase === "released" ? (
      <SealCheckIcon size={ICON_SIZE.SM} weight="fill" className="text-(--color-success)" />
    ) : phase === "failed" ? (
      <XCircleIcon size={ICON_SIZE.SM} weight="fill" className="text-(--color-error)" />
    ) : phase === "tagging" || phase === "gating" || phase === "deploying" ? (
      <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin text-(--color-warning)" />
    ) : (
      <RocketLaunchIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />
    );

  const statusLabel: Record<typeof phase, string> = {
    proposed: "Release proposed",
    tagging: "Tagging…",
    gating: "Publishing release…",
    published: "Release published",
    deploying: "Deploying…",
    released: card.alreadyReleased ? "Already released" : "Released",
    failed: "Release failed",
  };

  return (
    <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden p-3">
      <div className="flex items-center gap-2">
        {headerIcon}
        <span className="text-sm font-medium text-(--color-text-primary)">{statusLabel[phase]}</span>
        <span className="flex items-center gap-1 text-xs text-(--color-text-secondary)">
          <TagIcon size={ICON_SIZE.XS} /> {tag}
        </span>
        {prerelease && (
          <Badge variant="warning" className="text-[10px] uppercase tracking-wider">
            Prerelease
          </Badge>
        )}
        {bumpType && phase === "proposed" && (
          <Badge variant="info" className="text-[10px] uppercase tracking-wider">
            {bumpType}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <GateIndicator checks={card.checks} />
          {releaseUrl && (
            <OverflowMenu label="Release actions" triggerClassName="h-auto w-auto p-1">
              <DropdownMenuItem onSelect={() => window.open(releaseUrl, "_blank", "noopener,noreferrer")}>
                <ArrowSquareOutIcon size={ICON_SIZE.SM} />
                View release on GitHub
              </DropdownMenuItem>
            </OverflowMenu>
          )}
        </div>
      </div>

      <div className="mt-1 text-xs text-(--color-text-tertiary)">
        {version}
        {versionSource ? ` · ${versionSource}` : ""}
      </div>

      {card.errorMessage && phase === "failed" && (
        <div className="mt-2 text-xs text-(--color-error)">{card.errorMessage}</div>
      )}

      <Notes notes={card.notes} />
      <DeploymentRow deployments={card.deployments} />

      {phase === "proposed" && (
        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" size="md" onClick={() => onConfirm(version)}>
            <RocketLaunchIcon size={ICON_SIZE.SM} weight="fill" className="mr-1" />
            Confirm &amp; publish {version}
          </Button>
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              onCancel(version);
              dismiss(sessionId);
            }}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
