import {
  StorefrontIcon,
  UserCircleIcon,
  CheckSquareIcon,
  GameControllerIcon,
  BookOpenIcon,
  BugIcon,
  SparkleIcon,
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

// Two prompt sets. Each prompt is a real end-to-end task so the example itself
// communicates that ShipIt is integrated — the agent writes the code, runs the
// live preview, and can open a PR — without us spelling it out in a banner.
const SCRATCH_PROMPTS: StarterPrompt[] = [
  {
    icon: StorefrontIcon,
    label: "Landing page for a coffee shop",
    prompt: "Build a landing page for a coffee shop and show me the live preview.",
  },
  {
    icon: UserCircleIcon,
    label: "Personal portfolio site",
    prompt: "Create a personal portfolio site with an about section and a project gallery.",
  },
  {
    icon: CheckSquareIcon,
    label: "A to-do app I can use",
    prompt: "Build a to-do app where I can add, complete, and delete tasks.",
  },
  {
    icon: GameControllerIcon,
    label: "A game to play in the browser",
    prompt: "Build a simple Snake game I can play in the browser.",
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
    label: "Find and fix a bug, open a PR",
    prompt: "Find a bug in this codebase, fix it, and open a pull request with the change.",
  },
  {
    icon: SparkleIcon,
    label: "Add a feature",
    prompt: "I'd like to add a new feature. Ask me what I have in mind, then implement it.",
  },
  {
    icon: FlaskIcon,
    label: "Write tests for weak spots",
    prompt: "Find the part of this codebase with the least test coverage and write tests for it.",
  },
];

export interface StarterPromptsProps {
  /** Whether the session is tied to a Git repo (vs a scratch/sandbox session). */
  repoBacked: boolean;
  /** Seed the composer with a prompt for the user to review and send. */
  onPick: (prompt: string) => void;
}

/**
 * Empty-state launchpad shown on a fresh session (docs/216). A short lead-in
 * plus a few clickable example prompts that seed the composer — teaching the
 * chat-as-input model (CLAUDE.md §5) rather than telling it in a banner.
 *
 * Rendered in front of the decorative rocket (which sits at z-index -1) and
 * gated on the same empty-state condition, so it appears on every empty session
 * and disappears the instant the first message lands. The layer is
 * pointer-events-none so it never blocks the rocket; only the chips re-enable
 * pointer events.
 */
export function StarterPrompts({ repoBacked, onPick }: StarterPromptsProps) {
  const prompts = repoBacked ? REPO_PROMPTS : SCRATCH_PROMPTS;
  const leadIn = repoBacked
    ? "Tell me what to change — I'll edit the code, run the live preview, and open a pull request when it's ready. Try:"
    : "Just describe what you want — I'll write the code and show you a live preview as I build. Try:";

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-3 animate-in fade-in-0 duration-500">
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
