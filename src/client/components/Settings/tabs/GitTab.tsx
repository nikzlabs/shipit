import { useState, useRef } from "react";
import { Button } from "../../ui/button.js";

export function GitTab({
  gitIdentity,
  onGitIdentitySave,
}: {
  gitIdentity: { name: string; email: string };
  onGitIdentitySave: (name: string, email: string) => void;
}) {
  const [gitName, setGitName] = useState(gitIdentity.name);
  const [gitEmail, setGitEmail] = useState(gitIdentity.email);
  const [gitSaved, setGitSaved] = useState(false);

  // Sync local git identity state when props change (e.g. fetched from server)
  const prevGitIdentityRef = useRef(gitIdentity);
  if (prevGitIdentityRef.current.name !== gitIdentity.name || prevGitIdentityRef.current.email !== gitIdentity.email) {
    prevGitIdentityRef.current = gitIdentity;
    setGitName(gitIdentity.name);
    setGitEmail(gitIdentity.email);
  }

  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
      <div className="space-y-4">
        <p className="text-sm text-(--color-text-secondary)">
          Git identity used for automatic commits in all sessions.
        </p>

        <div>
          <label className="block text-sm font-medium text-(--color-text-primary) mb-1">Name</label>
          <input
            type="text"
            value={gitName}
            onChange={(e) => { setGitName(e.target.value); setGitSaved(false); }}
            placeholder="Your Name"
            className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
            data-testid="settings-git-name"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-(--color-text-primary) mb-1">Email</label>
          <input
            type="email"
            value={gitEmail}
            onChange={(e) => { setGitEmail(e.target.value); setGitSaved(false); }}
            placeholder="you@example.com"
            className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
            data-testid="settings-git-email"
          />
        </div>

        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            onGitIdentitySave(gitName.trim(), gitEmail.trim());
            setGitSaved(true);
          }}
          disabled={!gitName.trim() || !gitEmail.trim()}
          className="w-full rounded-lg"
          data-testid="settings-git-save"
        >
          {gitSaved ? "Saved" : "Save"}
        </Button>
      </div>
    </div>
  );
}
