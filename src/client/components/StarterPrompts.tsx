import {
  GitPullRequestIcon,
  CloudArrowUpIcon,
  TreeStructureIcon,
  RobotIcon,
  LifebuoyIcon,
  BookOpenIcon,
  BugIcon,
  FlaskIcon,
  ArrowRightIcon,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

interface StarterPrompt {
  icon: Icon;
  /** Short chip label shown to the user. */
  label: string;
  /** Full prompt seeded into the composer on click (may differ from the label). */
  prompt: string;
}

// The chips are a DISCOVERABILITY surface: each one seeds a prompt that exercises
// a ShipIt-specific, integrated capability the user would otherwise never know to
// ask for (open a PR from chat, deploy, a second opinion from another agent
// backend, file a ShipIt bug, plan with a rendered diagram). Every prompt is
// sendable as a first message — nothing here assumes prior work in the session.
const SCRATCH_PROMPTS: StarterPrompt[] = [
  {
    icon: GitPullRequestIcon,
    label: "Build an app, then open a PR",
    prompt: "Build a simple expense tracker, then open a pull request so I can review the changes.",
  },
  {
    icon: CloudArrowUpIcon,
    label: "Build & deploy to Vercel",
    prompt: "Build a personal landing page and deploy it to Vercel.",
  },
  {
    icon: TreeStructureIcon,
    label: "Plan it with a diagram first",
    prompt: "Before we build, sketch the architecture for a chat app as a diagram I can look at.",
  },
  {
    icon: RobotIcon,
    label: "Second opinion from another agent",
    prompt: "I want to build a REST API — ask Codex for a second opinion on the best structure before we start.",
  },
  {
    icon: LifebuoyIcon,
    label: "Report a ShipIt bug",
    prompt: "Something in ShipIt isn't working right — help me put together a bug report for the ShipIt team.",
  },
];

const REPO_PROMPTS: StarterPrompt[] = [
  {
    icon: BookOpenIcon,
    label: "Explain this project",
    prompt: "Explain what this project does and how the codebase is structured.",
  },
  {
    icon: BugIcon,
    label: "Find a bug, fix it, open a PR",
    prompt: "Find a bug in this codebase, fix it, and open a pull request with the change.",
  },
  {
    icon: RobotIcon,
    label: "Second opinion from another agent",
    prompt: "Ask Codex to review this project's architecture and suggest improvements.",
  },
  {
    icon: FlaskIcon,
    label: "Write tests for weak spots",
    prompt: "Find the part of this codebase with the least test coverage and write tests for it.",
  },
  {
    icon: LifebuoyIcon,
    label: "Report a ShipIt bug",
    prompt: "Something in ShipIt isn't working right — help me put together a bug report for the ShipIt team.",
  },
];

export interface StarterPromptsProps {
  /** Whether the session is tied to a Git repo (vs a scratch/sandbox session). */
  repoBacked: boolean;
  /** Seed the composer with a prompt for the user to review and send. */
  onPick: (prompt: string) => void;
}

/**
 * First-session discoverability launchpad (docs/216). A short lead-in plus
 * clickable chips that each seed the composer with a prompt exercising a
 * ShipIt-specific, integrated capability — teaching the chat-as-input model
 * (CLAUDE.md §5) by example rather than telling it in a banner.
 *
 * Anchored to the TOP of the empty chat area, clear of the decorative rocket
 * (which rests at the bottom and lifts off later, at z-index -1). Gated on the
 * same empty-state condition as the rocket, so it appears on every empty session
 * and disappears the instant the first message lands — nothing to dismiss. The
 * layer is pointer-events-none so it never blocks the rocket; only the chips
 * re-enable pointer events.
 */
export function StarterPrompts({ repoBacked, onPick }: StarterPromptsProps) {
  const prompts = repoBacked ? REPO_PROMPTS : SCRATCH_PROMPTS;
  const leadIn = repoBacked
    ? "Tell me what to change — I can explain the code, fix bugs, open a pull request, or get a second opinion from another agent. Try:"
    : "Tell me what to build — I'll write the code and preview it live, and can open a PR or deploy when you're ready. Try:";

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center px-4 pt-4 animate-in fade-in-0 duration-500">
      <div className="pointer-events-auto w-full max-w-md space-y-3">
        <p className="text-center text-xs text-(--color-text-tertiary) text-balance">{leadIn}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {prompts.map(({ icon: PromptIcon, label, prompt }) => (
            <button
              key={label}
              type="button"
              onClick={() => onPick(prompt)}
              className="group flex items-center gap-2 rounded-full border border-(--color-border-primary) bg-(--color-bg-secondary)/80 px-3 py-1.5 text-xs text-(--color-text-secondary) backdrop-blur-sm transition-colors hover:border-(--color-border-secondary) hover:bg-(--color-bg-tertiary) hover:text-(--color-text-primary)"
            >
              <PromptIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-accent)" />
              <span>{label}</span>
              <ArrowRightIcon size={ICON_SIZE.XS} weight="bold" className="shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
