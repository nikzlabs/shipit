import type { FeatureInfo, FeatureStatus } from "../../server/types.js";

export interface FeaturesPanelProps {
  features: FeatureInfo[];
  onStartSession: (feature: FeatureInfo) => void;
  onRefresh: () => void;
}

const STATUS_CONFIG: Record<FeatureStatus, { label: string; bg: string; text: string }> = {
  "planned": { label: "Planned", bg: "bg-gray-200 dark:bg-gray-700", text: "text-gray-700 dark:text-gray-300" },
  "in-progress": { label: "In Progress", bg: "bg-yellow-200 dark:bg-yellow-900", text: "text-yellow-800 dark:text-yellow-200" },
  "done": { label: "Done", bg: "bg-green-200 dark:bg-green-900", text: "text-green-800 dark:text-green-200" },
  "paused": { label: "Paused", bg: "bg-gray-200 dark:bg-gray-600", text: "text-gray-600 dark:text-gray-200" },
};

function StatusBadge({ status }: { status: FeatureStatus }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG["planned"];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${config.bg} ${config.text}`}>
      {config.label}
    </span>
  );
}

export function FeaturesPanel({ features, onStartSession, onRefresh }: FeaturesPanelProps) {
  if (features.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium text-gray-400 dark:text-gray-500">No features found</p>
          <p className="text-xs text-gray-400 dark:text-gray-600 max-w-xs">
            Create feature docs in <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">docs/NNN-feature-name/plan.md</code> with
            optional YAML frontmatter for status tracking.
          </p>
          <button
            onClick={onRefresh}
            className="mt-2 px-3 py-1 text-xs rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 transition-colors"
          >
            Refresh
          </button>
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
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium">{features.length} feature{features.length !== 1 ? "s" : ""}</span>
        <button
          onClick={onRefresh}
          className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Refresh feature list"
        >
          Reload
        </button>
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
      <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
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
    <div className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-gray-400 dark:text-gray-500 font-mono shrink-0">
          {String(feature.number).padStart(3, "0")}
        </span>
        <span className="text-sm text-gray-800 dark:text-gray-200 truncate">
          {feature.name}
        </span>
        <StatusBadge status={feature.status} />
      </div>
      <button
        onClick={() => onStartSession(feature)}
        className="shrink-0 ml-2 px-2.5 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
        title={`Start a new session to work on ${feature.name}`}
      >
        Start Session
      </button>
    </div>
  );
}
