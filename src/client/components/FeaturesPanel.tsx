import { Badge } from "./ui/badge.js";
import type { BadgeProps } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import type { FeatureInfo, FeatureStatus } from "../../server/shared/types.js";

export interface FeaturesPanelProps {
  features: FeatureInfo[];
  onStartSession: (feature: FeatureInfo) => void;
  onRefresh: () => void;
}

const STATUS_CONFIG: Record<FeatureStatus, { label: string; variant: BadgeProps["variant"] }> = {
  "planned": { label: "Planned", variant: "default" },
  "in-progress": { label: "In Progress", variant: "warning" },
  "done": { label: "Done", variant: "success" },
  "paused": { label: "Paused", variant: "default" },
};

function StatusBadge({ status }: { status: FeatureStatus }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG["planned"];
  return (
    <Badge variant={config.variant} className="text-[11px]">
      {config.label}
    </Badge>
  );
}

export function FeaturesPanel({ features, onStartSession, onRefresh }: FeaturesPanelProps) {
  if (features.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium text-(--color-text-tertiary)">No features found</p>
          <p className="text-xs text-(--color-text-tertiary) max-w-xs">
            Create feature docs in <code className="text-xs bg-(--color-bg-secondary) px-1 rounded">docs/NNN-feature-name/plan.md</code> with
            optional YAML frontmatter for status tracking.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            className="mt-2"
          >
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  const planned = features.filter((f) => f.status === "planned");
  const inProgress = features.filter((f) => f.status === "in-progress");
  const paused = features.filter((f) => f.status === "paused");
  const done = features.filter((f) => f.status === "done");

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <span className="font-medium">{features.length} feature{features.length !== 1 ? "s" : ""}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          title="Refresh feature list"
        >
          Reload
        </Button>
      </div>

      {/* Feature list */}
      <div className="flex-1 overflow-y-auto">
        {inProgress.length > 0 && (
          <FeatureGroup label="In Progress" features={inProgress} onStartSession={onStartSession} />
        )}
        {planned.length > 0 && (
          <FeatureGroup label="Planned" features={planned} onStartSession={onStartSession} />
        )}
        {paused.length > 0 && (
          <FeatureGroup label="Paused" features={paused} onStartSession={onStartSession} />
        )}
        {done.length > 0 && (
          <FeatureGroup label="Done" features={done} onStartSession={onStartSession} />
        )}
      </div>
    </div>
  );
}

function FeatureGroup({
  label,
  features,
  onStartSession,
}: {
  label: string;
  features: FeatureInfo[];
  onStartSession: (feature: FeatureInfo) => void;
}) {
  return (
    <div className="py-2">
      <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
        {label}
      </div>
      {features.map((feature) => (
        <FeatureRow key={feature.id} feature={feature} onStartSession={onStartSession} />
      ))}
    </div>
  );
}

function FeatureRow({
  feature,
  onStartSession,
}: {
  feature: FeatureInfo;
  onStartSession: (feature: FeatureInfo) => void;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 hover:bg-(--color-bg-hover) transition-colors group">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-(--color-text-tertiary) font-mono shrink-0">
          {String(feature.number).padStart(3, "0")}
        </span>
        <span className="text-sm text-(--color-text-primary) truncate">
          {feature.name}
        </span>
        <StatusBadge status={feature.status} />
      </div>
      <Button
        variant="primary"
        size="sm"
        onClick={() => onStartSession(feature)}
        className="shrink-0 ml-2 opacity-0 group-hover:opacity-100 focus:opacity-100"
        title={`Start a new session to work on ${feature.name}`}
      >
        Start Session
      </Button>
    </div>
  );
}
