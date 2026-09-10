// Run in the session container: the fingerprint must describe the install runtime.
// Use the base image digest so app-only image rebuilds do not invalidate native dependencies.
export function runtimeKey(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.BASE_IMAGE_DIGEST ?? env.SESSION_WORKER_IMAGE_ID ?? env.IMAGE_DIGEST ?? "unknown";
  const libc = detectLibc();
  const abi = process.versions.modules;
  const key = `${base}|${process.arch}|${libc}|abi${abi}`;
  // A pinned Node runs the install; preserve existing keys when no pin is active.
  return env.SHIPIT_PINNED_NODE ? `${key}|node${env.SHIPIT_PINNED_NODE}` : key;
}

export function detectLibc(): string {
  try {
    const report = (process.report as { getReport?: () => unknown }).getReport?.();
    const header = (report as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    if (header?.glibcVersionRuntime) return `glibc-${header.glibcVersionRuntime}`;
    return "musl";
  } catch {
    return "unknown";
  }
}

export function tuneNpmInstall(command: string): string {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== "npm") return trimmed;
  if (!(tokens[1] === "install" || tokens[1] === "i" || tokens[1] === "ci")) return trimmed;
  if (tokens.length !== 2) return trimmed;
  return `${trimmed} --prefer-offline --no-audit --no-fund`;
}
