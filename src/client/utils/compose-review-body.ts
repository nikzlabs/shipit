

export type ReviewerMode = "role" | "subagent";

export interface ReviewComposition {
  mode: ReviewerMode;

  selfName: string;
}

export function displayAgentName(agentId: string): string {
  if (!agentId) return "the agent";
  return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

export function resolveReviewer(args: {
  enableSubAgents: boolean;
  activeAgentId: string;
}): ReviewComposition {
  const selfName = displayAgentName(args.activeAgentId);
  return { mode: args.enableSubAgents ? "role" : "subagent", selfName };
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

  if (opts.mode === "role") {
    lines.push(
      "Delegate this review to ShipIt's configured reviewer, for a genuine second",
      "opinion. Run `shipit agent run --role reviewer --prompt-file -` and feed it",
      "the review brief below on stdin (write the brief to a file or use a heredoc —",
      "your choice; don't indent the heredoc terminator).",
      "",
      "Name the ROLE and nothing else: no --agent, no --model, no reasoning level.",
      "ShipIt picks the reviewer from its own settings — the one furthest from you",
      "that this install can run — so do not reason about which backend is far from",
      "you, and do not substitute a backend you happen to know is installed.",
      "",
      "--- review brief (pass to the reviewer on stdin) ---",
      ...reviewBrief(filePath),
      "--- end brief ---",
      "",
      "ShipIt renders the reviewer's output for the user automatically — inline, in",
      "the consult card. You do NOT record it and you call NO tool. Read the markdown",
      "from stdout and use it only to apply fixes and (optionally) re-review.",
      "",
      "If `shipit agent run` exits non-zero for ANY reason (Multi-agent disabled, no",
      "configured reviewer can run right now, the session not pinned/active, or the",
      "per-turn spawn cap hit), do NOT abort the turn. Instead spawn one fresh",
      "same-model Task subagent with the same brief and present its findings to the",
      "user as prose, noting that the configured reviewer was unavailable.",
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
