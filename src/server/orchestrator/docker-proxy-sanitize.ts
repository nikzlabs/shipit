import type { SessionInfo } from "./docker-proxy-helpers.js";
import { PARENT_SESSION_LABEL } from "./docker-proxy-helpers.js";
import { isPathUnderWorkspace } from "./docker-proxy-auth.js";
import { volumeBelongsToSession, networkBelongsToSession } from "./docker-proxy-auth.js";

const BUILTIN_NETWORK_MODES = new Set(["", "default", "bridge", "host", "none"]);

function isNamedNetwork(mode: string | undefined): boolean {
  if (!mode) return false;
  if (BUILTIN_NETWORK_MODES.has(mode)) return false;
  if (mode.startsWith("container:")) return false;
  return true;
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

  if (Array.isArray(hostConfig.Binds)) {
    for (const bind of hostConfig.Binds as string[]) {
      const hostPath = bind.split(":")[0];
      if (!(await isPathUnderWorkspace(hostPath, session.hostWorkspaceDir))) {
        return { error: `Bind mount path ${hostPath} is outside session workspace` };
      }
    }
  }

  if (Array.isArray(hostConfig.Mounts)) {
    for (const mount of hostConfig.Mounts as Record<string, unknown>[]) {
      if (mount.Type === "bind") {
        const source = mount.Source as string;
        if (!(await isPathUnderWorkspace(source, session.hostWorkspaceDir))) {
          return { error: `Bind mount source ${source} is outside session workspace` };
        }
      } else if (mount.Type === "volume") {
        const volumeName = mount.Source as string;
        if (volumeName && !(await volumeBelongsToSession(socketPath, volumeName, session.sessionId))) {
          return { error: `Volume ${volumeName} does not belong to this session` };
        }
      } else if (mount.Type === "tmpfs") {
        // No host path.
      } else {
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
