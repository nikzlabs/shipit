import { spawn } from "node:child_process";
import type { DeployTarget, DeployContext, DeployResult } from "./deploy-target.js";
import type { DeployTargetInfo } from "../../shared/types.js";

export class VercelTarget implements DeployTarget {
  readonly info: DeployTargetInfo = {
    id: "vercel",
    name: "Vercel",
    description: "Deploy to Vercel's edge network",
    configFields: [
      {
        key: "token",
        label: "Vercel Token",
        required: true,
        sensitive: true,
        helpUrl: "https://vercel.com/account/tokens",
        helpText: "Create a token at Vercel → Account Settings → Tokens",
        placeholder: "tok_xxxxx",
      },
    ],
    supportsPreview: true,
  };

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const startTime = Date.now();
    const token = ctx.credentials.token;

    const args = ["deploy", "--yes", `--token=${token}`];
    if (ctx.environment === "production") args.push("--prod");

    return new Promise((resolve, reject) => {
      const proc = spawn("vercel", args, {
        cwd: ctx.workspaceDir,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Wire abort signal
      const onAbort = () => proc.kill("SIGTERM");
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      let stdoutBuf = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          ctx.log(line);
        }
      });

      proc.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        if (code === 0) {
          resolve({
            url: stdoutBuf.trim(),
            environment: ctx.environment,
            durationMs: Date.now() - startTime,
          });
        } else {
          reject(new Error(`Vercel deploy failed (exit ${code})`));
        }
      });

      proc.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        reject(new Error(`Failed to spawn vercel: ${err.message}`));
      });
    });
  }
}
