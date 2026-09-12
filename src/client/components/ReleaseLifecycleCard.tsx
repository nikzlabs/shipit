

import { useState } from "react";
import { Spinner } from "./Spinner.js";
import {
  TagIcon,
  RocketLaunchIcon,
  CheckCircleIcon,
  XCircleIcon, SealCheckIcon,
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

  card: ReleaseStatusSummary;

  onConfirm?: (version: string, mechanism: ReleaseMechanism) => void;

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
      <Spinner size={ICON_SIZE.SM} /> Gate running
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
    return <Spinner size={ICON_SIZE.SM} className="text-(--color-warning)" />;
  }
  return <RocketLaunchIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />;
}

export function ReleaseLifecycleCard({ card, onConfirm, onCancel }: ReleaseLifecycleCardProps) {
  // One-shot guard: a proposal answered once must not be answerable again while

  // the persisted card has either advanced (collapsed) or, if the agent never

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
