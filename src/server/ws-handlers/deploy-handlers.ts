import crypto from "node:crypto";
import path from "node:path";
import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";

type WsDeployConfigure = Extract<WsClientMessage, { type: "deploy_configure" }>;
type WsInitiateDeploy = Extract<WsClientMessage, { type: "initiate_deploy" }>;
type WsDeleteDeployConfig = Extract<WsClientMessage, { type: "delete_deploy_config" }>;

export function handleListDeployTargets(ctx: HandlerContext): void {
  ctx.send({ type: "deploy_targets", targets: ctx.deploymentManager.getTargets() });
}

export function handleDeployConfigure(ctx: HandlerContext, msg: WsDeployConfigure): void {
  const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
  const target = ctx.deploymentManager.getTarget(targetId);
  if (!target) {
    ctx.send({ type: "error", message: `Unknown deploy target: "${targetId}"` });
    return;
  }

  // Validate credentials against the target's configFields
  const credentials: Record<string, string> = {};
  for (const field of target.info.configFields) {
    const value = typeof msg.credentials?.[field.key] === "string"
      ? msg.credentials[field.key].trim() : "";
    if (field.required && !value) {
      ctx.send({ type: "error", message: `${field.label} is required` });
      return;
    }
    if (value.length > 2000) {
      ctx.send({ type: "error", message: `${field.label} is too long` });
      return;
    }
    if (value) credentials[field.key] = value;
  }

  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (!activeAppSessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }

  const projectName = typeof msg.projectName === "string" ? msg.projectName.trim() : undefined;
  ctx.deploymentStore.saveConfig(activeAppSessionId, { targetId, credentials, projectName });
  ctx.send({ type: "deploy_config_saved", targetId });
}

export async function handleInitiateDeploy(ctx: HandlerContext, msg: WsInitiateDeploy): Promise<void> {
  const activeSessionDir = ctx.getActiveSessionDir();
  if (!activeSessionDir) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  if (ctx.deploymentManager.deploying) {
    ctx.send({ type: "error", message: "Deployment already in progress" });
    return;
  }

  const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
  const target = ctx.deploymentManager.getTarget(targetId);
  if (!target) {
    ctx.send({ type: "error", message: `Unknown deploy target: "${targetId}"` });
    return;
  }

  const activeAppSessionId = ctx.getActiveAppSessionId()!;
  const environment = msg.environment === "production" ? "production" : "preview";
  const config = ctx.deploymentStore.loadConfig(activeAppSessionId, targetId);
  if (!config) {
    ctx.send({ type: "error", message: `No credentials configured for ${target.info.name}. Set up deployment first.` });
    return;
  }

  // Detect framework and build
  ctx.broadcast({ type: "deploy_status", phase: "building" });
  const framework = await ctx.deploymentManager.detectFramework(activeSessionDir);

  if (framework.buildCommand) {
    const buildOk = await ctx.deploymentManager.build(activeSessionDir, framework.buildCommand);
    if (!buildOk) {
      ctx.broadcast({ type: "deploy_error", message: "Build failed", phase: "building" });
      return;
    }
  }

  // Deploy (target-agnostic — the manager dispatches to the right target)
  const deployCompleteHandler = async (result: { url: string; targetId: string; environment: "production" | "preview"; durationMs: number }) => {
    // Record in history
    let commitHash: string | undefined;
    let commitMessage: string | undefined;
    try {
      const git = ctx.getActiveGitManager();
      const commits = await git.log(1);
      if (commits.length > 0) {
        commitHash = commits[0].hash;
        commitMessage = commits[0].message;
      }
    } catch {
      // ok
    }

    ctx.deploymentStore.recordDeployment(activeAppSessionId, {
      id: crypto.randomUUID(),
      targetId: result.targetId,
      environment: result.environment,
      url: result.url,
      commitHash,
      commitMessage,
      timestamp: new Date().toISOString(),
      durationMs: result.durationMs,
      status: "success",
    });

    ctx.broadcast({
      type: "deploy_complete",
      url: result.url,
      targetId: result.targetId,
      environment: result.environment,
      durationMs: result.durationMs,
    });
  };

  // Listen for complete event for this deployment (one-time)
  ctx.deploymentManager.once("complete", deployCompleteHandler);

  try {
    await ctx.deploymentManager.deploy(targetId, {
      workspaceDir: activeSessionDir,
      outputDir: framework.outputDirectory,
      credentials: config.credentials,
      environment,
      projectName: config.projectName || path.basename(activeSessionDir),
    });
  } catch {
    // Error already emitted via event; remove the complete handler since it didn't fire
    ctx.deploymentManager.removeListener("complete", deployCompleteHandler);
  }
}

export function handleGetDeployHistory(ctx: HandlerContext): void {
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (!activeAppSessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  const history = ctx.deploymentStore.getHistory(activeAppSessionId);
  ctx.send({ type: "deploy_history", deployments: history });
}

export function handleCancelDeploy(ctx: HandlerContext): void {
  ctx.deploymentManager.cancel();
}

export function handleGetProjectSettings(ctx: HandlerContext): void {
  const targets = ctx.deploymentManager.getTargets();
  const deployConfig: Record<string, { configured: boolean; projectName?: string }> = {};
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (activeAppSessionId) {
    for (const t of targets) {
      const config = ctx.deploymentStore.loadConfig(activeAppSessionId, t.id);
      deployConfig[t.id] = config
        ? { configured: true, projectName: config.projectName }
        : { configured: false };
    }
  }
  ctx.send({ type: "project_settings", deployConfig });
}

export function handleDeleteDeployConfig(ctx: HandlerContext, msg: WsDeleteDeployConfig): void {
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (!activeAppSessionId) {
    ctx.send({ type: "error", message: "No active session" });
    return;
  }
  const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
  ctx.deploymentStore.deleteConfig(activeAppSessionId, targetId);
  ctx.send({ type: "deploy_config_saved", targetId });
}
