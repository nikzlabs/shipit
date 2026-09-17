/**
 * The GitHub credential row (docs/308-data-driven-settings inventory.md P2, P10,
 * P13, req 3).
 *
 * Its declaration carries the address that stores the token, so this names no
 * path and no payload field. What keeps it a component rather than a generated
 * control is the plan's slice 5 note: the write's answer is used, removing is a
 * second address, and what the card shows is the account rather than the value.
 */

import { useState } from "react";
import { GithubLogoIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { usePrStore } from "../../../stores/pr-store.js";
import { GitHubTokenForm } from "../../GitHubTokenForm.js";
import { bindSetting } from "../setting-binding.js";
import { ConnectedServiceCard, ConnectionStatus } from "./ConnectedServiceCard.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

export function GitHubConnection({ settingKey }: { settingKey: SettingKey }) {
  const status = useSettingsStore((s) => s.githubStatus);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const connected = status.authenticated;

  /*
    The repositories come back with the token and are what the Add Repository
    dialog lists until a search replaces them, so they are seeded here rather
    than left for a second request nobody makes. `false` is the form's signal to
    say the token was refused, which the dialog used to swallow: its caller
    returned `undefined` whatever happened.
  */
  const connect = async (token: string): Promise<boolean> => {
    setConnecting(true);
    try {
      const result = await useSettingsStore.getState().submitGitHubToken(token);
      if (!result) return false;
      usePrStore.getState().setImportSearchResults(result.repos);
      return true;
    } finally {
      setConnecting(false);
    }
  };

  /*
    A refused logout used to fail silently — the card simply stayed connected
    with nothing said — and the status line is the only thing the user has,
    because the token is never read back. The store action leaves the status
    alone when the route refuses, so the card stays truthful and says why.
  */
  const disconnect = () => {
    if (!confirmingLogout) {
      setConfirmingLogout(true);
      return;
    }
    setDisconnecting(true);
    setConfirmingLogout(false);
    void useSettingsStore.getState().gitHubLogout()
      .catch((err: unknown) => {
        useUiStore.getState().setToast({ message: "Failed to disconnect GitHub" });
        console.error("[settings] disconnecting GitHub failed:", err);
      })
      .finally(() => { setDisconnecting(false); });
  };

  return (
    <ConnectedServiceCard
      settingKey={settingKey}
      mark={<GithubLogoIcon size={ICON_SIZE.MD} weight="fill" />}
      testId="settings-github"
      headerAction={connected ? (
        <button
          onClick={disconnect}
          onBlur={() => { if (!disconnecting) setConfirmingLogout(false); }}
          /*
            The two writes are one credential and must not overlap: a validation
            that lands after a logout stores a token the user has just removed,
            and a connect's answer arriving late puts a connection back on screen
            that the server no longer holds. Both are one card's state, so
            disabling each other is the whole of the fix.
          */
          disabled={disconnecting || connecting}
          className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
            disconnecting || connecting
              ? "cursor-not-allowed border-(--color-border-secondary) bg-(--color-bg-elevated) text-(--color-text-tertiary) opacity-50"
              : confirmingLogout
                ? "border-(--color-error)/50 bg-(--color-error-subtle) text-(--color-error)"
                : "border-(--color-border-secondary) bg-(--color-bg-elevated) text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
          }`}
          data-testid="settings-disconnect"
          /* The visible text carries the confirmation step, so the accessible
             name has to carry it too — otherwise the second press disconnects
             with no warning a screen reader ever gave. */
          aria-label={
            disconnecting
              ? "Disconnecting GitHub"
              : confirmingLogout ? "Click again to disconnect GitHub" : "Disconnect GitHub"
          }
          {...bindSetting(settingKey)}
        >
          {disconnecting ? "Disconnecting..." : confirmingLogout ? "Click again to disconnect" : "Disconnect"}
        </button>
      ) : undefined}
    >
      <ConnectionStatus
        connected={connected}
        detail={connected ? `Connected as ${status.username ?? "GitHub"}` : "Not connected"}
        testId="settings-github-status"
      />
      <GitHubTokenForm
        onSubmit={connect}
        autoFocus={false}
        disabled={disconnecting}
        {...(connected ? { submitLabel: "Replace" } : {})}
      />
    </ConnectedServiceCard>
  );
}
