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
  onComplete: () => void;
}

interface HeroFeature {
  Icon: ComponentType<IconProps>;
  tint: string;
  lead: string;
  rest: string;
}

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
