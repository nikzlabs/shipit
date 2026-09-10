import type { RepoInfo } from "../domain-types.js";

export interface WsRepoStatus {
  type: "repo_status";
  url: string;
  status: "cloning" | "ready";
}

export interface WsRepoWarmReady {
  type: "repo_warm_ready";
  url: string;
  sessionId: string;
}

export interface WsRepoList {
  type: "repo_list";
  repos: RepoInfo[];
}
