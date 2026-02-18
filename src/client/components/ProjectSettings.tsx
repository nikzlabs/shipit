import { useState, useEffect, useRef } from "react";

const MAX_LENGTH = 50_000;

type Tab = "github" | "instructions";

export interface ProjectSettingsProps {
  initialContent: string;
  onSaveInstructions: (content: string) => void;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  onGitHubTokenSubmit: (token: string) => void;
  onGitHubLogout: () => void;
  onClose: () => void;
}

export function ProjectSettings({
  initialContent,
  onSaveInstructions,
  githubStatus,
  onGitHubTokenSubmit,
  onGitHubLogout,
  onClose,
}: ProjectSettingsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("github");
  const [content, setContent] = useState(initialContent);
  const [token, setToken] = useState("");
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const savedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeTab === "instructions") {
      textareaRef.current?.focus();
    } else if (activeTab === "github" && !githubStatus.authenticated) {
      tokenInputRef.current?.focus();
    }
  }, [activeTab, githubStatus.authenticated]);

  const handleSave = () => {
    savedRef.current = true;
    onSaveInstructions(content);
  };

  const handleBackdropClick = () => {
    if (!savedRef.current) {
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (activeTab === "instructions" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  const handleTokenSubmit = () => {
    const trimmed = token.trim();
    if (trimmed) {
      onGitHubTokenSubmit(trimmed);
    }
  };

  const handleTokenKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTokenSubmit();
    }
  };

  const charCount = content.length;
  const isOverLimit = charCount > MAX_LENGTH;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
      data-testid="project-settings-backdrop"
    >
      <div
        className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl max-w-2xl w-full mx-4 flex flex-col h-120"
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

        {/* Body: sidebar tabs + content */}
        <div className="flex flex-1 min-h-0">
          {/* Left tab sidebar */}
          <nav className="w-40 shrink-0 border-r border-gray-200 dark:border-gray-700 py-2">
            {(["github", "instructions"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                  activeTab === tab
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-medium"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                }`}
              >
                {tab === "github" ? "GitHub" : "Instructions"}
              </button>
            ))}
          </nav>

          {/* Right content area */}
          {activeTab === "instructions" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-3 overflow-y-auto">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                These instructions are sent to the agent with every message. Use them to define project
                conventions, preferred libraries, or style guidelines.
              </p>

              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="e.g. Always use TypeScript with strict mode. Use Tailwind CSS for styling."
                className="flex-1 min-h-30 w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
                data-testid="project-settings-textarea"
              />

              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>
                  Note: The agent also reads CLAUDE.md from your workspace root automatically.
                </span>
                <span className={isOverLimit ? "text-red-400" : ""}>
                  {charCount.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm rounded-md text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={isOverLimit}
                  className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  data-testid="project-settings-save"
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {activeTab === "github" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              {githubStatus.authenticated ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {githubStatus.username ?? "GitHub"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Connected</p>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      if (confirmingLogout) {
                        onGitHubLogout();
                        setConfirmingLogout(false);
                      } else {
                        setConfirmingLogout(true);
                      }
                    }}
                    onBlur={() => setConfirmingLogout(false)}
                    className={`w-full px-3 py-2 text-sm rounded-md border transition-colors ${
                      confirmingLogout
                        ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300"
                        : "bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                    data-testid="project-settings-disconnect"
                  >
                    {confirmingLogout ? "Click again to disconnect" : "Disconnect"}
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Enter a <strong className="text-gray-700 dark:text-gray-300">classic</strong> Personal Access Token with
                    the <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">repo</code> scope.
                    Fine-grained tokens are not supported.
                  </p>

                  <input
                    ref={tokenInputRef}
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={handleTokenKeyDown}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    className="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                    data-testid="project-settings-token-input"
                  />

                  <button
                    onClick={handleTokenSubmit}
                    disabled={!token.trim()}
                    className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="project-settings-connect"
                  >
                    Connect
                  </button>

                  <p className="text-xs text-gray-500">
                    Your token is stored locally and never shared. Create one at{" "}
                    <a
                      href="https://github.com/settings/tokens/new"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300"
                    >
                      GitHub Settings
                    </a>.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
