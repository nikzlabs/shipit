/**
 * Deploy services — reads (history, targets, setup) and mutations
 * (save/delete deploy configuration).
 */

import type { DeploymentManager } from "../deployment-manager.js";
import type { DeploymentStore } from "../deployment-store.js";
import { ServiceError } from "./types.js";

// ---- Read operations ----

/** Get deploy history for a session. */
export function getDeployHistory(deploymentStore: DeploymentStore, sessionId: string) {
  return deploymentStore.getHistory(sessionId);
}

/** Get deploy targets list. */
export function getDeployTargets(deploymentManager: DeploymentManager) {
  return deploymentManager.getTargets();
}

/** Get project deploy config for all targets. */
export function getProjectSettings(
  deploymentManager: DeploymentManager,
  deploymentStore: DeploymentStore,
  sessionId: string,
) {
  const targets = deploymentManager.getTargets();
  const deployConfig: Record<string, { configured: boolean; projectName?: string }> = {};
  for (const t of targets) {
    const config = deploymentStore.loadConfig(sessionId, t.id);
    deployConfig[t.id] = config
      ? { configured: true, projectName: config.projectName }
      : { configured: false };
  }
  return deployConfig;
}

/** Get deploy setup (targets + project settings combined). */
export function getDeploySetup(
  deploymentManager: DeploymentManager,
  deploymentStore: DeploymentStore,
  sessionId: string,
) {
  return {
    targets: getDeployTargets(deploymentManager),
    projectSettings: getProjectSettings(deploymentManager, deploymentStore, sessionId),
  };
}

// ---- Mutation operations ----

/** Save deploy configuration. */
export function saveDeployConfig(
  deploymentManager: DeploymentManager,
  deploymentStore: DeploymentStore,
  sessionId: string,
  targetId: string,
  credentials: Record<string, string>,
  projectName?: string,
): { targetId: string } {
  const trimmedTargetId = targetId.trim();
  const target = deploymentManager.getTarget(trimmedTargetId);
  if (!target) throw new ServiceError(400, `Unknown deploy target: "${trimmedTargetId}"`);

  // Validate credentials against the target's configFields
  const validatedCreds: Record<string, string> = {};
  for (const field of target.info.configFields) {
    const value = typeof credentials?.[field.key] === "string" ? credentials[field.key].trim() : "";
    if (field.required && !value) throw new ServiceError(400, `${field.label} is required`);
    if (value.length > 2000) throw new ServiceError(400, `${field.label} is too long`);
    if (value) validatedCreds[field.key] = value;
  }

  const trimmedProjectName = typeof projectName === "string" ? projectName.trim() : undefined;
  deploymentStore.saveConfig(sessionId, { targetId: trimmedTargetId, credentials: validatedCreds, projectName: trimmedProjectName });
  return { targetId: trimmedTargetId };
}

/** Delete deploy configuration. */
export function deleteDeployConfig(
  deploymentStore: DeploymentStore,
  sessionId: string,
  targetId: string,
): { targetId: string } {
  const trimmed = targetId.trim();
  deploymentStore.deleteConfig(sessionId, trimmed);
  return { targetId: trimmed };
}
