/**
 * Shared types and error class for the service layer.
 */

import type { AgentId } from "../../shared/types.js";
import type { SessionInfo, ProjectTemplate, RepoInfo } from "../../shared/types.js";

// ---- Types for service function results ----

export interface AgentInfo {
  id: AgentId;
  name: string;
  installed: boolean;
  authConfigured: boolean;
  models: string[];
}

export interface GlobalSettings {
  gitIdentity: { name: string; email: string };
  systemPrompt: string;
  agents: AgentInfo[];
  defaultAgentId: AgentId;
}

export interface GitHubStatus {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export interface BootstrapData {
  sessions: SessionInfo[];
  repos: RepoInfo[];
  agents: AgentInfo[];
  defaultAgentId: AgentId;
  templates: Array<Omit<ProjectTemplate, "files">>;
  githubStatus: GitHubStatus;
  settings: GlobalSettings;
}

// ---- Error type for service-level errors with HTTP status codes ----

export class ServiceError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
