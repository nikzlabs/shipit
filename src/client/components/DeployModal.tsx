import { useState, useEffect, useRef } from "react";
import type { DeployTargetInfo, DeploymentRecord } from "../../server/shared/types.js";

export type DeployPhase = "building" | "deploying" | "complete" | "error";

export interface DeployModalProps {
  targets: DeployTargetInfo[];
  configStatus: Record<string, { configured: boolean; projectName?: string }>;
  deployStatus: DeployPhase | null;
  lastDeployUrl: string | null;
  lastDeployError: string | null;
  deployHistory: DeploymentRecord[];
  onDeploy: (targetId: string, environment: "production" | "preview") => void;
  onCancel: () => void;
  onGetHistory: () => void;
  onSendErrorToChat: (errorMessage: string) => void;
  onOpenDeploySettings?: () => void;
  onClose: () => void;
}

type ModalView = "picker" | "ready" | "deploying" | "complete" | "error" | "not-configured";

export function DeployModal({
  targets,
  configStatus,
  deployStatus,
  lastDeployUrl,
  lastDeployError,
  deployHistory,
  onDeploy,
  onCancel,
  onGetHistory,
  onSendErrorToChat,
  onOpenDeploySettings,
  onClose,
}: DeployModalProps) {
  const [selectedTarget, setSelectedTarget] = useState<DeployTargetInfo | null>(null);
  const [environment, setEnvironment] = useState<"production" | "preview">("production");
  const [deploying, setDeploying] = useState(false);
  const [sendingError, setSendingError] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const configuredTargets = targets.filter((t) => configStatus[t.id]?.configured);

  // Determine the view based on state
  const getView = (): ModalView => {
    if (deployStatus === "building" || deployStatus === "deploying") return "deploying";
    if (deployStatus === "complete" || lastDeployUrl) return "complete";
    if (deployStatus === "error" || lastDeployError) return "error";
    if (configuredTargets.length === 0) return "not-configured";
    if (selectedTarget) return "ready";
    if (configuredTargets.length === 1) return "ready";
    return "picker";
  };

  const view = getView();

  // Auto-select target if only one configured target exists
  useEffect(() => {
    if (configuredTargets.length === 1 && !selectedTarget) {
      setSelectedTarget(configuredTargets[0]);
    }
  }, [configuredTargets, selectedTarget]);

  // Request history when entering ready view
  useEffect(() => {
    if (view === "ready") {
      onGetHistory();
    }
  }, [view, onGetHistory]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const activeTarget = selectedTarget ?? configuredTargets[0] ?? null;

  const handleDeploy = () => {
    if (!activeTarget || deploying) return;
    setDeploying(true);
    onDeploy(activeTarget.id, environment);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-label="Deploy"
      aria-modal="true"
    >
      <div
        ref={dialogRef}
        className="bg-(--color-bg-elevated) rounded-xl shadow-2xl border border-(--color-border-secondary) w-full max-w-lg max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-(--color-border-secondary)">
          <h2 className="text-lg font-semibold text-(--color-text-primary)">
            {view === "picker" && "Deploy"}
            {view === "not-configured" && "Deploy"}
            {view === "ready" && `Deploy to ${activeTarget?.name ?? ""}`}
            {view === "deploying" && "Deploying..."}
            {view === "complete" && "Deployed!"}
            {view === "error" && "Deploy Failed"}
          </h2>
          <button
            onClick={onClose}
            className="text-(--color-text-tertiary) hover:text-(--color-text-primary) text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="px-6 py-4">
          {/* No configured targets */}
          {view === "not-configured" && (
            <div className="space-y-3 text-center">
              <p className="text-sm text-(--color-text-secondary)">
                No deploy targets configured.
              </p>
              <p className="text-sm text-(--color-text-secondary)">
                Set up a deploy target in <strong className="text-(--color-text-primary)">Project Settings</strong>.
              </p>
              <div className="flex gap-2 justify-center">
                {onOpenDeploySettings && (
                  <button
                    onClick={() => { onClose(); onOpenDeploySettings(); }}
                    className="px-4 py-2 text-sm rounded-lg bg-(--color-accent) text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors font-medium"
                    data-testid="deploy-open-deploy-settings"
                  >
                    Configure
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm rounded-lg border border-(--color-border-secondary) text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Target picker (multiple configured targets) */}
          {view === "picker" && (
            <div className="space-y-3">
              {configuredTargets.map((target) => (
                <button
                  key={target.id}
                  onClick={() => setSelectedTarget(target)}
                  className="w-full text-left p-4 rounded-lg border border-(--color-border-secondary) hover:border-(--color-accent) hover:bg-(--color-bg-hover) transition-colors"
                >
                  <div className="font-medium text-(--color-text-primary)">{target.name}</div>
                  <div className="text-sm text-(--color-text-secondary) mt-0.5">{target.description}</div>
                </button>
              ))}
            </div>
          )}

          {/* Ready to deploy */}
          {view === "ready" && activeTarget && (
            <div className="space-y-4">
              {activeTarget.supportsPreview && (
                <div>
                  <label className="block text-sm font-medium text-(--color-text-primary) mb-2">
                    Environment
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEnvironment("production")}
                      className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                        environment === "production"
                          ? "border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link) font-medium"
                          : "border-(--color-border-secondary) text-(--color-text-secondary) hover:border-(--color-text-tertiary)"
                      }`}
                    >
                      Production
                    </button>
                    <button
                      onClick={() => setEnvironment("preview")}
                      className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                        environment === "preview"
                          ? "border-(--color-accent) bg-(--color-accent-subtle) text-(--color-text-link) font-medium"
                          : "border-(--color-border-secondary) text-(--color-text-secondary) hover:border-(--color-text-tertiary)"
                      }`}
                    >
                      Preview
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={handleDeploy}
                disabled={deploying}
                className="w-full py-2.5 text-sm rounded-lg bg-(--color-accent) text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deploying ? "Starting deploy..." : `Deploy to ${environment === "production" ? "Production" : "Preview"}`}
              </button>

              {configuredTargets.length > 1 && (
                <div className="text-xs">
                  <button
                    onClick={() => setSelectedTarget(null)}
                    className="text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors"
                  >
                    Switch target
                  </button>
                </div>
              )}

              {/* Deploy history */}
              {deployHistory.length > 0 && (
                <div className="border-t border-(--color-border-secondary) pt-4">
                  <h3 className="text-sm font-medium text-(--color-text-primary) mb-2">Recent Deployments</h3>
                  <div className="space-y-2">
                    {deployHistory.slice(-5).reverse().map((record) => (
                      <div
                        key={record.id}
                        className="flex items-center justify-between text-xs py-1.5 px-2 rounded bg-(--color-bg-secondary)"
                      >
                        <div className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full ${record.status === "success" ? "bg-(--color-success)" : "bg-(--color-error)"}`} />
                          <a
                            href={record.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-(--color-text-link) hover:text-(--color-accent) truncate max-w-[200px]"
                          >
                            {record.url}
                          </a>
                        </div>
                        <span className="text-(--color-text-tertiary) shrink-0 ml-2">
                          {new Date(record.timestamp).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Deploying */}
          {view === "deploying" && (
            <div className="space-y-4 text-center">
              <div className="flex items-center justify-center gap-2">
                <div className="w-5 h-5 border-2 border-(--color-accent) border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-(--color-text-secondary)">
                  {deployStatus === "building" ? "Building project..." : "Deploying..."}
                </span>
              </div>
              <p className="text-xs text-(--color-text-secondary)">Check the Terminal tab for detailed output.</p>
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm rounded-lg border border-(--color-border-secondary) text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Complete */}
          {view === "complete" && lastDeployUrl && (
            <div className="space-y-4 text-center">
              <div className="flex items-center justify-center gap-2 text-(--color-success)">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm font-medium">Deployment successful!</span>
              </div>
              <a
                href={lastDeployUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-(--color-text-link) hover:text-(--color-accent) text-sm break-all"
              >
                {lastDeployUrl}
              </a>
              <div className="flex gap-2">
                <a
                  href={lastDeployUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 py-2 text-sm rounded-lg bg-(--color-accent) text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors font-medium text-center"
                >
                  Open
                </a>
                <button
                  onClick={onClose}
                  className="flex-1 py-2 text-sm rounded-lg border border-(--color-border-secondary) text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {view === "error" && lastDeployError && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-(--color-error)">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-sm font-medium">Deployment failed</span>
              </div>
              <div className="text-sm text-(--color-text-secondary) bg-(--color-error-subtle) border border-(--color-error)/30 rounded-lg p-3">
                {lastDeployError}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setSendingError(true);
                    onSendErrorToChat(lastDeployError);
                    setTimeout(() => setSendingError(false), 1000);
                  }}
                  disabled={sendingError}
                  className="flex-1 py-2 text-sm rounded-lg bg-(--color-accent) text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sendingError ? "Sent!" : "Send to Claude"}
                </button>
                <button
                  onClick={() => {
                    if (activeTarget) {
                      handleDeploy();
                    }
                  }}
                  disabled={deploying}
                  className="flex-1 py-2 text-sm rounded-lg border border-(--color-border-secondary) text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deploying ? "Retrying..." : "Retry"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
