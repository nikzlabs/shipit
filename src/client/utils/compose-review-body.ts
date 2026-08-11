/**
 * compose-review-body — builds the chat message that kicks off an AI review
 * (docs/203, docs/220, docs/261).
 *
 * **This file used to choose the reviewer, and no longer does** (docs/261 req 6).
 * It picked the first *other* installed backend and wrote `--agent <other>` into
 * the prompt — ShipIt naming a reviewer by harness, in the product's own words,
 * which is the exact thing the role replaces. What survives here is the one
 * question the client can still answer: whether the brokered path is available
 * at all.
 *
 *   - Multi-agent sessions on → **role**: the parent runs
 *     `shipit agent run --role reviewer --prompt-file -`, and ShipIt resolves who
 *     reviews from its own settings — ranked to be as far from the implementer as
 *     the install allows (docs/261 req 4). ShipIt surfaces that reviewer's
 *     verbatim output inline, in the consult card (docs/220) — so the parent
 *     records nothing and calls no tool; it reads the markdown from stdout only
 *     to apply fixes.
 *   - off → **subagent**: `shipit agent run` is refused outright, so the parent
 *     spawns one fresh same-model `Task` and **presents its findings to the user
 *     as prose**. A same-model review is the agent's own internal work — ShipIt
 *     only renders what it *brokers*, so there is no card here (docs/220).
 *
 * The mode is resolved **on the client at button-press time**, so the prompt is
 * concrete rather than self-correcting; the *reviewer* is resolved on the server
 * at spawn admission, which is why nothing here names one.
 *
 * In both modes the reviewer READS the file with its own read-only tools (it runs
 * in the same workspace) and returns **markdown only** — it calls no MCP tool.
 * There is no `submit_review` tool: the role's output is shown by the consult
 * card, same-model output is narrated by the parent.
 *
 * No draft-comment embedding — that belongs to the user-comment system, which is
 * fully decoupled from AI review.
 */

export type ReviewerMode = "role" | "subagent";

export interface ReviewComposition {
  mode: ReviewerMode;
  /** Display name for the current/parent agent, e.g. "Claude". */
  selfName: string;
}

/** Short, user-facing agent name for the card attribution ("claude" → "Claude"). */
export function displayAgentName(agentId: string): string {
  if (!agentId) return "the agent";
  return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

/**
 * Resolve the review MODE from a settings snapshot taken at click time. Pure, so
 * the one remaining branch is directly testable.
 *
 * The registry is deliberately no longer consulted (docs/261 req 6). "Is a
 * *different* backend installed and authed?" was the client deciding who
 * reviews; ShipIt now decides that on the server, from the reviewer settings,
 * and it can pick a distant *model* on the same harness — an answer this check
 * would have thrown away. What is left is the availability gate that genuinely
 * belongs to the caller: `shipit agent run` is refused outright when Multi-agent
 * sessions is off, so that case still composes a same-model `Task` review.
 */
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
