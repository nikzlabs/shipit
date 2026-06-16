import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
} from "../../../../server/shared/types.js";

export interface KvRow {
  key: string;
  value: string;
}

export interface FormState {
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

/** Build the config blob + secrets map from form state. */
export function buildPayload(form: FormState): {
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
    // Keys are kept; values start empty — the user re-enters secrets to change them.
    kv: Object.keys(kvSource).map((key) => ({ key, value: "" })),
    enabled: server.enabled,
  };
}
