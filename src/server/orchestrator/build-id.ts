import { execFileSync } from "node:child_process";

export function resolveBuildId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = normalizeBuildId(env.SHIPIT_BUILD_ID);
  if (explicit) return explicit;

  try {
    return normalizeBuildId(execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return undefined;
  }
}

export function normalizeBuildId(buildId: string | undefined): string | undefined {
  const trimmed = buildId?.trim();
  return trimmed ? trimmed : undefined;
}
