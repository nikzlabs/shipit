declare const __SHIPIT_CLIENT_BUILD_ID__: string | undefined;

export function getLoadedClientBuildId(): string | undefined {
  return normalizeBuildId(typeof __SHIPIT_CLIENT_BUILD_ID__ === "undefined" ? undefined : __SHIPIT_CLIENT_BUILD_ID__);
}

export function shouldReloadForServerBuild(
  loadedClientBuildId: string | undefined,
  servedClientBuildId: string | undefined,
): boolean {
  return Boolean(loadedClientBuildId && servedClientBuildId && loadedClientBuildId !== servedClientBuildId);
}

export function normalizeBuildId(buildId: string | undefined): string | undefined {
  const trimmed = buildId?.trim();
  return trimmed ? trimmed : undefined;
}
