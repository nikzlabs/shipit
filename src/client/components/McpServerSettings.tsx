/**
 * Settings → MCP Servers panel (docs/088-mcp-integration).
 *
 * Account-level CRUD for user-configured MCP servers. Server config blobs
 * carry `$secret:` placeholders; the form collects raw secret values
 * separately and the store sends them as a `secrets` map that the server
 * stores in `CredentialStore.agentEnv` (never echoed back). Per-server
 * runtime status arrives via `mcp_server_status` WS messages.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: one-shot fetch of account-level MCP servers on panel mount (external system sync)
import { useEffect, useState } from "react";
import { Button } from "./ui/button.js";
import { useMcpStore } from "../stores/mcp-store.js";
import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpTestResult,
} from "../../server/shared/types.js";

interface KvRow {
  key: string;
  value: string;
}

interface FormState {
  /** Original name when editing (for the PUT :id path). Empty when adding. */
  editingId: string;
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  npmPackage: string;
  /** stdio env vars / http headers — values are raw secrets. */
  kv: KvRow[];
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  editingId: "",
  name: "",
  type: "stdio",
  command: "npx",
  args: "",
  url: "",
  npmPackage: "",
  kv: [],
  enabled: true,
};

// Hyphens are disallowed — the name becomes part of the `mcp__<name>__<KEY>`
// env-var identifier (see services/mcp.ts).
const NAME_RE = /^[a-z][a-z0-9]*$/;

/** Build the config blob + secrets map from form state. */
function buildPayload(form: FormState): {
  config: McpServerConfig;
  secrets: Record<string, string>;
} {
  const secrets: Record<string, string> = {};
  const placeholders: Record<string, string> = {};
  for (const row of form.kv) {
    const k = row.key.trim();
    if (!k) continue;
    const secretKey = `mcp__${form.name}__${k}`;
    placeholders[k] = `$secret:${secretKey}`;
    if (row.value) secrets[secretKey] = row.value;
  }

  if (form.type === "stdio") {
    const config: McpStdioServerConfig = {
      name: form.name,
      type: "stdio",
      command: form.command.trim(),
      enabled: form.enabled,
    };
    const args = form.args
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    if (args.length > 0) config.args = args;
    if (Object.keys(placeholders).length > 0) config.env = placeholders;
    if (form.npmPackage.trim()) config.npmPackage = form.npmPackage.trim();
    return { config, secrets };
  }

  const config: McpHttpServerConfig = {
    name: form.name,
    type: "http",
    url: form.url.trim(),
    enabled: form.enabled,
  };
  if (Object.keys(placeholders).length > 0) config.headers = placeholders;
  return { config, secrets };
}

/** Derive form state from an existing server (secrets are never echoed). */
function formFromServer(server: McpServerConfig): FormState {
  const kvSource =
    server.type === "stdio" ? server.env ?? {} : server.headers ?? {};
  return {
    editingId: server.name,
    name: server.name,
    type: server.type,
    command: server.type === "stdio" ? server.command : "npx",
    args: server.type === "stdio" ? (server.args ?? []).join(" ") : "",
    url: server.type === "http" ? server.url : "",
    npmPackage: server.type === "stdio" ? server.npmPackage ?? "" : "",
    // Keys are kept; values start empty — the user re-enters secrets to change them.
    kv: Object.keys(kvSource).map((key) => ({ key, value: "" })),
    enabled: server.enabled,
  };
}

/**
 * If a server's auth is wired to an OAuth connection (its headers reference a
 * `$platform:<source>` token, as the auto-created "Connect with …" entries
 * are), return that source id — otherwise `null`. Used to badge the row as
 * managed by the connection so it doesn't read as a stray duplicate of the
 * "Connected" provider card above.
 */
function oauthSourceForServer(server: McpServerConfig): string | null {
  if (server.type !== "http" || !server.headers) return null;
  for (const value of Object.values(server.headers)) {
    const m = /\$platform:([a-z][a-z0-9_]*)/.exec(value);
    if (m) return m[1];
  }
  return null;
}

const inputClass =
  "w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-accent)";

function StatusBadge({ name }: { name: string }) {
  const status = useMcpStore((s) => s.statuses[name]);
  if (!status) return null;
  const color =
    status.state === "loaded"
      ? "text-(--color-success)"
      : status.state === "failed"
        ? "text-(--color-error)"
        : status.state === "crashed"
          ? "text-(--color-warning)"
          : "text-(--color-text-tertiary)";
  return (
    <span className={`text-xs ${color}`} title={status.reason}>
      ● {status.state}
      {status.reason ? ` — ${status.reason}` : ""}
    </span>
  );
}

export function McpServerSettings({ hasActiveSession }: { hasActiveSession: boolean }) {
  const servers = useMcpStore((s) => s.servers);
  const loading = useMcpStore((s) => s.loading);
  const error = useMcpStore((s) => s.error);
  const fetchServers = useMcpStore((s) => s.fetchServers);
  const addServer = useMcpStore((s) => s.addServer);
  const updateServer = useMcpStore((s) => s.updateServer);
  const removeServer = useMcpStore((s) => s.removeServer);
  const testServer = useMcpStore((s) => s.testServer);
  const oauthProviders = useMcpStore((s) => s.oauthProviders);
  const oauthError = useMcpStore((s) => s.oauthError);
  const fetchOAuthProviders = useMcpStore((s) => s.fetchOAuthProviders);
  const startOAuthFlow = useMcpStore((s) => s.startOAuthFlow);
  const disconnectOAuth = useMcpStore((s) => s.disconnectOAuth);

  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, McpTestResult | "loading">>({});
  /** Source id currently mid-flow (button disabled, label "Connecting…"). */
  const [oauthInFlight, setOauthInFlight] = useState<string | null>(null);
  /**
   * Per-server in-flight tracking for the row action buttons (Enable/Disable,
   * Delete). Prevents fast double-clicks from firing duplicate
   * updateServer/removeServer requests against the orchestrator.
   */
  const [toggleInFlight, setToggleInFlight] = useState<Record<string, boolean>>({});
  const [deleteInFlight, setDeleteInFlight] = useState<Record<string, boolean>>({});

  // eslint-disable-next-line no-restricted-syntax -- one-shot fetch on mount; the MCP server list is account-level external state
  useEffect(() => {
    void fetchServers();
    void fetchOAuthProviders();
  }, [fetchServers, fetchOAuthProviders]);

  async function connectProvider(source: string) {
    setOauthInFlight(source);
    try {
      const result = await startOAuthFlow(source);
      if (result.ok) {
        // After a successful connect, auto-create a placeholder MCP server
        // entry pointing at the provider's MCP URL with the OAuth bearer
        // header pre-wired. The user can edit the name / disable later.
        const provider = oauthProviders.find((p) => p.id === source);
        if (provider && !servers.some((s) => s.name === provider.defaultServerName)) {
          const config: McpHttpServerConfig = {
            name: provider.defaultServerName,
            type: "http",
            url: provider.mcpUrl,
            headers: { Authorization: `Bearer $platform:${source}` },
            enabled: true,
          };
          try {
            await addServer(config, {});
          } catch {
            // The server might already exist or another validation issue —
            // the OAuth token is still saved and the UI shows "Connected",
            // so this is best-effort.
          }
        }
      }
    } finally {
      setOauthInFlight(null);
    }
  }

  async function disconnectProvider(source: string) {
    setOauthInFlight(source);
    try {
      await disconnectOAuth(source);
    } catch {
      /* error surfaced via store.oauthError */
    } finally {
      setOauthInFlight(null);
    }
  }

  function startAdd() {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
  }

  function startEdit(server: McpServerConfig) {
    setForm(formFromServer(server));
    setFormError(null);
  }

  async function save() {
    if (!form) return;
    if (!NAME_RE.test(form.name)) {
      setFormError("Name must be lowercase alphanumeric, starting with a letter (no hyphens).");
      return;
    }
    if (form.type === "stdio" && !form.command.trim()) {
      setFormError("Command is required for stdio servers.");
      return;
    }
    if (form.type === "http" && !form.url.trim()) {
      setFormError("URL is required for HTTP servers.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const { config, secrets } = buildPayload(form);
      if (form.editingId) {
        await updateServer(form.editingId, config, secrets);
      } else {
        await addServer(config, secrets);
      }
      setForm(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

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

  function updateForm(patch: Partial<FormState>) {
    setForm((f) => (f ? { ...f, ...patch } : f));
  }

  function setKv(idx: number, patch: Partial<KvRow>) {
    setForm((f) => {
      if (!f) return f;
      const kv = [...f.kv];
      kv[idx] = { ...kv[idx], ...patch };
      return { ...f, kv };
    });
  }

  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full" data-testid="mcp-settings">
      <div>
        <h3 className="text-sm font-medium text-(--color-text-primary)">MCP Servers</h3>
        <p className="text-xs text-(--color-text-tertiary) mt-0.5">
          Connect your own Model Context Protocol servers (Linear, Sentry, Notion, …) so the
          agent can use their tools. Configured once per account — available in every session.
        </p>
      </div>

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

      {oauthProviders.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="mcp-oauth-providers">
          <div className="text-xs uppercase tracking-wide text-(--color-text-tertiary)">
            One-click connections
          </div>
          <ul className="flex flex-col gap-2">
            {oauthProviders.map((provider) => {
              const inFlight = oauthInFlight === provider.id;
              const connected = provider.status.connected;
              return (
                <li
                  key={provider.id}
                  className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 flex items-center justify-between gap-3"
                  data-testid={`mcp-oauth-${provider.id}`}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-(--color-text-primary)">
                        {provider.label}
                      </span>
                      {connected && (
                        <span className="text-xs text-(--color-success)">● Connected</span>
                      )}
                    </div>
                    {provider.description && (
                      <p className="text-xs text-(--color-text-tertiary)">
                        {provider.description}
                      </p>
                    )}
                  </div>
                  {connected ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={inFlight}
                      onClick={() => void disconnectProvider(provider.id)}
                    >
                      {inFlight ? "…" : "Disconnect"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={inFlight}
                      onClick={() => void connectProvider(provider.id)}
                    >
                      {inFlight ? "Connecting…" : `Connect ${provider.label}`}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {loading && servers.length === 0 ? (
        <p className="text-sm text-(--color-text-tertiary)">Loading…</p>
      ) : servers.length === 0 && !form ? (
        <p className="text-sm text-(--color-text-tertiary)">No MCP servers configured yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((server) => {
            const result = testResults[server.name];
            const isTesting = result === "loading";
            const isToggling = toggleInFlight[server.name];
            const isDeleting = deleteInFlight[server.name];
            const oauthSource = oauthSourceForServer(server);
            const managedBy = oauthSource
              ? oauthProviders.find((p) => p.id === oauthSource)?.label ?? null
              : null;
            return (
              <li
                key={server.name}
                className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 flex flex-col gap-2"
                data-testid={`mcp-server-${server.name}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-(--color-text-primary) truncate">
                      {server.name}
                    </span>
                    <span className="text-xs text-(--color-text-tertiary)">{server.type}</span>
                    {managedBy && (
                      <span
                        className="text-xs text-(--color-text-tertiary)"
                        title={`Authentication is managed by your ${managedBy} connection above. Use Disconnect there to revoke access.`}
                      >
                        · via {managedBy} connection
                      </span>
                    )}
                    {!server.enabled && (
                      <span className="text-xs text-(--color-text-tertiary)">(disabled)</span>
                    )}
                    <StatusBadge name={server.name} />
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void toggleEnabled(server)}
                      disabled={isToggling || isDeleting}
                    >
                      {isToggling ? "…" : server.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void runTest(server)}
                      disabled={!hasActiveSession || isTesting || isDeleting}
                      title={hasActiveSession ? undefined : "Start a session to test"}
                    >
                      {isTesting ? "Testing…" : "Test"}
                    </Button>
                    {/* OAuth-managed servers have their URL/auth wired from the
                        connection — editing them by hand would only desync the
                        pairing, so the Edit affordance is hidden for them. */}
                    {!managedBy && (
                      <Button size="sm" variant="ghost" onClick={() => startEdit(server)} disabled={isDeleting}>
                        Edit
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void deleteServer(server.name)}
                      disabled={isDeleting}
                    >
                      {isDeleting ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-(--color-text-tertiary) truncate">
                  {server.type === "stdio"
                    ? `${server.command} ${(server.args ?? []).join(" ")}`
                    : server.url}
                </p>
                {result === "loading" && (
                  <p className="text-xs text-(--color-text-tertiary)">Testing…</p>
                )}
                {result && result !== "loading" && result.ok && (
                  <p className="text-xs text-(--color-success)">
                    Connected — {result.tools.length} tool(s):{" "}
                    {result.tools.map((t) => t.name).join(", ") || "none"}
                  </p>
                )}
                {result && result !== "loading" && !result.ok && (
                  <p className="text-xs text-(--color-error)">Test failed: {result.error}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {form ? (
        <div
          className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 flex flex-col gap-3"
          data-testid="mcp-server-form"
        >
          <h4 className="text-sm font-medium text-(--color-text-primary)">
            {form.editingId ? `Edit "${form.editingId}"` : "Add MCP Server"}
          </h4>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-(--color-text-secondary)">Name</span>
            <input
              className={inputClass}
              value={form.name}
              placeholder="linear"
              onChange={(e) => updateForm({ name: e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-(--color-text-secondary)">Type</span>
            <select
              className={inputClass}
              value={form.type}
              onChange={(e) => updateForm({ type: e.target.value as "stdio" | "http" })}
            >
              <option value="stdio">stdio (spawned process)</option>
              <option value="http">http (remote endpoint)</option>
            </select>
          </label>

          {form.type === "stdio" ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-(--color-text-secondary)">Command</span>
                <input
                  className={inputClass}
                  value={form.command}
                  placeholder="npx"
                  onChange={(e) => updateForm({ command: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-(--color-text-secondary)">
                  Arguments (space-separated)
                </span>
                <input
                  className={inputClass}
                  value={form.args}
                  placeholder="-y @anthropic-ai/linear-mcp"
                  onChange={(e) => updateForm({ args: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-(--color-text-secondary)">
                  npm package (optional — installed at session start)
                </span>
                <input
                  className={inputClass}
                  value={form.npmPackage}
                  placeholder="@anthropic-ai/linear-mcp"
                  onChange={(e) => updateForm({ npmPackage: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-(--color-text-secondary)">URL</span>
              <input
                className={inputClass}
                value={form.url}
                placeholder="https://mcp.linear.app/mcp"
                onChange={(e) => updateForm({ url: e.target.value })}
              />
            </label>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-xs text-(--color-text-secondary)">
              {form.type === "stdio" ? "Environment variables" : "Headers"} (stored as secrets)
            </span>
            {form.kv.map((row, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <input
                  className={inputClass}
                  value={row.key}
                  placeholder={form.type === "stdio" ? "LINEAR_API_KEY" : "Authorization"}
                  onChange={(e) => setKv(idx, { key: e.target.value })}
                />
                <input
                  className={inputClass}
                  type="password"
                  value={row.value}
                  placeholder={form.editingId ? "(unchanged)" : "value"}
                  onChange={(e) => setKv(idx, { value: e.target.value })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    updateForm({ kv: form.kv.filter((_, i) => i !== idx) })
                  }
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => updateForm({ kv: [...form.kv, { key: "", value: "" }] })}
            >
              + Add {form.type === "stdio" ? "variable" : "header"}
            </Button>
          </div>

          {formError && <p className="text-xs text-(--color-error)">{formError}</p>}

          <div className="flex gap-2">
            <Button size="md" variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button size="md" variant="ghost" onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="md" variant="secondary" onClick={startAdd} data-testid="mcp-add-server">
          + Add MCP Server
        </Button>
      )}
    </div>
  );
}
