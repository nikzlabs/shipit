// eslint-disable-next-line no-restricted-imports -- useEffect: one-shot fetch of account-level MCP servers on panel mount (external system sync)
import { useEffect, useState } from "react";
import { Button } from "../ui/button.js";
import { useMcpStore } from "../../stores/mcp-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { SettingCopy } from "../Settings/declared.js";
import { OAuthProviderCards } from "./OAuthProviderCards.js";
import { McpServerRow } from "./McpServerRow.js";
import { McpServerForm } from "./McpServerForm.js";
import { useMcpFormState } from "./hooks/useMcpFormState.js";
import { useMcpOAuthFlow } from "./hooks/useMcpOAuthFlow.js";
import { oauthSourceForServer } from "./utils/auth.js";
import type { McpServerConfig, McpTestResult } from "../../../server/shared/types.js";

/**
 * The panel `mcp.servers` and `mcp.oauthProvider` name
 * (docs/308-data-driven-settings).
 *
 * A registered component takes the setting's key and nothing else, so whether a
 * session is running — which decides whether there is anywhere to run a test —
 * is read here rather than drilled in from `App.tsx`.
 */
export function McpServerSettings() {
  const hasActiveSession = useSessionStore((s) => s.sessionId !== undefined);
  const servers = useMcpStore((s) => s.servers);
  const loading = useMcpStore((s) => s.loading);
  const error = useMcpStore((s) => s.error);
  const fetchServers = useMcpStore((s) => s.fetchServers);
  const updateServer = useMcpStore((s) => s.updateServer);
  const removeServer = useMcpStore((s) => s.removeServer);
  const testServer = useMcpStore((s) => s.testServer);
  const oauthProviders = useMcpStore((s) => s.oauthProviders);
  const oauthError = useMcpStore((s) => s.oauthError);
  const fetchOAuthProviders = useMcpStore((s) => s.fetchOAuthProviders);
  const statuses = useMcpStore((s) => s.statuses);

  const { form, formError, saving, startAdd, startEdit, cancel, updateForm, save } =
    useMcpFormState();
  const { oauthInFlight, connectProvider, disconnectProvider } = useMcpOAuthFlow();

  const [testResults, setTestResults] = useState<Record<string, McpTestResult | "loading">>({});
  const [toggleInFlight, setToggleInFlight] = useState<Record<string, boolean>>({});
  const [deleteInFlight, setDeleteInFlight] = useState<Record<string, boolean>>({});

  // eslint-disable-next-line no-restricted-syntax -- one-shot fetch on mount; the MCP server list is account-level external state
  useEffect(() => {
    void fetchServers();
    void fetchOAuthProviders();
  }, [fetchServers, fetchOAuthProviders]);

  async function toggleEnabled(server: McpServerConfig) {
    if (toggleInFlight[server.name]) return;
    setToggleInFlight((r) => ({ ...r, [server.name]: true }));
    try {
      await updateServer(server.name, { ...server, enabled: !server.enabled }, {});
    } catch {
      /* error surfaced via store */
    } finally {
      setToggleInFlight((r) => {
        const { [server.name]: _, ...rest } = r;
        return rest;
      });
    }
  }

  async function runTest(server: McpServerConfig) {
    if (testResults[server.name] === "loading") return;
    setTestResults((r) => ({ ...r, [server.name]: "loading" }));
    try {
      const result = await testServer(server.name);
      setTestResults((r) => ({ ...r, [server.name]: result }));
    } catch (err) {
      setTestResults((r) => ({
        ...r,
        [server.name]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  async function deleteServer(name: string) {
    if (deleteInFlight[name]) return;
    setDeleteInFlight((r) => ({ ...r, [name]: true }));
    try {
      await removeServer(name);
    } catch {
      /* error surfaced via store */
    } finally {
      setDeleteInFlight((r) => {
        const { [name]: _, ...rest } = r;
        return rest;
      });
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="mcp-settings">
      <SettingCopy settingKey="mcp.servers" heading />

      {error && (
        <div className="rounded-md border border-(--color-error) bg-(--color-bg-secondary) px-3 py-2 text-xs text-(--color-error)">
          {error}
        </div>
      )}

      {oauthError && (
        <div className="rounded-md border border-(--color-error) bg-(--color-bg-secondary) px-3 py-2 text-xs text-(--color-error)">
          {oauthError}
        </div>
      )}

      <OAuthProviderCards
        providers={oauthProviders}
        servers={servers}
        statuses={statuses}
        testResults={testResults}
        toggleInFlight={toggleInFlight}
        oauthInFlight={oauthInFlight}
        hasActiveSession={hasActiveSession}
        onConnect={(id) => void connectProvider(id)}
        onDisconnect={(id) => void disconnectProvider(id)}
        onToggle={(server) => void toggleEnabled(server)}
        onTest={(server) => void runTest(server)}
      />

      {(() => {
        // Disconnected provider entries remain visible so they can be deleted.
        const connectedSources = new Set(
          oauthProviders.filter((p) => p.status.connected).map((p) => p.id),
        );
        const visibleServers = servers.filter((s) => {
          const src = oauthSourceForServer(s);
          return !src || !connectedSources.has(src);
        });
        if (loading && visibleServers.length === 0) {
          return <p className="text-sm text-(--color-text-tertiary)">Loading…</p>;
        }
        if (visibleServers.length === 0 && !form) {
          return (
            <p className="text-sm text-(--color-text-tertiary)">
              No MCP servers configured yet.
            </p>
          );
        }
        return (
          <ul className="flex flex-col gap-2">
            {visibleServers.map((server) => {
              const oauthSource = oauthSourceForServer(server);
              const managedBy = oauthSource
                ? oauthProviders.find((p) => p.id === oauthSource)?.label ?? null
                : null;
              return (
                <McpServerRow
                  key={server.name}
                  server={server}
                  result={testResults[server.name]}
                  isToggling={toggleInFlight[server.name]}
                  isDeleting={deleteInFlight[server.name]}
                  hasActiveSession={hasActiveSession}
                  managedBy={managedBy}
                  onToggle={() => void toggleEnabled(server)}
                  onTest={() => void runTest(server)}
                  onEdit={() => startEdit(server)}
                  onDelete={() => void deleteServer(server.name)}
                />
              );
            })}
          </ul>
        );
      })()}

      {form ? (
        <McpServerForm
          form={form}
          formError={formError}
          saving={saving}
          onUpdate={updateForm}
          onSave={() => void save()}
          onCancel={cancel}
        />
      ) : (
        <Button
          size="md"
          variant="secondary"
          onClick={startAdd}
          data-testid="mcp-add-server"
        >
          + Add MCP Server
        </Button>
      )}
    </div>
  );
}
