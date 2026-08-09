import { type ReactNode, type ComponentType } from "react";
import {
  GitPullRequestIcon,
  CheckCircleIcon,
  RocketLaunchIcon,
  type IconProps,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";
import { Logo } from "./Logo.js";

export interface GitHubGateProps {
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
  /**
   * Called once GitHub is connected. This is the gate's dismissal, and it is
   * the substitution docs/257 makes for the deleted "Get Started" button: the
   * old wizard's step 1 advanced to step 2 rather than closing only because a
   * second step was waiting behind it.
   */
  onComplete: () => void;
}

interface HeroFeature {
  Icon: ComponentType<IconProps>;
  /** Tailwind tint classes for the icon tile (subtle bg + matching fg). */
  tint: string;
  lead: string;
  rest: string;
}

/**
 * Left panel of the split layout. Pitches the product so a first-time user
 * understands what ShipIt is — and why the step they're on matters — before
 * they act. Hidden below `md` (the gate is desktop-first; the right pane stands
 * alone on narrow screens).
 */
function GateHero({
  title,
  lede,
  features,
}: {
  title: ReactNode;
  lede: string;
  features: HeroFeature[];
}) {
  return (
    <div className="hidden md:flex flex-col gap-6 p-8 border-r border-(--color-border-secondary) bg-(--color-bg-secondary)">
      <Logo size="lg" textClassName="text-(--color-text-primary)" />

      <div>
        <h1 className="text-xl font-semibold leading-snug text-(--color-text-primary)">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-(--color-text-secondary)">
          {lede}
        </p>
      </div>

      <div className="flex flex-col gap-0.5">
        {features.map((f, i) => (
          <div key={i} className="flex items-start gap-3 py-1">
            <span
              className={`w-[30px] h-[30px] rounded-lg flex items-center justify-center shrink-0 ${f.tint}`}
            >
              <f.Icon size={ICON_SIZE.SM} />
            </span>
            <p className="pt-1 text-[13px] leading-snug">
              <span className="font-semibold text-(--color-text-primary)">{f.lead}</span>{" "}
              <span className="text-(--color-text-secondary)">{f.rest}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

const FEATURES: HeroFeature[] = [
  { Icon: GitPullRequestIcon, tint: "bg-(--color-pr-subtle) text-(--color-pr)", lead: "A pull request per session", rest: "— reviewed inline." },
  { Icon: CheckCircleIcon, tint: "bg-(--color-success-subtle) text-(--color-success)", lead: "CI & deploy status", rest: "— live in the PR card." },
  { Icon: RocketLaunchIcon, tint: "bg-(--color-accent-subtle) text-(--color-accent)", lead: "Merge & ship from chat", rest: "— no context-switch." },
];

/**
 * docs/257 — the GitHub half of first-run setup, and **only** that half.
 *
 * This is the old `OnboardingWizard` with its second step removed. The two
 * halves of first-run setup separate rather than merge: connecting GitHub keeps
 * today's behaviour **in full, including that it blocks** (docs/257
 * requirements → *Out of scope*), while connecting a harness credential leaves
 * the overlay entirely and becomes {@link HarnessOnboardingPanel}, an inline
 * panel in the conversation view that covers nothing.
 *
 * So there are no step dots, no `initialStep`, and no agent props: one step
 * cannot be a sequence, and the sequence req 4 asks for now lives in the
 * panel's "Add a service" dialog. A revoked token re-gates on the next load
 * exactly as it does now — `App.tsx` keeps the trigger latch that governs that,
 * which is load-bearing for the one case where today it deliberately does *not*
 * re-gate (a user who completed the gate in this same page load).
 */
export function GitHubGate({ onGitHubTokenSubmit, onComplete }: GitHubGateProps) {
  const handleGitHubTokenSubmit = async (token: string): Promise<boolean | undefined> => {
    const success = await onGitHubTokenSubmit(token);
    if (success) onComplete();
    return success;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-(--color-bg-overlay) backdrop-blur-sm p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      data-testid="github-gate"
    >
      {/* Fixed height on desktop so the panel never resizes when the token
          form's error or help text expands — the right pane scrolls internally
          instead (see its overflow-y-auto + min-h-0). Height is auto on mobile
          (single column), capped by max-h-[92vh]. */}
      <div className="w-full max-w-3xl md:h-[520px] max-h-[92vh] overflow-hidden rounded-xl bg-(--color-bg-elevated) border border-(--color-border-secondary) grid md:grid-cols-2">
        <GateHero
          title={
            <>
              Build, review, and <span className="text-(--color-pr)">ship</span> — all in one chat window.
            </>
          }
          lede="Describe what you want; the agent writes the code. Each session becomes a branch you review as a pull request and merge — without ever leaving ShipIt. That review-and-ship loop is powered by GitHub, so we connect it first."
          features={FEATURES}
        />

        {/* Right pane — min-h-0 lets overflow-y-auto actually scroll inside the
            fixed-height grid cell instead of stretching the panel. */}
        <div className="p-8 overflow-y-auto min-h-0 flex flex-col gap-6">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-(--color-text-primary)">
              Connect GitHub
            </h2>
            <p className="text-sm text-(--color-text-secondary)">
              Paste a token to set up your git identity and enable push, pull requests, CI, and deploys.
            </p>
          </div>

          <GitHubTokenForm onSubmit={handleGitHubTokenSubmit} />
        </div>
      </div>
    </div>
  );
}
