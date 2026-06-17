/**
 * ReleaseLifecycleCard (docs/171) — the inline card for a chat-initiated release.
 * It is a **persisted transcript card**: the full `ReleaseStatusSummary` rides on
 * the chat message (upserted by the `release_card` WS, rehydrated from history),
 * so it survives a reconnect, switch, reload, AND an orchestrator restart — and
 * it renders inline at the point in scrollback where the release was proposed,
 * not as top chrome.
 *
 * Two shapes, driven by `phase`:
 *   - `proposed` → expanded: version, bump, gate/CI, tag, grouped notes, a
 *     prerelease badge, and the Confirm & publish / Cancel controls.
 *   - every other phase (`tagging | gating | published | deploying | released |
 *     failed | cancelled`) → a compact collapsed row — the card "collapses to
 *     that state" the moment the user decides, then keeps advancing to the
 *     terminal `released`/`failed` in place.
 *
 * The confirmation control is NOT a shell-shaped affordance (CLAUDE.md §5): it
 * answers the agent's proposal by sending a chat message through the same
 * user-message surface as any other reply. A one-shot guard (`acted`) hides the
 * buttons after the first click so a proposal can't be confirmed twice while the
 * agent's follow-up turn is still in flight.
 */

import { useState } from "react";
import {
  TagIcon,
  RocketLaunchIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  SealCheckIcon,
  ArrowSquareOutIcon,
  GlobeIcon,
  ProhibitIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { OverflowMenu } from "./ui/overflow-menu.js";
import { DropdownMenuItem } from "./ui/dropdown-menu.js";
import type {
  ReleaseStatusSummary,
  ReleaseChecksSummary,
  ReleaseMechanism,
  GitHubDeploymentStatus,
} from "../../server/shared/types.js";

export interface ReleaseLifecycleCardProps {
  /** Full release snapshot — the card renders straight from this (no store). */
  card: ReleaseStatusSummary;
  /**
   * Confirm & publish — sends the "yes, ship it" chat message to the agent. The
   * mechanism (defaulted to `tag-triggered` when the card omits it) lets the
   * handler word the message correctly: a `release-branch` repo opens/merges a
   * version-bump PR (CI tags), while `tag-triggered` pushes the tag.
   */
  onConfirm?: (version: string, mechanism: ReleaseMechanism) => void;
  /** Cancel — sends the cancel chat message to the agent. */
  onCancel?: (version: string) => void;
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

const STATUS_LABEL: Record<ReleaseStatusSummary["phase"], string> = {
  proposed: "Release proposed",
  tagging: "Tagging…",
  pr_open: "Release PR open — merge to publish",
  pr_merged: "Release PR merged — publishing…",
  gating: "Publishing release…",
  published: "Release published",
  deploying: "Deploying…",
  released: "Released",
  failed: "Release failed",
  cancelled: "Release cancelled",
};

function headerIconFor(phase: ReleaseStatusSummary["phase"]) {
  if (phase === "released") {
    return <SealCheckIcon size={ICON_SIZE.SM} weight="fill" className="text-(--color-success)" />;
  }
  if (phase === "failed") {
    return <XCircleIcon size={ICON_SIZE.SM} weight="fill" className="text-(--color-error)" />;
  }
  if (phase === "cancelled") {
    return <ProhibitIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary)" />;
  }
  if (phase === "tagging" || phase === "pr_merged" || phase === "gating" || phase === "deploying") {
    return <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin text-(--color-warning)" />;
  }
  return <RocketLaunchIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />;
}

export function ReleaseLifecycleCard({ card, onConfirm, onCancel }: ReleaseLifecycleCardProps) {
  // One-shot guard: a proposal answered once must not be answerable again while
  // the agent's follow-up turn is still in flight (the card stays `proposed`
  // until the agent emits the tagged/cancelled marker). Local state — on reload
  // the persisted card has either advanced (collapsed) or, if the agent never
  // acted, comes back `proposed` and correctly actionable again.
  const [acted, setActed] = useState(false);

  const { phase, version, tag, prerelease, bumpType, versionSource } = card;
  const releaseUrl = card.release?.htmlUrl;
  const prUrl = card.prUrl;
  const label = phase === "released" && card.alreadyReleased ? "Already released" : STATUS_LABEL[phase];

  const meta = (
    <>
      <span className="flex items-center gap-1 text-xs text-(--color-text-secondary)">
        <TagIcon size={ICON_SIZE.XS} /> {tag}
      </span>
      {prerelease && (
        <Badge variant="warning" className="text-[10px] uppercase tracking-wider">
          Prerelease
        </Badge>
      )}
    </>
  );

  const actions = (
    <div className="ml-auto flex items-center gap-2">
      <GateIndicator checks={card.checks} />
      {(releaseUrl || prUrl) && (
        <OverflowMenu label="Release actions" triggerClassName="h-auto w-auto p-1">
          {prUrl && (
            <DropdownMenuItem onSelect={() => window.open(prUrl, "_blank", "noopener,noreferrer")}>
              <ArrowSquareOutIcon size={ICON_SIZE.SM} />
              View release PR on GitHub
            </DropdownMenuItem>
          )}
          {releaseUrl && (
            <DropdownMenuItem onSelect={() => window.open(releaseUrl, "_blank", "noopener,noreferrer")}>
              <ArrowSquareOutIcon size={ICON_SIZE.SM} />
              View release on GitHub
            </DropdownMenuItem>
          )}
        </OverflowMenu>
      )}
    </div>
  );

  // Collapsed: every phase past the decision. A compact single row (+ an error
  // line for `failed`), so a confirmed/cancelled/released card sits quietly in
  // the transcript.
  if (phase !== "proposed") {
    return (
      <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden p-2.5">
        <div className="flex items-center gap-2">
          {headerIconFor(phase)}
          <span className="text-sm font-medium text-(--color-text-primary)">{label}</span>
          {meta}
          <span className="text-xs text-(--color-text-tertiary)">{version}</span>
          {actions}
        </div>
        {card.errorMessage && phase === "failed" && (
          <div className="mt-1.5 text-xs text-(--color-error)">{card.errorMessage}</div>
        )}
      </div>
    );
  }

  // Proposed: the expanded, interactive card.
  return (
    <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden p-3">
      <div className="flex items-center gap-2">
        {headerIconFor(phase)}
        <span className="text-sm font-medium text-(--color-text-primary)">{label}</span>
        {meta}
        {bumpType && (
          <Badge variant="info" className="text-[10px] uppercase tracking-wider">
            {bumpType}
          </Badge>
        )}
        {actions}
      </div>

      <div className="mt-1 text-xs text-(--color-text-tertiary)">
        {version}
        {versionSource ? ` · ${versionSource}` : ""}
      </div>

      <Notes notes={card.notes} />
      <DeploymentRow deployments={card.deployments} />

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          disabled={acted}
          onClick={() => {
            if (acted) return;
            setActed(true);
            onConfirm?.(version, card.mechanism ?? "tag-triggered");
          }}
        >
          <RocketLaunchIcon size={ICON_SIZE.SM} weight="fill" className="mr-1" />
          Confirm &amp; publish {version}
        </Button>
        <Button
          variant="ghost"
          size="md"
          disabled={acted}
          onClick={() => {
            if (acted) return;
            setActed(true);
            onCancel?.(version);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
