import { useState, useRef } from "react";
import { Button } from "../../ui/button.js";
import { SettingsTabPane } from "../SettingsTabPane.js";
import { bindSetting, settingCopy } from "../declared.js";

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

  const prevGitIdentityRef = useRef(gitIdentity);
  if (prevGitIdentityRef.current.name !== gitIdentity.name || prevGitIdentityRef.current.email !== gitIdentity.email) {
    prevGitIdentityRef.current = gitIdentity;
    setGitName(gitIdentity.name);
    setGitEmail(gitIdentity.email);
  }

  return (
    <SettingsTabPane
      footer={
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            onGitIdentitySave(gitName.trim(), gitEmail.trim());
            setGitSaved(true);
          }}
          disabled={!gitName.trim() || !gitEmail.trim()}
          className="rounded-md"
          data-testid="settings-git-save"
          aria-label={gitSaved ? "Git identity saved" : "Save git identity"}
          {...bindSetting("git.identity")}
        >
          {gitSaved ? "Saved" : "Save"}
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Name and email are one declaration, because they are written
            together — `value-types.ts` → `gitIdentity`. Both boxes bind to it. */}
        <p className="text-sm text-(--color-text-secondary)" data-setting-description="git.identity">
          {settingCopy("git.identity").description}
        </p>

        <div>
          <label className="block text-sm font-medium text-(--color-text-primary) mb-1" htmlFor="git-identity-name">Name</label>
          <input
            id="git-identity-name"
            type="text"
            value={gitName}
            onChange={(e) => { setGitName(e.target.value); setGitSaved(false); }}
            placeholder="Your Name"
            className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
            data-testid="settings-git-name"
            {...bindSetting("git.identity")}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-(--color-text-primary) mb-1" htmlFor="git-identity-email">Email</label>
          <input
            id="git-identity-email"
            type="email"
            value={gitEmail}
            onChange={(e) => { setGitEmail(e.target.value); setGitSaved(false); }}
            placeholder="you@example.com"
            className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
            data-testid="settings-git-email"
            {...bindSetting("git.identity")}
          />
        </div>
      </div>
    </SettingsTabPane>
  );
}
