export interface GitHubDeploymentStatus {
  environment: string;
  state: "pending" | "success" | "failure" | "error" | "inactive" | "in_progress" | "queued";
  environmentUrl: string | null;
  createdAt: string;
  creator: string | null;
}
