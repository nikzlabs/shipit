/**
 * Ownership / authorization checks for the Docker API proxy.
 *
 * These functions verify that a Docker resource (container, network, volume,
 * exec instance) belongs to a specific session by inspecting its labels.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { forwardToDocker, PARENT_SESSION_LABEL } from "./docker-proxy-helpers.js";

// ---------------------------------------------------------------------------
// Container ownership
// ---------------------------------------------------------------------------

/**
 * Check if a container belongs to a session by inspecting its labels.
 */
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

// ---------------------------------------------------------------------------
// Network ownership
// ---------------------------------------------------------------------------

/**
 * Check if a network belongs to a session by inspecting its labels.
 */
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

// ---------------------------------------------------------------------------
// Volume ownership
// ---------------------------------------------------------------------------

/**
 * Check if a volume belongs to a session by inspecting its labels.
 */
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

// ---------------------------------------------------------------------------
// Exec ownership
// ---------------------------------------------------------------------------

/**
 * Resolve an exec ID to its parent container ID by querying the Docker daemon.
 */
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

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate that a host path (from Binds or Mounts) is under the session's workspace.
 * Uses realpath to resolve symlinks.
 *
 * SECURITY NOTE: There is an inherent TOCTOU (time-of-check-time-of-use) race here.
 * A process inside the session container could create a symlink pointing inside the
 * workspace to pass this check, then swap it to point outside before Docker mounts it.
 * This is a fundamental limitation of path validation from outside the mount namespace
 * and cannot be fully mitigated at this layer. The container's restricted capabilities
 * (CapDrop: ALL) and network isolation reduce the blast radius.
 */
export async function isPathUnderWorkspace(hostPath: string, workspaceDir: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(hostPath);
    const resolvedWorkspace = await fs.realpath(workspaceDir);
    return resolved.startsWith(resolvedWorkspace + path.sep) || resolved === resolvedWorkspace;
  } catch {
    // Path doesn't exist — reject
    return false;
  }
}
