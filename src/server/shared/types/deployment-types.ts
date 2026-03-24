// ---- GitHub Deployment status types (from GitHub Deployments API) ----

export interface GitHubDeploymentStatus {
  /** Deployment environment name (e.g. "Production", "Preview"). */
  environment: string;
  /** Current state of the deployment. */
  state: "pending" | "success" | "failure" | "error" | "inactive" | "in_progress" | "queued";
  /** The deployment URL (e.g. preview URL or production URL). */
  environmentUrl: string | null;
  /** When the deployment was created. */
  createdAt: string;
  /** The platform that created the deployment (from creator login). */
  creator: string | null;
}
