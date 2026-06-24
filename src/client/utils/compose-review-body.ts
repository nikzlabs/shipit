/**
 * compose-review-body — builds the chat message that kicks off an AI review
 * (docs/203, docs/220).
 *
 * The reviewer is resolved **on the client at button-press time** from the
 * settings store + agent registry, so the prompt is concrete (not
 * self-correcting):
 *   - Multi-agent sessions on AND a *different* agent is signed in → **cross-agent**:
 *     the parent runs `shipit agent run --agent <other> --prompt-file -` for a
 *     genuine second-model opinion. ShipIt surfaces that reviewer's verbatim
 *     output inline, in the consult card (docs/220) — so the parent records
 *     nothing and calls no tool; it reads the markdown from stdout only to apply
 *     fixes.
 *   - otherwise → **subagent**: the parent spawns one fresh same-model `Task` and
 *     **presents its findings to the user as prose**. A same-model review is the
 *     agent's own internal work — ShipIt only renders what it *brokers*, so there
 *     is no card here (docs/220).
 *
 * In both modes the reviewer READS the file with its own read-only tools (it runs
 * in the same workspace) and returns **markdown only** — it calls no MCP tool.
 * There is no `submit_review` tool: cross-agent output is shown by the consult
 * card, same-model output is narrated by the parent.
 *
 * No draft-comment embedding — that belongs to the user-comment system, which is
 * fully decoupled from AI review.
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
    "- Return the markdown as your final message. Do NOT call any MCP tool.",
  ];
}

function parentFollowUp(): string[] {
  return [
    "",
    "The review is INPUT, not your final answer:",
    "- Apply fixes for the material findings (the reviewer only reviews; it does",
    "  not edit).",
    "- If your fixes were substantial you MAY run one fresh re-review the same way.",
    "  Fix only new blockers or regressions; do not loop on nits.",
    "- Your final reply should describe the fixes you applied and any verification",
    "  you ran — not merely repeat the review.",
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
      `ShipIt renders ${reviewerName}'s output for the user automatically — inline, in`,
      "the consult card. You do NOT record it and you call NO tool. Read the markdown",
      "from stdout and use it only to apply fixes and (optionally) re-review.",
      "",
      `If \`shipit agent run\` exits non-zero for ANY reason (Multi-agent disabled,`,
      `${reviewerName} not signed in, the session not pinned/active, or the per-turn`,
      "spawn cap hit), do NOT abort the turn. Instead spawn one fresh same-model Task",
      `subagent with the same brief and present its findings to the user as prose,`,
      `noting that ${reviewerName} was unavailable.`,
    );
  } else {
    lines.push(
      "You (the parent) likely wrote or edited this file, so do not review it",
      "yourself — a first-person review is biased. Spawn one fresh Task subagent and",
      "give it the brief below.",
      "",
      ...reviewBrief(filePath),
      "",
      "The subagent's findings are second-opinion INPUT for you, not a card: present",
      "them to the user as prose in your reply (you call NO tool), then act on them.",
    );
  }

  lines.push(...parentFollowUp());
  return lines.join("\n");
}
