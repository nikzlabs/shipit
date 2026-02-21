import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";

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
