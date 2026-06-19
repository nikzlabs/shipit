/**
 * compose-review-body — builds the chat message that kicks off a plain-text AI
 * review (docs/203, supersedes the docs/125/151 draft-embedding version).
 *
 * The reviewer is resolved **on the client at button-press time** from the
 * settings store + agent registry, so the prompt is concrete (not
 * self-correcting):
 *   - Multi-agent sessions on AND a *different* agent is signed in → **cross-agent**:
 *     the parent runs `shipit agent run --agent <other> --prompt-file -` for a
 *     genuine second-model opinion.
 *   - otherwise → **subagent**: the parent spawns one fresh same-model `Task`.
 *
 * In both modes the reviewer READS the file with its own read-only tools (it
 * runs in the same workspace) and returns **markdown only** — it must not call
 * the `submit_review` MCP tool itself. The parent calls `submit_review` with
 * that markdown to record one review card, then applies fixes and runs one
 * re-review (which patches the same card).
 *
 * Cross-agent failure is a first-class path: `runSubAgent` re-checks
 * enable/auth/pinned/cap at execution time, so `shipit agent run` can still exit
 * non-zero after a clean client decision. The prompt tells the parent to fall
 * back to a same-model `Task` review and note it in the card's reviewer label.
 *
 * No draft-comment embedding — that belongs to the user-comment system, which is
 * now fully decoupled from AI review.
 */

interface RegistryAgent {
  id: string;
  name: string;
  installed: boolean;
  authConfigured: boolean;
}

export type ReviewerMode = "cross-agent" | "subagent";

export interface ReviewComposition {
  mode: ReviewerMode;
  /** The other agent's id (cross-agent only). */
  reviewerAgentId?: string;
  /** Display name for the reviewer, e.g. "Codex" (cross-agent only). */
  reviewerName?: string;
  /** Display name for the current/parent agent, e.g. "Claude". */
  selfName: string;
}

/** Short, user-facing agent name for the card attribution ("claude" → "Claude"). */
export function displayAgentName(agentId: string): string {
  if (!agentId) return "the agent";
  return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

/**
 * Resolve the reviewer from a settings/registry snapshot taken at click time.
 * Pure so the resolution matrix (enableSubAgents × other-agent-authed) is
 * directly testable. Cross-agent only when Multi-agent is on AND a *different*
 * agent is installed + auth-configured; otherwise a fresh same-model subagent.
 */
export function resolveReviewer(args: {
  enableSubAgents: boolean;
  agentList: RegistryAgent[];
  activeAgentId: string;
}): ReviewComposition {
  const selfName = displayAgentName(args.activeAgentId);
  if (args.enableSubAgents) {
    const other = args.agentList.find(
      (a) => a.id !== args.activeAgentId && a.installed && a.authConfigured,
    );
    if (other) {
      return {
        mode: "cross-agent",
        reviewerAgentId: other.id,
        reviewerName: displayAgentName(other.id),
        selfName,
      };
    }
  }
  return { mode: "subagent", selfName };
}

function reviewBrief(filePath: string): string[] {
  return [
    `Review brief for ${filePath} — your final answer is MARKDOWN ONLY:`,
    "- You run in the same workspace. READ the file and any related files with",
    "  your own read-only tools (Read/Grep/Glob/shell) — that is expected, not a",
    "  violation of this brief. Approach the file fresh.",
    "- Report only MATERIAL issues: correctness, safety, completeness, or the",
    "  user's stated goal. Skip nits, style, and speculative concerns.",
    "- Order findings by severity. Write each as `path:line — issue` (line",
    "  optional), then a specific fix on the next line. Omit a finding if you",
    "  cannot name a concrete fix.",
    '- If the file is clean, return exactly: "No material issues found."',
    "- Return the markdown as your final message. Do NOT call the `submit_review`",
    "  tool or any other MCP tool — the parent records the review, not you.",
  ];
}

function parentContinuation(): string[] {
  return [
    "",
    "After you call `submit_review`, the review is INPUT, not your final answer:",
    "- Apply fixes for the material findings (the reviewer only reviews; it does",
    "  not edit).",
    "- Then run ONE fresh re-review the same way and call `submit_review` again",
    "  with the updated markdown — it patches the SAME card, it does not stack a",
    "  second one.",
    "- On the re-review, fix only new blockers or regressions. Do not loop on nits.",
    "- Your final reply to the user should describe the fixes you applied and any",
    "  verification you ran — not merely repeat the review.",
  ];
}

export function composeReviewMessage(filePath: string, opts: ReviewComposition): string {
  const lines: string[] = [`Review ${filePath}.`, ""];

  if (opts.mode === "cross-agent" && opts.reviewerAgentId) {
    const reviewerName = opts.reviewerName ?? displayAgentName(opts.reviewerAgentId);
    lines.push(
      `Delegate this review to ${reviewerName} — a different model, for a genuine`,
      `second opinion. Run \`shipit agent run --agent ${opts.reviewerAgentId} --prompt-file -\``,
      "and feed it the review brief below on stdin (write the brief to a file or use",
      "a heredoc — your choice; don't indent the heredoc terminator).",
      "",
      "--- review brief (pass to the reviewer on stdin) ---",
      ...reviewBrief(filePath),
      "--- end brief ---",
      "",
      `Take ${reviewerName}'s markdown output and call the \`submit_review\` MCP tool`,
      `with the file path, that markdown, and reviewer_label: "Reviewed by ${reviewerName}".`,
      "",
      `If \`shipit agent run\` exits non-zero for ANY reason (Multi-agent disabled,`,
      `${reviewerName} not signed in, the session not pinned/active, or the per-turn`,
      "spawn cap hit), do NOT abort the turn. Instead spawn one fresh same-model",
      "Task subagent with the same brief, take its markdown, and call `submit_review`",
      `with reviewer_label: "Reviewed by ${opts.selfName} (${reviewerName} unavailable)".`,
    );
  } else {
    lines.push(
      "You (the parent) likely wrote or edited this file, so do not review it",
      "yourself — a first-person review is biased. Spawn one fresh Task subagent and",
      "give it the brief below.",
      "",
      ...reviewBrief(filePath),
      "",
      "Take the subagent's markdown output and call the `submit_review` MCP tool",
      `with the file path, that markdown, and reviewer_label: "Reviewed by ${opts.selfName}".`,
    );
  }

  lines.push(...parentContinuation());
  return lines.join("\n");
}
