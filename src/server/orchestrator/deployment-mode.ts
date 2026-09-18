// Host sharing, independent of RUNTIME_MODE's choice of Docker or in-process sessions.
export type DeploymentMode = "local" | "server";

export function resolveDeploymentMode(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentMode {
  return env.SHIPIT_DEPLOYMENT?.trim().toLowerCase() === "local" ? "local" : "server";
}
