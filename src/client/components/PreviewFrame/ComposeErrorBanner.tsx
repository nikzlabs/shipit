import { WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";

/** Maps known Docker/Compose error patterns to user-facing remediation hints. */
export function getComposeErrorHint(error: string): string | null {
  if (error.includes("address pools have been fully subnetted")) {
    return "Your Docker host has run out of network address space. Run \"docker network prune\" to remove unused networks, then retry. To permanently increase the limit, add {\"default-address-pools\": [{\"base\": \"172.16.0.0/12\", \"size\": 24}]} to /etc/docker/daemon.json and restart Docker.";
  }
  if (error.includes("port is already allocated") || error.includes("address already in use")) {
    return "A port required by this service is already in use. Stop the conflicting process or change the port mapping in shipit.yaml, then retry.";
  }
  if (error.includes("no space left on device")) {
    return "Your Docker host is out of disk space. Run \"docker system prune\" to free space, then retry.";
  }
  if (error.includes("pull access denied") || error.includes("repository does not exist")) {
    return "Docker could not pull the required image. Check that the image name in your Dockerfile or shipit.yaml is correct and that you are logged in to the registry.";
  }
  return null;
}

interface ComposeErrorBannerProps {
  /** The raw Docker Compose error text to surface. */
  composeError: string;
  /** Called when the user clicks "Send to agent" to fix the compose error. */
  onSendToAgent?: () => void;
}

/** Overlay shown when Docker Compose fails to bring the stack up. */
export function ComposeErrorBanner({ composeError, onSendToAgent }: ComposeErrorBannerProps) {
  const hint = getComposeErrorHint(composeError);
  return (
    <div className="text-center space-y-3 max-w-lg px-4">
      <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-error)" />
      <p className="text-(--color-error) font-medium">Docker Compose error</p>
      <pre className="text-left text-xs text-(--color-text-secondary) bg-(--color-bg-secondary) rounded p-3 max-h-48 overflow-auto whitespace-pre-wrap border border-(--color-border-secondary)">
        {composeError}
      </pre>
      {hint && (
        <p className="text-left text-xs text-(--color-text-secondary) bg-(--color-warning)/10 rounded p-3 border border-(--color-warning)/25">
          {hint}
        </p>
      )}
      {onSendToAgent && <Button variant="primary" size="md" onClick={onSendToAgent}>Send to agent</Button>}
    </div>
  );
}

interface ComposeHintProps {
  /** Called when the user clicks "Send to agent" to ask it to add compose config. */
  onSendToAgent?: () => void;
}

/** Overlay nudging the user to add a `compose` block to shipit.yaml to enable previews. */
export function ComposeHint({ onSendToAgent }: ComposeHintProps) {
  return (
    <div className="text-center space-y-3 max-w-lg px-4">
      <p className="text-sm text-(--color-text-secondary)">
        Add <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">compose</code> to <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">shipit.yaml</code> to enable previews
      </p>
      {onSendToAgent && <Button variant="primary" size="md" onClick={onSendToAgent}>Send to agent</Button>}
    </div>
  );
}
