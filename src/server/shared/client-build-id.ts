import { execFileSync } from "node:child_process";

export type ViteCommand = "build" | "serve";

/**
 * `define` is evaluated once when Vite starts, so a dev server would hand every page a build
 * id frozen at that moment while the orchestrator re-resolves its own on each watcher restart.
 * The client reloads on a mismatch, the reload re-reads the same frozen id, and nothing ever
 * clears it — so a dev server defines no id at all and relies on Vite's HMR instead.
 */
export function clientBuildIdDefine(
  command: ViteCommand,
  env: NodeJS.ProcessEnv = process.env,
  readGitHead: () => string | undefined = gitHead,
): Record<string, string> {
  if (command !== "build") return {};
  const explicit = trimmed(env.VITE_SHIPIT_BUILD_ID) ?? trimmed(env.SHIPIT_BUILD_ID);
  const buildId = explicit ?? trimmed(readGitHead());
  return buildId ? { __SHIPIT_CLIENT_BUILD_ID__: JSON.stringify(buildId) } : {};
}

function trimmed(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : undefined;
}

function gitHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
