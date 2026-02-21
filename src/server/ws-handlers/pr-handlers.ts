import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";
import { GitManager } from "../git.js";

type WsGithubCreatePr = Extract<WsClientMessage, { type: "github_create_pr" }>;
type WsMergePr = Extract<WsClientMessage, { type: "merge_pr" }>;

export async function handleGithubCreatePr(ctx: HandlerContext, msg: WsGithubCreatePr): Promise<void> {
  if (!ctx.githubAuthManager.authenticated) {
    ctx.send({ type: "error", message: "Not authenticated with GitHub" });
    return;
  }

  const title = typeof msg.title === "string" ? msg.title.trim() : "";
  const body = typeof msg.body === "string" ? msg.body.trim() : "";
  const base = typeof msg.base === "string" ? msg.base.trim() : "";

  if (!title) {
    ctx.send({ type: "error", message: "PR title is required" });
    return;
  }
  if (title.length > 256) {
    ctx.send({ type: "error", message: "PR title too long (max 256 characters)" });
    return;
  }
  if (!base) {
    ctx.send({ type: "error", message: "Base branch is required" });
    return;
  }

  try {
    const git = ctx.getActiveGitManager();
    const remotes = await git.getRemotes();
    const origin = remotes.find((r) => r.name === "origin");
    if (!origin) {
      ctx.send({ type: "error", message: "No 'origin' remote configured" });
      return;
    }

    const parsed = GitManager.parseGitHubRemote(origin.url);
    if (!parsed) {
      ctx.send({ type: "error", message: "Remote URL is not a GitHub repository" });
      return;
    }

    const head = await git.getCurrentBranch();

    const result = await ctx.githubAuthManager.createPullRequest({
      owner: parsed.owner,
      repo: parsed.repo,
      title,
      body,
      head,
      base,
      draft: msg.draft,
    });

    ctx.send({
      type: "github_pr_created",
      success: result.success,
      url: result.url,
      number: result.number,
      message: result.message,
    });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to create PR: ${getErrorMessage(err)}` });
  }
}

export async function handleMergePr(ctx: HandlerContext, msg: WsMergePr): Promise<void> {
  if (!ctx.githubAuthManager.authenticated) {
    ctx.send({ type: "merge_pr_result", success: false, message: "Not authenticated with GitHub" });
    return;
  }

  try {
    const git = ctx.getActiveGitManager();
    const remotes = await git.getRemotes();
    const origin = remotes.find((r) => r.name === "origin");
    if (!origin) {
      ctx.send({ type: "merge_pr_result", success: false, message: "No origin remote configured" });
      return;
    }

    const parsed = GitManager.parseGitHubRemote(origin.url);
    if (!parsed) {
      ctx.send({ type: "merge_pr_result", success: false, message: "Remote URL is not a GitHub repository" });
      return;
    }

    const head = await git.getCurrentBranch();
    const pr = await ctx.githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);
    if (!pr) {
      ctx.send({ type: "merge_pr_result", success: false, message: "No active PR for current branch" });
      return;
    }

    const method = msg.method || "merge";

    // First, try direct merge
    const result = await ctx.githubAuthManager.mergePullRequest(parsed.owner, parsed.repo, pr.number, method);

    if (result.success) {
      ctx.send({ type: "merge_pr_result", success: true, message: "Pull request merged" });
      ctx.send({ type: "pr_status", pr: null });
      return;
    }

    // If merge failed because checks are pending, enable auto-merge
    const checks = await ctx.githubAuthManager.getCheckStatus(parsed.owner, parsed.repo, head);
    if (checks.state === "pending") {
      const graphqlMethod = method === "merge" ? "MERGE" as const : method === "squash" ? "SQUASH" as const : "REBASE" as const;
      const autoResult = await ctx.githubAuthManager.enableAutoMerge(parsed.owner, parsed.repo, pr.number, graphqlMethod);
      ctx.send({
        type: "merge_pr_result",
        success: autoResult.success,
        message: autoResult.message,
        autoMergeEnabled: autoResult.success,
      });
      return;
    }

    // Checks failed or other issue
    ctx.send({ type: "merge_pr_result", success: false, message: result.message });
  } catch (err) {
    ctx.send({ type: "merge_pr_result", success: false, message: `Merge failed: ${getErrorMessage(err)}` });
  }
}

export async function handleGeneratePrDescription(ctx: HandlerContext): Promise<void> {
  try {
    const git = ctx.getActiveGitManager();
    const log = await git.log(20);
    const diff = await git.diffSummary();

    if (log.length === 0) {
      ctx.send({ type: "generated_pr_description", description: "" });
      return;
    }

    const prompt = [
      "Write a pull request description summarizing these changes.",
      "Format as markdown with ## Summary (1-2 sentences) and ## Changes (bullet points).",
      "Keep it concise — 5-10 bullet points maximum.",
      "Return ONLY the markdown description, no extra commentary.",
      "",
      "Recent commits:",
      ...log.map((c) => `- ${c.message}`),
      "",
      "Files changed:",
      ...(diff.length > 0
        ? diff.map((f) => `- ${f.file} (+${f.insertions} -${f.deletions})`)
        : ["(no file-level diff available)"]),
    ].join("\n");

    const activeSessionDir = ctx.getActiveSessionDir();
    const description = await ctx.generateText(prompt, activeSessionDir ?? undefined);
    ctx.send({ type: "generated_pr_description", description: description.trim() });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to generate description: ${getErrorMessage(err)}` });
  }
}
