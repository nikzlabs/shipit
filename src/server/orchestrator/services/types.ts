/**
 * Shared types and error class for the service layer.
 */

import type { AgentId } from "../../session/agents/agent-process.js";
import type { SessionInfo, ProjectTemplate } from "../../shared/types.js";

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
  agents: AgentInfo[];
  defaultAgentId: AgentId;
  templates: Array<Omit<ProjectTemplate, "files">>;
  githubStatus: GitHubStatus;
  githubRepos: Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>;
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
