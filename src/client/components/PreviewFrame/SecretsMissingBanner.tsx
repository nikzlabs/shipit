import { WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";

/**
 * Banner shown above the preview when one or more `required: true` secrets
 * declared in the compose file have no configured value. Clicking the
 * "Configure" button opens the Secrets settings tab so the user can fill
 * them in without leaving the preview pane.
 *
 * The banner reads from the live `secrets_status` snapshot in preview-store —
 * when the user saves, the orchestrator emits a fresh snapshot with empty
 * `missingRequired` and the banner disappears automatically.
 */
export function SecretsMissingBanner() {
  const missingRequired = usePreviewStore((s) => s.secrets.missingRequired);
  const setProjectSettingsRepoUrl = useUiStore((s) => s.setProjectSettingsRepoUrl);
  const repoUrl = useSessionStore((s) => s.sessions.find((sess) => sess.id === s.sessionId)?.remoteUrl);
  if (missingRequired.length === 0) return null;

  const label = missingRequired.length === 1
    ? `${missingRequired[0]} is required`
    : `${missingRequired.length} required secrets are missing`;

  const openSecrets = () => {
    if (!repoUrl) return;
    // Open the per-repo Project Settings dialog straight to the Secrets tab.
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
        <span className="ml-1 text-(--color-text-secondary)">— this project needs secrets to run.</span>
      </span>
      <Button variant="primary" size="md" onClick={openSecrets} data-testid="secrets-missing-configure">
        Configure
      </Button>
    </div>
  );
}
