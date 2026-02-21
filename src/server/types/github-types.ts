// ---- GitHub auth client messages ----

export interface WsGitHubSetToken {
  type: "github_set_token";
  token: string;
}

export interface WsGitHubPush {
  type: "github_push";
  remote?: string;
  branch?: string;
}

export interface WsGitHubPull {
  type: "github_pull";
  remote?: string;
  branch?: string;
}

export interface WsGitHubSetRemote {
  type: "github_set_remote";
  name: string;
  url: string;
}

export interface WsGitHubLogout {
  type: "github_logout";
}

export interface WsGitHubCreatePR {
  type: "github_create_pr";
  title: string;
  body: string;
  base: string;
  draft?: boolean;
}

// ---- AI PR description messages ----

export interface WsGeneratePRDescription {
  type: "generate_pr_description";
}

// ---- PR status & merge messages ----

export interface WsMergePr {
  type: "merge_pr";
  method?: "merge" | "squash" | "rebase";
}

// ---- GitHub auth server messages ----

export interface WsGitHubStatus {
  type: "github_status";
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export interface WsGitHubPushResult {
  type: "github_push_result";
  success: boolean;
  message: string;
  branch?: string;
}

export interface WsGitHubPullResult {
  type: "github_pull_result";
  success: boolean;
  message: string;
}

export interface WsGitHubRemotes {
  type: "github_remotes";
  remotes: Array<{ name: string; url: string }>;
}

export interface WsGitHubPRCreated {
  type: "github_pr_created";
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
}

export interface WsGitHubBranches {
  type: "github_branches";
  current: string;
  remote: string[];
}

export interface WsGitHubSearchResults {
  type: "github_search_results";
  repos: Array<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }>;
}

// ---- AI PR description server messages ----

export interface WsGeneratedPRDescription {
  type: "generated_pr_description";
  description: string;
}

// ---- PR status & merge server messages ----

export interface WsPrStatus {
  type: "pr_status";
  pr: {
    url: string;
    number: number;
    title: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
    checks: {
      state: "pending" | "success" | "failure" | "none";
      total: number;
      passed: number;
      failed: number;
      pending: number;
    };
    autoMergeEnabled: boolean;
    mergeable: boolean;
  } | null;
}

export interface WsMergePrResult {
  type: "merge_pr_result";
  success: boolean;
  message: string;
  autoMergeEnabled?: boolean;
}
