import type { SecretRequirement } from "../domain-types.js";
import type { PluginCredentialGroup } from "../../plugin-credentials.js";

export interface WsInstallStatus {
  type: "install_status";
  sessionId: string;
  status: "running" | "complete" | "error" | "skipped";
  command?: string;
  message?: string;
}

export interface WsMcpServerStatus {
  type: "mcp_server_status";
  sessionId: string;
  name: string;
  state: "loaded" | "failed" | "crashed" | "disabled";
  reason?: string;
}

export interface WsInstallLog {
  type: "install_log";
  sessionId: string;
  text: string;
  stream: "stdout" | "stderr";
}

export type ComposeServiceStatus = "stopped" | "starting" | "running" | "error";
export type ComposeServicePreviewMode = "auto" | "manual";

export interface ComposeServiceOriginView {
  kind: "plugin";
  repo: string;
  alias: string;
  plugin: string;
}

export interface WsServiceStatus {
  type: "service_status";
  sessionId: string;
  name: string;
  status: ComposeServiceStatus;
  /** Browser routing key: container port for project services, published port for plugins. */
  port?: number;
  preview: ComposeServicePreviewMode;
  error?: string;
  origin?: ComposeServiceOriginView;
}

export interface WsServiceList {
  type: "service_list";
  sessionId: string;
  services: {
    name: string;
    status: ComposeServiceStatus;
    /** Browser routing key; see WsServiceStatus.port. */
    port?: number;
    preview: ComposeServicePreviewMode;
    error?: string;
    origin?: ComposeServiceOriginView;
  }[];
}

/** Refetch GET /api/plugin-repos after activation. */
export interface WsPluginReposUpdated {
  type: "plugin_repos_updated";
  sessionId: string;
}

export interface WsComposeError {
  type: "compose_error";
  sessionId: string;
  message: string;
}

export interface WsStackError {
  type: "stack_error";
  sessionId: string;
  message: string;
}

export interface WsComposeNotConfigured {
  type: "compose_not_configured";
  sessionId: string;
}

export interface WsSecretsStatus {
  type: "secrets_status";
  sessionId: string;
  /** One row per name, shared by all service and plugin claimants. */
  declared: (SecretRequirement & { services: string[]; plugins?: string[] })[];
  /** Includes required and optional secrets. */
  missingByService: Record<string, string[]>;
  missingRequired: string[];
  /** Project secrets only; platform credentials cannot satisfy these. Excluded from missingRequired. */
  plugins: PluginCredentialGroup[];
}

export interface WsServiceOom {
  type: "service_oom";
  sessionId: string;
  serviceName?: string;
  containerId: string;
}
