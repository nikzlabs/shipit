import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
} from "../../../../server/shared/types.js";

export interface KvRow {
  key: string;
  value: string;
  /**
   * The key this row was loaded with, absent on a row the user added. A blank
   * value means "unchanged" only while the key still matches it: the stored
   * secret is named after the key, so editing the key points the row at a
   * secret that was never stored (planning#565).
   */
  originalKey?: string;
  /**
   * The reference expression this row was loaded with. The form shows only the
   * key, so re-deriving the value would flatten anything it cannot represent —
   * a `Bearer ` prefix, a secret named unlike its key, an OAuth `$platform:`
   * link — and the save would then delete the credential it stopped referring
   * to (planning#565).
   */
  originalValue?: string;
}

export interface FormState {
  editingId: string;
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  npmPackage: string;
  kv: KvRow[];
  enabled: boolean;
}

export const EMPTY_FORM: FormState = {
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

/**
 * The server carries the stored values across a rename and moves the references
 * in the config it stores; the submitted secret keys have to move with them,
 * because the API accepts only keys in the server's own namespace.
 */
function moveSecretNamespace(expression: string, from: string, to: string): string {
  if (!from || from === to) return expression;
  return expression.replaceAll(`$secret:mcp__${from}__`, () => `$secret:mcp__${to}__`);
}

/** The one key in this server's namespace an expression refers to, if it refers to just one. */
function soleSecretKey(expression: string, serverName: string): string | null {
  const prefix = `mcp__${serverName}__`;
  const keys = [...expression.matchAll(/\$secret:([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((m) => m[1])
    .filter((key) => key.startsWith(prefix));
  return keys.length === 1 ? keys[0] : null;
}

export function buildPayload(form: FormState): {
  config: McpServerConfig;
  secrets: Record<string, string>;
} {
  const secrets: Record<string, string> = {};
  const placeholders: Record<string, string> = {};
  for (const row of form.kv) {
    const k = row.key.trim();
    if (!k) continue;
    const derived = `mcp__${form.name}__${k}`;
    // A row loaded from the server keeps the expression it came with, so a shape
    // the form cannot show survives an edit that does not touch it.
    const carried =
      row.originalKey === k && row.originalValue
        ? moveSecretNamespace(row.originalValue, form.editingId, form.name)
        : null;
    // A typed value replaces the secret THIS row refers to; naming it after the
    // row's key would land it on whatever else is called that. With no reference
    // to fill — a new row, an OAuth-managed header — the key derives one, as before.
    const target = carried && row.value ? soleSecretKey(carried, form.name) : null;
    placeholders[k] = carried && (!row.value || target) ? carried : `$secret:${derived}`;
    if (row.value) secrets[target ?? derived] = row.value;
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

export function formFromServer(server: McpServerConfig): FormState {
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
    // Never echo stored secret values — only the references to them.
    kv: Object.entries(kvSource).map(([key, expression]) => ({
      key,
      value: "",
      originalKey: key,
      originalValue: expression,
    })),
    enabled: server.enabled,
  };
}
