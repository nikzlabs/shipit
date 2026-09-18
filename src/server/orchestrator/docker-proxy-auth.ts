import fs from "node:fs/promises";
import path from "node:path";

import { forwardToDocker, PARENT_SESSION_LABEL } from "./docker-proxy-helpers.js";

export async function containerBelongsToSession(
  socketPath: string,
  containerId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/containers/${containerId}/json`, {});
    if (result.statusCode !== 200) return false;
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    return (info.Config as Record<string, unknown> | undefined)?.Labels !== undefined &&
      ((info.Config as Record<string, unknown>).Labels as Record<string, string>)?.[PARENT_SESSION_LABEL] === sessionId;
  } catch {
    return false;
  }
}

export async function networkBelongsToSession(
  socketPath: string,
  networkId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/networks/${networkId}`, {});
    if (result.statusCode !== 200) return false;
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    return (info.Labels as Record<string, string> | undefined)?.[PARENT_SESSION_LABEL] === sessionId;
  } catch {
    return false;
  }
}

export async function volumeBelongsToSession(
  socketPath: string,
  volumeName: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/volumes/${volumeName}`, {});
    if (result.statusCode !== 200) return false;
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    return (info.Labels as Record<string, string> | undefined)?.[PARENT_SESSION_LABEL] === sessionId;
  } catch {
    return false;
  }
}

export async function getExecParentContainerId(
  socketPath: string,
  execId: string,
): Promise<string | undefined> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/exec/${execId}/json`, {});
    if (result.statusCode !== 200) return undefined;
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    return info.ContainerID as string | undefined;
  } catch {
    return undefined;
  }
}

// Symlinks can change between this check and Docker's mount; this layer cannot close that race.
export async function isPathUnderWorkspace(hostPath: string, workspaceDir: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(hostPath);
    const resolvedWorkspace = await fs.realpath(workspaceDir);
    return resolved.startsWith(resolvedWorkspace + path.sep) || resolved === resolvedWorkspace;
  } catch {
    return false;
  }
}
