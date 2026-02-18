import { useState } from "react";

export interface DeviceAuthCode {
  userCode: string;
  verificationUri: string;
}

export interface GitHubAuthOverlayProps {
  onSubmit: (token: string) => void;
  onClose: () => void;
  onStartDeviceAuth: () => void;
  deviceAuthCode?: DeviceAuthCode | null;
  deviceAuthError?: string | null;
  /** Whether the device auth flow is available (server has a client ID configured). */
  deviceAuthAvailable?: boolean;
}

export function GitHubAuthOverlay({
  onSubmit,
  onClose,
  onStartDeviceAuth,
  deviceAuthCode,
  deviceAuthError,
  deviceAuthAvailable,
}: GitHubAuthOverlayProps) {
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);

  const handleSubmit = () => {
    const trimmed = token.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  const handleCopyCode = async () => {
    if (!deviceAuthCode) return;
    try {
      await navigator.clipboard.writeText(deviceAuthCode.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  // Device code display view — shown after starting device auth
  if (deviceAuthCode) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 space-y-6">
          <div className="space-y-2 text-center">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Connect to GitHub
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Enter this code on GitHub:
            </p>
          </div>

          <div className="flex items-center justify-center gap-3">
            <div className="px-6 py-3 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600">
              <span className="text-2xl font-mono font-bold tracking-widest text-gray-900 dark:text-gray-100">
                {deviceAuthCode.userCode}
              </span>
            </div>
            <button
              onClick={handleCopyCode}
              className="rounded-lg bg-gray-100 dark:bg-gray-800 px-3 py-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              title="Copy code"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          <div className="text-center">
            <a
              href={deviceAuthCode.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-500 hover:text-blue-400 transition-colors"
            >
              Open github.com/login/device
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>

          <div className="text-center space-y-2">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Waiting for authorization...
            </p>
            <div className="flex justify-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse [animation-delay:0.4s]" />
            </div>
          </div>

          {deviceAuthError && (
            <div className="text-center">
              <p className="text-sm text-red-500 dark:text-red-400">{deviceAuthError}</p>
            </div>
          )}

          <div className="flex">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Error view after device auth failed (no code displayed)
  if (deviceAuthError && !deviceAuthCode) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 space-y-6">
          <div className="space-y-2 text-center">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Connect to GitHub
            </h2>
            <p className="text-sm text-red-500 dark:text-red-400">
              {deviceAuthError}
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onStartDeviceAuth}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Default view — Sign in with GitHub + manual PAT entry
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 space-y-6">
        <div className="space-y-2 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Connect to GitHub
          </h2>
        </div>

        {/* Device flow button — only shown when server has a client ID configured */}
        {deviceAuthAvailable && (
          <>
            <button
              onClick={onStartDeviceAuth}
              className="w-full rounded-lg bg-gray-900 dark:bg-white px-4 py-3 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-100 transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              Sign in with GitHub
            </button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200 dark:border-gray-700" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-2 bg-white dark:bg-gray-900 text-gray-500">
                  or enter a token manually
                </span>
              </div>
            </div>
          </>
        )}

        <div className="space-y-3">
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
              Enter a <strong className="text-gray-700 dark:text-gray-300">classic</strong> Personal Access Token with
              the <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">repo</code> scope.
              Fine-grained tokens are not supported.
            </p>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!token.trim()}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Connect
            </button>
          </div>
        </div>

        <div className="pt-2 border-t border-gray-200 dark:border-gray-800">
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
      </div>
    </div>
  );
}
