import { useState } from "react";

export interface GitIdentityOverlayProps {
  onSubmit: (name: string, email: string) => void;
}

export function GitIdentityOverlay({ onSubmit }: GitIdentityOverlayProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const canSubmit = name.trim().length > 0 && email.trim().length > 0;

  const handleSubmit = () => {
    if (canSubmit) {
      onSubmit(name.trim(), email.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmit) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 space-y-6">
        <div className="space-y-2 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Git Identity Required
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Your workspace needs a git identity for automatic commits.
            Enter your name and email to continue.
          </p>
        </div>

        <div className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Your Name"
            className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="you@example.com"
            className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
