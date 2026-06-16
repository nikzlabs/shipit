import { Button } from "../ui/button.js";
import { StatusBadge } from "./McpServerRow.js";
import { McpTestResult } from "./McpTestResult.js";
import { isAuthRequired, oauthSourceForServer } from "./utils/auth.js";
import type {
  McpOAuthProviderInfo,
  McpServerStatusEntry,
} from "../../stores/mcp-store.js";
import type {
  McpServerConfig,
  McpTestResult as McpTestResultData,
} from "../../../server/shared/types.js";

/**
 * "One-click connections" — the OAuth provider cards. When a provider is
 * connected, its auto-created MCP server row is folded into the card (Test /
 * Enable / Disable controls live here) and a stale auth-required status
 * downgrades "Connected" to a Reconnect CTA.
 */
export function OAuthProviderCards({
  providers,
  servers,
  statuses,
  testResults,
  toggleInFlight,
  oauthInFlight,
  hasActiveSession,
  onConnect,
  onDisconnect,
  onToggle,
  onTest,
}: {
  providers: McpOAuthProviderInfo[];
  servers: McpServerConfig[];
  statuses: Record<string, McpServerStatusEntry>;
  testResults: Record<string, McpTestResultData | "loading">;
  toggleInFlight: Record<string, boolean>;
  oauthInFlight: string | null;
  hasActiveSession: boolean;
  onConnect: (source: string) => void;
  onDisconnect: (source: string) => void;
  onToggle: (server: McpServerConfig) => void;
  onTest: (server: McpServerConfig) => void;
}) {
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="mcp-oauth-providers">
      <div className="text-xs uppercase tracking-wide text-(--color-text-tertiary)">
        One-click connections
      </div>
      <ul className="flex flex-col gap-2">
        {providers.map((provider) => {
          const inFlight = oauthInFlight === provider.id;
          const connected = provider.status.connected;
          // When connected, fold the auto-created MCP server row into this
          // card so the user sees one element per provider instead of a
          // duplicated provider card + server row pair.
          const managedServer = connected
            ? servers.find((s) => oauthSourceForServer(s) === provider.id)
            : undefined;
          const result = managedServer ? testResults[managedServer.name] : undefined;
          const isTesting = result === "loading";
          const isToggling = managedServer ? toggleInFlight[managedServer.name] : false;
          // Stored tokens exist (`connected`) but the MCP server rejected
          // them (`failed — authentication required`). The two signals
          // are otherwise independent — without this reconciliation the
          // card would say "● Connected" while the server row says
          // "● failed — authentication required", which is what the user
          // hit. Downgrade the badge and surface a Reconnect CTA.
          const serverStatus: McpServerStatusEntry | undefined = managedServer
            ? statuses[managedServer.name]
            : undefined;
          const authExpired = connected && isAuthRequired(serverStatus);
          return (
            <li
              key={provider.id}
              className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 flex flex-col gap-2"
              data-testid={`mcp-oauth-${provider.id}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-(--color-text-primary)">
                      {provider.label}
                    </span>
                    {connected && !authExpired && (
                      <span className="text-xs text-(--color-success)">● Connected</span>
                    )}
                    {authExpired && (
                      <span
                        className="text-xs text-(--color-error)"
                        title={serverStatus?.reason}
                      >
                        ● Authentication required — reconnect
                      </span>
                    )}
                    {/* When auth is expired the dedicated badge above
                        already says what's wrong; rendering the generic
                        StatusBadge too would just duplicate the text. */}
                    {managedServer && !authExpired && (
                      <StatusBadge name={managedServer.name} />
                    )}
                    {managedServer && !managedServer.enabled && (
                      <span className="text-xs text-(--color-text-tertiary)">(disabled)</span>
                    )}
                  </div>
                  {provider.description && (
                    <p className="text-xs text-(--color-text-tertiary)">
                      {provider.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {managedServer && !authExpired && (
                    <>
                      <Button
                        size="md"
                        variant="ghost"
                        onClick={() => onToggle(managedServer)}
                        disabled={isToggling || inFlight}
                      >
                        {isToggling ? "…" : managedServer.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="md"
                        variant="ghost"
                        onClick={() => onTest(managedServer)}
                        disabled={!hasActiveSession || isTesting || inFlight}
                        title={hasActiveSession ? undefined : "Start a session to test"}
                      >
                        {isTesting ? "Testing…" : "Test"}
                      </Button>
                    </>
                  )}
                  {authExpired ? (
                    <>
                      <Button
                        size="md"
                        variant="primary"
                        disabled={inFlight}
                        onClick={() => onConnect(provider.id)}
                      >
                        {inFlight ? "Connecting…" : "Reconnect"}
                      </Button>
                      <Button
                        size="md"
                        variant="ghost"
                        disabled={inFlight}
                        onClick={() => onDisconnect(provider.id)}
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : connected ? (
                    <Button
                      size="md"
                      variant="ghost"
                      disabled={inFlight}
                      onClick={() => onDisconnect(provider.id)}
                    >
                      {inFlight ? "…" : "Disconnect"}
                    </Button>
                  ) : (
                    <Button
                      size="md"
                      variant="primary"
                      disabled={inFlight}
                      onClick={() => onConnect(provider.id)}
                    >
                      {inFlight ? "Connecting…" : `Connect ${provider.label}`}
                    </Button>
                  )}
                </div>
              </div>
              <McpTestResult result={result} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
