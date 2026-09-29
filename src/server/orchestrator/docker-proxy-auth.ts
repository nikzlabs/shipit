import fs from "node:fs/promises";
import path from "node:path";

import { forwardToDocker, PARENT_SESSION_LABEL } from "./docker-proxy-helpers.js";

export const RESERVED_EGRESS_LABEL_PREFIX = "shipit-egress-";

export async function containerBelongsToSession(
  socketPath: string,
  containerId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/containers/${containerId}/json`, {});
    if (result.statusCode !== 200) return false;
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    const labels = (info.Config as Record<string, unknown> | undefined)?.Labels as Record<string, string> | undefined;
    if (labels?.[PARENT_SESSION_LABEL] !== sessionId) return false;
    // ShipIt's firewall sidecars carry the session label and hold NET_ADMIN in its namespace (docs/319).
    return !Object.keys(labels).some((key) => key.startsWith(RESERVED_EGRESS_LABEL_PREFIX));
  } catch {
    return false;
  }
}

/**
 * The network when it belongs to the session, else undefined. `name` is what Docker holds, so an
 * id or an id prefix yields the same name as the name itself.
 */
export async function sessionOwnedNetwork(
  socketPath: string,
  networkId: string,
  sessionId: string,
): Promise<{ name?: string } | undefined> {
  try {
    const result = await forwardToDocker(socketPath, "GET", `/networks/${networkId}`, {});
    if (result.statusCode !== 200) return undefined;
    const info = JSON.parse(result.body.toString()) as Record<string, unknown>;
    if ((info.Labels as Record<string, string> | undefined)?.[PARENT_SESSION_LABEL] !== sessionId) return undefined;
    return typeof info.Name === "string" ? { name: info.Name } : {};
  } catch {
    return undefined;
  }
}

export async function networkBelongsToSession(
  socketPath: string,
  networkId: string,
  sessionId: string,
): Promise<boolean> {
  return (await sessionOwnedNetwork(socketPath, networkId, sessionId)) !== undefined;
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

/**
 * The realpath of `hostPath` when it lands inside the session workspace, else undefined.
 *
 * Callers MUST forward the returned path rather than what the caller asked for: the two name the
 * same object only while no symlink on the way in changes, and the session owns every component
 * under its workspace (planning#601).
 */
export async function resolveUnderWorkspace(
  hostPath: string,
  workspaceDir: string,
): Promise<string | undefined> {
  try {
    const resolved = await fs.realpath(hostPath);
    const resolvedWorkspace = await fs.realpath(workspaceDir);
    if (resolved === resolvedWorkspace) return resolved;
    return resolved.startsWith(resolvedWorkspace + path.sep) ? resolved : undefined;
  } catch {
    return undefined;
  }
}
