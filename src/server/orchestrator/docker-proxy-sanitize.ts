import path from "node:path";

import type { SessionInfo } from "./docker-proxy-helpers.js";
import { PARENT_SESSION_LABEL, forwardToDocker } from "./docker-proxy-helpers.js";
import { resolveUnderWorkspace, volumeBelongsToSession, networkBelongsToSession } from "./docker-proxy-auth.js";
import { SESSION_CPU_SHARES } from "./container-config-builder.js";

const BUILTIN_NETWORK_MODES = new Set(["", "default", "bridge", "host", "none"]);

function isNamedNetwork(mode: string | undefined): boolean {
  if (!mode) return false;
  if (BUILTIN_NETWORK_MODES.has(mode)) return false;
  if (mode.startsWith("container:")) return false;
  return true;
}

/**
 * Rewrite every bind source in `hostConfig` to its realpath, and reject the ones that resolve
 * outside the session workspace.
 *
 * Rewriting is the point, not a tidy-up: Docker resolves the string it is given when it mounts, so
 * forwarding the requested one let the session repoint a symlink after the check and have Docker
 * mount the group-writable overlay base instead (planning#601).
 *
 * `changed` reports a source that was not already its own realpath — what a re-check of an
 * existing container needs, since there the path is stored and can only be refused. `hasHostBind`
 * reports whether any host path is mounted at all, which is what the restart rules turn on.
 */
export async function pinMountPaths(
  hostConfig: Record<string, unknown>,
  workspaceDir: string,
): Promise<{ error?: string; changed: boolean; hasHostBind: boolean }> {
  let changed = false;
  let hasHostBind = false;

  if (Array.isArray(hostConfig.Binds)) {
    const binds = hostConfig.Binds as string[];
    for (let i = 0; i < binds.length; i++) {
      const bind = binds[i];
      const hostPath = bind.split(":")[0];
      const resolved = await resolveUnderWorkspace(hostPath, workspaceDir);
      if (!resolved) {
        return { error: `Bind mount path ${hostPath} is outside session workspace`, changed, hasHostBind };
      }
      // A bind with no container path is an anonymous volume: the one segment is a path inside
      // the container, so there is no host source to pin.
      if (hostPath.length === bind.length) continue;
      // The pinned path goes back into a colon-delimited string, so a colon in it would move the
      // boundary and hand Docker a different source than the one just checked.
      if (resolved.includes(":")) {
        return { error: `Bind mount path ${hostPath} resolves to a path containing ":"`, changed, hasHostBind };
      }
      hasHostBind = true;
      if (resolved !== path.resolve(hostPath)) changed = true;
      binds[i] = resolved + bind.slice(hostPath.length);
    }
  }

  if (Array.isArray(hostConfig.Mounts)) {
    for (const mount of hostConfig.Mounts as Record<string, unknown>[]) {
      if (mount.Type !== "bind") continue;
      const source = mount.Source as string;
      const resolved = await resolveUnderWorkspace(source, workspaceDir);
      if (!resolved) {
        return { error: `Bind mount source ${source} is outside session workspace`, changed, hasHostBind };
      }
      hasHostBind = true;
      if (resolved !== path.resolve(source)) changed = true;
      mount.Source = resolved;
    }
  }

  return { changed, hasHostBind };
}

/**
 * Re-check a container's stored bind sources before Docker mounts them.
 *
 * Create-time pinning fixes the string, not the objects it walks through: the session still owns
 * every directory under its workspace, and it chooses when to start. Without this, it could create
 * a container binding a checked path, replace a directory on that path with a symlink, and start
 * (planning#601). A stored source that is no longer its own realpath is exactly that swap.
 */
export async function verifyContainerMountPaths(
  socketPath: string,
  containerId: string,
  session: SessionInfo,
): Promise<{ error?: string; hasHostBind: boolean }> {
  let hostConfig: Record<string, unknown>;
  try {
    const result = await forwardToDocker(socketPath, "GET", `/containers/${containerId}/json`, {});
    if (result.statusCode !== 200) {
      return { error: "Cannot inspect container to verify mount paths", hasHostBind: false };
    }
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    // Fail closed: an inspect without a HostConfig is not an inspect we can clear mounts from.
    if (!info.HostConfig || typeof info.HostConfig !== "object") {
      return { error: "Container inspect carries no HostConfig to verify", hasHostBind: false };
    }
    hostConfig = info.HostConfig as Record<string, unknown>;
  } catch {
    return { error: "Cannot inspect container to verify mount paths", hasHostBind: false };
  }

  // A copy: the rewrite is only a way to ask whether the stored paths still resolve to themselves.
  const pinned = await pinMountPaths(structuredClone(hostConfig), session.hostWorkspaceDir);
  if (pinned.error) return { error: pinned.error, hasHostBind: pinned.hasHostBind };
  if (pinned.changed) {
    return {
      error: "A bind mount source no longer resolves to the path that was checked",
      hasHostBind: pinned.hasHostBind,
    };
  }
  return { hasHostBind: pinned.hasHostBind };
}

export async function sanitizeBuildRequest(
  url: string,
  contentType: string | undefined,
  session: SessionInfo,
  socketPath: string,
): Promise<{ error?: string }> {
  // Go's FormValue lets form body values override the query's checked networkmode.
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "application/x-www-form-urlencoded" || mediaType === "multipart/form-data") {
    return { error: `Content-Type "${mediaType}" is not allowed for a build (send the context as a tar)` };
  }

  const queryStart = url.indexOf("?");
  if (queryStart === -1) return {};
  const networkMode = new URLSearchParams(url.slice(queryStart + 1)).get("networkmode") ?? undefined;

  if (networkMode === "host" || networkMode?.startsWith("container:")) {
    return { error: "NetworkMode host/container is not allowed" };
  }

  if (networkMode && isNamedNetwork(networkMode)) {
    if (!(await networkBelongsToSession(socketPath, networkMode, session.sessionId))) {
      return { error: `Network "${networkMode}" does not belong to this session` };
    }
  }

  return {};
}

export async function sanitizeContainerCreate(
  body: Record<string, unknown>,
  session: SessionInfo,
  socketPath: string,
): Promise<{ error?: string }> {
  const hostConfig = (body.HostConfig ?? {}) as Record<string, unknown>;

  if (hostConfig.Privileged) {
    return { error: "Privileged mode is not allowed" };
  }

  if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0) {
    return { error: "Adding capabilities is not allowed" };
  }

  const capDrop = Array.isArray(hostConfig.CapDrop) ? [...hostConfig.CapDrop as string[]] : [];
  if (!capDrop.includes("NET_RAW")) {
    capDrop.push("NET_RAW");
  }
  hostConfig.CapDrop = capDrop;

  const networkMode = hostConfig.NetworkMode as string | undefined;
  if (networkMode === "host" || (networkMode?.startsWith("container:"))) {
    return { error: "NetworkMode host/container is not allowed" };
  }

  // Foreign networks can give a child an IP the API guard treats as trusted.
  if (networkMode && isNamedNetwork(networkMode)) {
    if (!(await networkBelongsToSession(socketPath, networkMode, session.sessionId))) {
      return { error: `Network "${networkMode}" does not belong to this session` };
    }
  }

  const networkingConfig = body.NetworkingConfig as Record<string, unknown> | undefined;
  const endpointsConfig = networkingConfig?.EndpointsConfig as Record<string, unknown> | undefined;
  if (endpointsConfig) {
    for (const netName of Object.keys(endpointsConfig)) {
      if (!isNamedNetwork(netName)) {
        return { error: `Network "${netName}" is not allowed via NetworkingConfig` };
      }
      if (!(await networkBelongsToSession(socketPath, netName, session.sessionId))) {
        return { error: `Network "${netName}" does not belong to this session` };
      }
    }
  }

  const pidMode = hostConfig.PidMode as string | undefined;
  if (pidMode && (pidMode === "host" || pidMode.startsWith("container:"))) {
    return { error: "PidMode host/container is not allowed" };
  }

  const ipcMode = hostConfig.IpcMode as string | undefined;
  if (ipcMode && (ipcMode === "host" || ipcMode.startsWith("container:"))) {
    return { error: "IpcMode host/container is not allowed" };
  }

  if (hostConfig.UTSMode === "host") {
    return { error: "UTSMode host is not allowed" };
  }

  if (Array.isArray(hostConfig.Devices) && hostConfig.Devices.length > 0) {
    return { error: "Device mappings are not allowed" };
  }

  const pinned = await pinMountPaths(hostConfig, session.hostWorkspaceDir);
  if (pinned.error) return { error: pinned.error };

  // Docker restarts a container itself when the policy says to, without a request the proxy sees —
  // and it resolves the bind sources again each time. A host bind is only as confined as the check
  // that precedes its mount, so it cannot be carried by a container Docker restarts on its own.
  const restartPolicy = (hostConfig.RestartPolicy as { Name?: string } | undefined)?.Name;
  if (pinned.hasHostBind && restartPolicy && restartPolicy !== "no") {
    return {
      error: `RestartPolicy "${restartPolicy}" is not allowed with a host bind mount ` +
        "(Docker's own restart would remount the path without a check); start the container again instead",
    };
  }

  if (Array.isArray(hostConfig.Mounts)) {
    for (const mount of hostConfig.Mounts as Record<string, unknown>[]) {
      if (mount.Type === "volume") {
        // Container create is a volume-create surface of its own, and a `local` volume with
        // `o=bind,device=…` is a host bind under another name — the same escape POST /volumes/create
        // refuses. It also reaches anonymous volumes, which carry no name to check ownership on.
        const driverConfig = (mount.VolumeOptions as Record<string, unknown> | undefined)
          ?.DriverConfig as { Name?: string; Options?: Record<string, string> } | undefined;
        if (driverConfig?.Name && driverConfig.Name !== "local") {
          return { error: `Volume driver "${driverConfig.Name}" is not allowed` };
        }
        if (driverConfig?.Options && Object.keys(driverConfig.Options).length > 0) {
          return { error: "Volume DriverConfig options are not allowed (host-path escape risk)" };
        }
        const volumeName = mount.Source as string;
        if (volumeName && !(await volumeBelongsToSession(socketPath, volumeName, session.sessionId))) {
          return { error: `Volume ${volumeName} does not belong to this session` };
        }
      } else if (mount.Type !== "bind" && mount.Type !== "tmpfs") {
        return { error: `Mount type "${String(mount.Type)}" is not allowed (only bind, volume, tmpfs)` };
      }
    }
  }

  if (Array.isArray(hostConfig.VolumesFrom) && hostConfig.VolumesFrom.length > 0) {
    return { error: "VolumesFrom is not allowed" };
  }

  delete hostConfig.SecurityOpt;
  delete hostConfig.CgroupParent;
  delete hostConfig.Sysctls;
  delete hostConfig.UsernsMode;
  delete hostConfig.CgroupnsMode;
  delete hostConfig.Runtime;
  delete hostConfig.ReadonlyPaths;
  delete hostConfig.MaskedPaths;
  delete hostConfig.GroupAdd;
  // Picks the driver for the image's own VOLUME directives, where no Mounts entry is checked.
  delete hostConfig.VolumeDriver;

  const labels = (body.Labels ?? {}) as Record<string, string>;
  labels[PARENT_SESSION_LABEL] = session.sessionId;
  body.Labels = labels;

  // Docker treats nonpositive limits as unlimited.
  if (session.resourceLimits) {
    const limits = session.resourceLimits;
    const currentMemory = hostConfig.Memory as number | undefined;
    if (!currentMemory || currentMemory <= 0 || currentMemory > limits.memory) {
      hostConfig.Memory = limits.memory;
    }
    const currentCpuQuota = hostConfig.CpuQuota as number | undefined;
    if (!currentCpuQuota || currentCpuQuota <= 0 || currentCpuQuota > limits.cpuQuota) {
      hostConfig.CpuQuota = limits.cpuQuota;
    }
    const currentPeriod = hostConfig.CpuPeriod as number | undefined;
    if (!currentPeriod || currentPeriod <= 0 || currentPeriod > 100_000) {
      hostConfig.CpuPeriod = 100_000;
    }
    // A sibling of a docker-access session is scheduled against the orchestrator, so it inherits
    // the worker's low cgroup weight rather than Docker's default 1024.
    const currentShares = hostConfig.CpuShares as number | undefined;
    if (!currentShares || currentShares <= 0 || currentShares > SESSION_CPU_SHARES) {
      hostConfig.CpuShares = SESSION_CPU_SHARES;
    }
    const currentPids = hostConfig.PidsLimit as number | undefined;
    if (!currentPids || currentPids <= 0 || currentPids > limits.pidsLimit) {
      hostConfig.PidsLimit = limits.pidsLimit;
    }
  }

  if (session.sessionNetworkName) {
    if (!hostConfig.NetworkMode || hostConfig.NetworkMode === "default" || hostConfig.NetworkMode === "bridge") {
      hostConfig.NetworkMode = session.sessionNetworkName;
    }
  }

  body.HostConfig = hostConfig;

  return {};
}
