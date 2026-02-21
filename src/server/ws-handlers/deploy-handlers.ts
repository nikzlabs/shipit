import crypto from "node:crypto";
import path from "node:path";
import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";

type WsInitiateDeploy = Extract<WsClientMessage, { type: "initiate_deploy" }>;

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

export function handleCancelDeploy(ctx: HandlerContext): void {
  ctx.deploymentManager.cancel();
}

