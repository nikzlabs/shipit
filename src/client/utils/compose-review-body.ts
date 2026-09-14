

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
    "A review that comes back is INPUT, not your final answer:",
    "- Apply fixes for the material findings (the reviewer only reviews; it does",
    "  not edit).",
    "- If your fixes were substantial you MAY run one fresh re-review the same way.",
    "  Fix only new blockers or regressions; do not loop on nits.",
    "- Your final reply should describe the fixes you applied and any verification",
    "  you ran — not merely repeat the review.",
  ];
}

/**
 * The brokered reviewer is the only path, and a failed brokered run ends the
 * review. No `Task` fallback: a subagent under the same model shares the author's
 * blind spots, and `Task` is a Claude tool that a harness like Antigravity never
 * offers the model, so the instruction was undeliverable there (planning#571).
 */
export function composeReviewMessage(filePath: string): string {
  return [
    `Review ${filePath}.`,
    "",
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
    "If `shipit agent run` exits non-zero for ANY reason (no configured reviewer can",
    "run right now, Multi-agent sessions off, the session not pinned/active, or the",
    "per-turn spawn cap hit), that is the end of the review: say so in your reply and",
    "quote the reason the command printed, so the user can act on it. Do NOT review",
    "the file yourself and do NOT substitute another reviewer of your own choosing —",
    "a review you write about your own work is not a second opinion.",
    ...parentFollowUp(),
  ].join("\n");
}
