import { spawn } from "node:child_process";
import path from "node:path";
import type { DeployTarget, DeployContext, DeployResult } from "./deploy-target.js";
import type { DeployTargetInfo } from "../../shared/types.js";

export class CloudflareTarget implements DeployTarget {
  readonly info: DeployTargetInfo = {
    id: "cloudflare",
    name: "Cloudflare Pages",
    description: "Deploy static assets to Cloudflare's global network",
    configFields: [
      {
        key: "token",
        label: "API Token",
        required: true,
        sensitive: true,
        helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
        helpText: "Create a token with 'Cloudflare Pages: Edit' permission",
        placeholder: "xxxxx",
      },
      {
        key: "accountId",
        label: "Account ID",
        required: true,
        sensitive: false,
        helpUrl: "https://dash.cloudflare.com",
        helpText: "Found on the right sidebar of your Cloudflare dashboard",
        placeholder: "abcdef1234567890",
      },
    ],
    supportsPreview: true,
  };

  /** Ensure the Cloudflare Pages project exists. Idempotent. */
  async prepare(ctx: DeployContext): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn("wrangler", [
        "pages", "project", "create", ctx.projectName,
        "--production-branch=main",
      ], {
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: ctx.credentials.token,
          CLOUDFLARE_ACCOUNT_ID: ctx.credentials.accountId,
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Ignore exit code — project may already exist
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
    });
  }

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const startTime = Date.now();
    const deployDir = path.join(ctx.workspaceDir, ctx.outputDir);

    return new Promise((resolve, reject) => {
      const proc = spawn("wrangler", [
        "pages", "deploy", deployDir,
        `--project-name=${ctx.projectName}`,
        "--branch=main",
      ], {
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: ctx.credentials.token,
          CLOUDFLARE_ACCOUNT_ID: ctx.credentials.accountId,
          FORCE_COLOR: "0",
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => proc.kill("SIGTERM");
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      let allOutput = "";
      const handleChunk = (chunk: Buffer) => {
        const text = chunk.toString();
        allOutput += text;
        for (const line of text.split("\n").filter(Boolean)) {
          ctx.log(line);
        }
      };

      proc.stdout.on("data", handleChunk);
      proc.stderr.on("data", handleChunk);

      proc.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        if (code === 0) {
          // Extract URL from mixed output
          const urlMatch = /https:\/\/[a-zA-Z0-9_-]+\.[\w.-]+\.pages\.dev/.exec(allOutput);
          resolve({
            url: urlMatch?.[0] || `https://${ctx.projectName}.pages.dev`,
            environment: ctx.environment,
            durationMs: Date.now() - startTime,
          });
        } else {
          reject(new Error(`Cloudflare deploy failed (exit ${code})`));
        }
      });

      proc.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        reject(new Error(`Failed to spawn wrangler: ${err.message}`));
      });
    });
  }
}
