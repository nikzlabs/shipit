// ---- Deployment data types ----

export interface DeployTargetInfo {
  id: string;
  name: string;
  description: string;
  iconUrl?: string;
  configFields: ConfigField[];
  supportsPreview: boolean;
}

export interface ConfigField {
  key: string;
  label: string;
  required: boolean;
  sensitive: boolean;
  helpUrl?: string;
  helpText?: string;
  placeholder?: string;
}

export interface DeploymentRecord {
  id: string;
  targetId: string;
  environment: "production" | "preview";
  url: string;
  commitHash?: string;
  commitMessage?: string;
  timestamp: string;
  durationMs: number;
  status: "success" | "failed";
  error?: string;
}

// ---- Deployment client → server messages ----

export interface WsDeployConfigure {
  type: "deploy_configure";
  targetId: string;
  credentials: Record<string, string>;
  projectName?: string;
}

export interface WsInitiateDeploy {
  type: "initiate_deploy";
  targetId: string;
  environment?: "production" | "preview";
}

export interface WsCancelDeploy {
  type: "cancel_deploy";
}

export interface WsDeleteDeployConfig {
  type: "delete_deploy_config";
  targetId: string;
}

// ---- Deployment server → client messages ----

export interface WsDeployTargets {
  type: "deploy_targets";
  targets: DeployTargetInfo[];
}

export interface WsDeployConfigSaved {
  type: "deploy_config_saved";
  targetId: string;
}

export interface WsProjectSettings {
  type: "project_settings";
  deployConfig: Record<string, { configured: boolean; projectName?: string }>;
}

export interface WsDeployStatus {
  type: "deploy_status";
  phase: "building" | "deploying" | "complete" | "error";
}

export interface WsDeployComplete {
  type: "deploy_complete";
  url: string;
  targetId: string;
  environment: "production" | "preview";
  durationMs: number;
}

export interface WsDeployError {
  type: "deploy_error";
  message: string;
  phase: "building" | "deploying";
}

export interface WsDeployHistory {
  type: "deploy_history";
  deployments: DeploymentRecord[];
}
