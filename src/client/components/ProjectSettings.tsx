import { useState } from "react";
import type { DeployTargetInfo } from "../../server/types.js";

export interface ProjectSettingsProps {
  deployTargets: DeployTargetInfo[];
  deployConfigStatus: Record<string, { configured: boolean; projectName?: string }>;
  onDeployConfigure: (targetId: string, credentials: Record<string, string>, projectName?: string) => void;
  onDeployDeleteConfig: (targetId: string) => void;
  onClose: () => void;
}

export function ProjectSettings({
  deployTargets,
  deployConfigStatus,
  onDeployConfigure,
  onDeployDeleteConfig,
  onClose,
}: ProjectSettingsProps) {
  const [selectedTarget, setSelectedTarget] = useState<DeployTargetInfo | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [projectName, setProjectName] = useState("");

  const handleConfigSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTarget) return;
    onDeployConfigure(selectedTarget.id, configValues, projectName || undefined);
  };

  const handleBackToList = () => {
    setSelectedTarget(null);
    setConfigValues({});
    setProjectName("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="project-settings-backdrop"
    >
      <div
        className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl max-w-lg w-full mx-4 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label="Project Settings"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-300 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Project Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 overflow-y-auto">
          {selectedTarget ? (
            <form onSubmit={handleConfigSubmit} className="space-y-4" data-testid="deploy-config-form">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleBackToList}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                  aria-label="Back to targets"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Configure {selectedTarget.name}
                </h3>
              </div>

              {selectedTarget.configFields.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-0.5">*</span>}
                  </label>
                  <input
                    type={field.sensitive ? "password" : "text"}
                    placeholder={field.placeholder}
                    value={configValues[field.key] || ""}
                    onChange={(e) =>
                      setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required={field.required}
                    autoComplete="off"
                    data-testid={`deploy-config-field-${field.key}`}
                  />
                  {field.helpText && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{field.helpText}</p>
                  )}
                  {field.helpUrl && (
                    <a
                      href={field.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:text-blue-400 mt-1 inline-block"
                    >
                      Get credentials &rarr;
                    </a>
                  )}
                </div>
              ))}

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Project Name <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  placeholder="Auto-generated from directory name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  data-testid="deploy-config-project-name"
                />
              </div>

              <button
                type="submit"
                className="w-full px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors font-medium"
                data-testid="deploy-config-save"
              >
                Save Configuration
              </button>
            </form>
          ) : (
            <div className="space-y-3" data-testid="deploy-target-list">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Deploy Targets</h3>
              {deployTargets.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">No deployment targets available.</p>
              ) : (
                deployTargets.map((target) => {
                  const status = deployConfigStatus[target.id];
                  return (
                    <div
                      key={target.id}
                      className="p-4 rounded-lg border border-gray-200 dark:border-gray-700"
                      data-testid={`deploy-target-${target.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium text-gray-900 dark:text-gray-100">{target.name}</div>
                          <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{target.description}</div>
                        </div>
                        {status?.configured && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300">
                            Configured
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => {
                            setSelectedTarget(target);
                            setConfigValues({});
                            setProjectName(status?.projectName ?? "");
                          }}
                          className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
                          data-testid={`deploy-target-configure-${target.id}`}
                        >
                          {status?.configured ? "Reconfigure" : "Configure"}
                        </button>
                        {status?.configured && (
                          <>
                            <span className="text-gray-400 text-xs">|</span>
                            <button
                              onClick={() => onDeployDeleteConfig(target.id)}
                              className="text-xs text-red-500 hover:text-red-400 transition-colors"
                              data-testid={`deploy-target-remove-${target.id}`}
                            >
                              Remove credentials
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
