import { WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useAnyListSessionRow } from "../ScheduledRunBanner.js";

export function SecretsMissingBanner() {
  const missingRequired = usePreviewStore((s) => s.secrets.missingRequired);
  if (missingRequired.length === 0) return null;
  return <MissingSecretsAlert missingRequired={missingRequired} />;
}

function MissingSecretsAlert({ missingRequired }: { missingRequired: string[] }) {
  const setProjectSettingsRepoUrl = useUiStore((s) => s.setProjectSettingsRepoUrl);
  const sessionId = useSessionStore((s) => s.sessionId);
  // A session past the sidebar's cap, or archived, has no sidebar row; a
  // sidebar-only lookup left Configure doing nothing for it.
  const session = useAnyListSessionRow(sessionId);
  const repoUrl = session?.remoteUrl || undefined;
  // Secrets are stored per repository, so a session without one has nowhere to put them.
  const noRepo = !!session && !repoUrl;

  const label = missingRequired.length === 1
    ? `${missingRequired[0]} is required`
    : `${missingRequired.length} required secrets are missing`;

  const openSecrets = () => {
    if (!repoUrl) return;

    setProjectSettingsRepoUrl(repoUrl, "secrets");
  };

  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-3 py-1.5 border-b border-(--color-warning)/40 bg-(--color-warning)/10 text-xs text-(--color-text-primary)"
      data-testid="secrets-missing-banner"
    >
      <WarningIcon size={ICON_SIZE.SM} className="text-(--color-warning) shrink-0" />
      <span className="flex-1 truncate">
        {label}
        <span className="ml-1 text-(--color-text-secondary)">
          {noRepo
            ? "— secrets are saved per repository, and this session has no repository."
            : "— this project needs secrets to run."}
        </span>
      </span>
      {!noRepo && (
        <Button
          variant="primary"
          size="md"
          onClick={openSecrets}
          disabled={!repoUrl}
          data-testid="secrets-missing-configure"
        >
          Configure
        </Button>
      )}
    </div>
  );
}
