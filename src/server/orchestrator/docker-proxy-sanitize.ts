/**
 * Container create sanitization for the Docker API proxy.
 *
 * Validates and transforms the Docker container creation payload to enforce
 * security policy: no privileged mode, no host mounts outside workspace,
 * resource limits, session labeling, etc.
 */

import type { SessionInfo } from "./docker-proxy-helpers.js";
import { PARENT_SESSION_LABEL } from "./docker-proxy-helpers.js";
import { isPathUnderWorkspace } from "./docker-proxy-auth.js";
import { volumeBelongsToSession } from "./docker-proxy-auth.js";

// ---------------------------------------------------------------------------
// Container create sanitization
// ---------------------------------------------------------------------------

export async function sanitizeContainerCreate(
  body: Record<string, unknown>,
  session: SessionInfo,
  socketPath: string,
): Promise<{ error?: string }> {
  const hostConfig = (body.HostConfig ?? {}) as Record<string, unknown>;

  // Reject privileged mode (check for any truthy value, not just boolean true,
  // to guard against type coercion with "true", 1, etc.)
  if (hostConfig.Privileged) {
    return { error: "Privileged mode is not allowed" };
  }

  // Reject CapAdd
  if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0) {
    return { error: "Adding capabilities is not allowed" };
  }

  // Inject NET_RAW into CapDrop
  const capDrop = Array.isArray(hostConfig.CapDrop) ? [...hostConfig.CapDrop as string[]] : [];
  if (!capDrop.includes("NET_RAW")) {
    capDrop.push("NET_RAW");
  }
  hostConfig.CapDrop = capDrop;

  // Reject host and container NetworkMode (sharing another container's network namespace)
  const networkMode = hostConfig.NetworkMode as string | undefined;
  if (networkMode === "host" || (networkMode?.startsWith("container:"))) {
    return { error: "NetworkMode host/container is not allowed" };
  }

  // Reject host/container PidMode
  const pidMode = hostConfig.PidMode as string | undefined;
  if (pidMode && (pidMode === "host" || pidMode.startsWith("container:"))) {
    return { error: "PidMode host/container is not allowed" };
  }

  // Reject host/container IpcMode
  const ipcMode = hostConfig.IpcMode as string | undefined;
  if (ipcMode && (ipcMode === "host" || ipcMode.startsWith("container:"))) {
    return { error: "IpcMode host/container is not allowed" };
  }

  // Reject host UTSMode
  if (hostConfig.UTSMode === "host") {
    return { error: "UTSMode host is not allowed" };
  }

  // Reject Devices
  if (Array.isArray(hostConfig.Devices) && hostConfig.Devices.length > 0) {
    return { error: "Device mappings are not allowed" };
  }

  // Validate Binds
  if (Array.isArray(hostConfig.Binds)) {
    for (const bind of hostConfig.Binds as string[]) {
      // Format: host_path:container_path[:options]
      const hostPath = bind.split(":")[0];
      if (!(await isPathUnderWorkspace(hostPath, session.hostWorkspaceDir))) {
        return { error: `Bind mount path ${hostPath} is outside session workspace` };
      }
    }
  }

  // Validate Mounts — only bind, volume, and tmpfs are allowed
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
        // tmpfs mounts are safe — no host path involved
      } else {
        return { error: `Mount type "${String(mount.Type)}" is not allowed (only bind, volume, tmpfs)` };
      }
    }
  }

  // Docker's Volumes field in create is just a set of mount points, not named volumes.
  // Named volumes referenced via Binds/Mounts are already validated above.

  // Reject VolumesFrom
  if (Array.isArray(hostConfig.VolumesFrom) && hostConfig.VolumesFrom.length > 0) {
    return { error: "VolumesFrom is not allowed" };
  }

  // Strip fields that could weaken container isolation
  delete hostConfig.SecurityOpt;
  delete hostConfig.CgroupParent;
  delete hostConfig.Sysctls;        // kernel parameter manipulation
  delete hostConfig.UsernsMode;     // user namespace sharing
  delete hostConfig.CgroupnsMode;   // cgroup namespace sharing
  delete hostConfig.Runtime;        // custom runtimes (e.g., nvidia) may grant elevated access
  delete hostConfig.ReadonlyPaths;  // removing default read-only paths weakens /proc isolation
  delete hostConfig.MaskedPaths;    // removing default masked paths exposes sensitive /proc entries
  delete hostConfig.GroupAdd;       // adding host groups (e.g., docker, disk) could escalate access

  // Overwrite shipit-parent-session label (never merge)
  const labels = (body.Labels ?? {}) as Record<string, string>;
  labels[PARENT_SESSION_LABEL] = session.sessionId;
  body.Labels = labels;

  // Enforce resource limits on child containers — capped at session's own limits.
  // Values <= 0 mean "unlimited" in Docker, so we always override them.
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
    // Cap CpuPeriod to the standard 100ms to prevent effective CPU limit bypass
    // (inflating the period while quota is capped gives more CPU time)
    const currentPeriod = hostConfig.CpuPeriod as number | undefined;
    if (!currentPeriod || currentPeriod <= 0 || currentPeriod > 100_000) {
      hostConfig.CpuPeriod = 100_000;
    }
    const currentPids = hostConfig.PidsLimit as number | undefined;
    if (!currentPids || currentPids <= 0 || currentPids > limits.pidsLimit) {
      hostConfig.PidsLimit = limits.pidsLimit;
    }
  }

  // Inject session-specific network so child containers can communicate
  if (session.sessionNetworkName) {
    // If NetworkMode is not explicitly set or is "default", use session network
    if (!hostConfig.NetworkMode || hostConfig.NetworkMode === "default" || hostConfig.NetworkMode === "bridge") {
      hostConfig.NetworkMode = session.sessionNetworkName;
    }
  }

  // Write back HostConfig
  body.HostConfig = hostConfig;

  return {};
}
