import { useState, useRef, type ReactNode, type ComponentType } from "react";
import {
  GitPullRequestIcon,
  CheckCircleIcon,
  RocketLaunchIcon,
  RobotIcon,
  KeyIcon,
  ColumnsIcon,
  type IconProps,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { AgentOption } from "../agent-types.js";
import { Button } from "./ui/button.js";
import { ProviderAccountsCard } from "./Settings/ProviderAccountsCard.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";
import { Logo } from "./Logo.js";

export interface OnboardingWizardProps {
  // Step 1: GitHub connect
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
  // Step 2: Agent setup
  agents: AgentOption[];
  onClaudeApiKeySubmit: (key: string) => Promise<boolean>;
  onCodexApiKeySubmit: (key: string) => Promise<boolean>;
  onRefreshAgents: () => Promise<void>;
  // Completion
  onComplete: () => void;
  // Skip step 1 if GitHub / git identity is already set
  initialStep?: 1 | 2;
}

function StepDots({ current }: { current: 1 | 2 }) {
  return (
    <div className="flex justify-center gap-2" data-testid="step-dots">
      <span
        className={`w-2 h-2 rounded-full transition-colors ${current >= 1 ? "bg-(--color-accent)" : "bg-(--color-text-tertiary)"}`}
        data-testid="step-dot-1"
      />
      <span
        className={`w-2 h-2 rounded-full transition-colors ${current >= 2 ? "bg-(--color-accent)" : "bg-(--color-text-tertiary)"}`}
        data-testid="step-dot-2"
      />
    </div>
  );
}

interface HeroFeature {
  Icon: ComponentType<IconProps>;
  /** Tailwind tint classes for the icon tile (subtle bg + matching fg). */
  tint: string;
  lead: string;
  rest: string;
}

/**
 * Left panel of the onboarding split layout. Pitches the product so a
 * first-time user understands what ShipIt is — and why the step they're on
 * matters — before they act. Hidden below `md` (onboarding is desktop-first;
 * the right pane stands alone on narrow screens).
 */
function WizardHero({
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

const STEP1_FEATURES: HeroFeature[] = [
  { Icon: GitPullRequestIcon, tint: "bg-(--color-pr-subtle) text-(--color-pr)", lead: "A pull request per session", rest: "— reviewed inline." },
  { Icon: CheckCircleIcon, tint: "bg-(--color-success-subtle) text-(--color-success)", lead: "CI & deploy status", rest: "— live in the PR card." },
  { Icon: RocketLaunchIcon, tint: "bg-(--color-accent-subtle) text-(--color-accent)", lead: "Merge & ship from chat", rest: "— no context-switch." },
];

const STEP2_FEATURES: HeroFeature[] = [
  { Icon: RobotIcon, tint: "bg-(--color-accent-subtle) text-(--color-accent)", lead: "Claude Code & Codex", rest: "— switch agents per session." },
  { Icon: KeyIcon, tint: "bg-(--color-success-subtle) text-(--color-success)", lead: "Use your existing subscription", rest: "— no API keys required." },
  { Icon: ColumnsIcon, tint: "bg-(--color-pr-subtle) text-(--color-pr)", lead: "Run agents in parallel", rest: "— each session its own branch." },
];

/**
 * docs/150 req 16 — connecting an account uses the same UI for the first
 * account and for every subsequent one.
 *
 * This step used to be the *other* half of the divergence req 16 names: it
 * rendered the provider-wide `ClaudeAuthCard` / `CodexAuthCard`, whose "Sign
 * in" button hit the singleton `/api/auth/start` and `/api/codex-auth/start`
 * endpoints and parked the resulting challenge in a provider-wide store slot.
 * A user's *first* account was therefore connected by different code, through
 * different endpoints, than their second — and the first one connected here
 * wasn't even reachable from the account rows afterwards. Onboarding now
 * renders the same {@link ProviderAccountsCard} Settings does, so there is one
 * connect flow with one endpoint family and one piece of state behind it.
 */
export function OnboardingWizard({
  onGitHubTokenSubmit,
  agents,
  onClaudeApiKeySubmit,
  onCodexApiKeySubmit,
  onRefreshAgents,
  onComplete,
  initialStep = 1,
}: OnboardingWizardProps) {
  const [step, setStep] = useState<1 | 2>(initialStep);

  // If initialStep changes to 1 after mount (e.g. GitHub status flips to
  // not-connected after the wizard was already triggered by the agent list),
  // jump back to step 1.
  const prevInitialStepRef = useRef(initialStep);
  if (prevInitialStepRef.current !== initialStep) {
    prevInitialStepRef.current = initialStep;
    if (initialStep === 1) setStep(1);
  }

  // Step 2 state
  const [refreshing, setRefreshing] = useState(false);
  const [completing, setCompleting] = useState(false);

  // Step 2 derived
  const claudeAgent = agents.find((a) => a.id === "claude");
  const codexAgent = agents.find((a) => a.id === "codex");
  const anyAgentReady = agents.some((a) => a.installed && a.authConfigured);

  const handleGitHubTokenSubmit = async (token: string): Promise<boolean | undefined> => {
    const success = await onGitHubTokenSubmit(token);
    if (success) {
      setStep(2);
    }
    return success;
  };

  // `ProviderAccountsCard` reports API-key failures by catching a throw; the
  // onboarding callbacks report them by resolving `false`. Bridge the two so a
  // rejected key surfaces as the card's inline error instead of reading as
  // success.
  const apiKeySubmitter = (submit: (key: string) => Promise<boolean>) => async (key: string) => {
    if (!(await submit(key))) throw new Error("API key was not accepted");
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshAgents();
    } catch {
      // ignore
    }
    setRefreshing(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-(--color-bg-overlay) backdrop-blur-sm p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {/* Fixed height on desktop so the modal never resizes when an agent's
          OAuth / device-auth flow or API-key field expands — the right pane
          scrolls internally instead (see the pane's overflow-y-auto + min-h-0).
          Height is auto on mobile (single column), capped by max-h-[92vh].

          Step 2 is taller because it stacks two provider cards. It is still a
          *fixed* height per step, so the no-resize-on-expand property holds;
          it is just a different constant for a step whose content is bigger.
          At 520 the "Get Started" button fell below the fold with no scroll
          cue — a first-run user saw no way forward. */}
      <div className={`w-full max-w-3xl ${step === 1 ? "md:h-[520px]" : "md:h-[600px]"} max-h-[92vh] overflow-hidden rounded-xl bg-(--color-bg-elevated) border border-(--color-border-secondary) grid md:grid-cols-2`}>
        {step === 1 ? (
          <WizardHero
            title={
              <>
                Build, review, and <span className="text-(--color-pr)">ship</span> — all in one chat window.
              </>
            }
            lede="Describe what you want; the agent writes the code. Each session becomes a branch you review as a pull request and merge — without ever leaving ShipIt. That review-and-ship loop is powered by GitHub, so we connect it first."
            features={STEP1_FEATURES}
          />
        ) : (
          <WizardHero
            title={
              <>
                Your agent writes the code. <span className="text-(--color-pr)">You</span> steer and ship.
              </>
            }
            lede="ShipIt is agent-agnostic — sign in with the AI subscription you already pay for, no per-call API keys. Describe what you want in chat; the agent edits files, runs commands, and reads the logs while you review and direct."
            features={STEP2_FEATURES}
          />
        )}

        {/* Right pane — min-h-0 lets overflow-y-auto actually scroll inside the
            fixed-height grid cell instead of stretching the modal. */}
        <div className="p-8 overflow-y-auto min-h-0 flex flex-col gap-6">
          <StepDots current={step} />

          {step === 1 ? (
            <>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-(--color-text-primary)">
                  Connect GitHub
                </h2>
                <p className="text-sm text-(--color-text-secondary)">
                  Paste a token to set up your git identity and enable push, pull requests, CI, and deploys.
                </p>
              </div>

              <GitHubTokenForm onSubmit={handleGitHubTokenSubmit} />
            </>
          ) : (
            <>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-(--color-text-primary)">
                  Connect an agent
                </h2>
                <p className="text-sm text-(--color-text-secondary)">
                  Sign in with a subscription you already have. You need at least one to start.
                </p>
              </div>

              {/*
                docs/252 phase 9 (req 14) — don't offer to connect an account for a
                harness this deployment did not install: the credential could never
                be used, and the harness set is not something the user can change
                from here. `!== false` rather than a truthiness test so the cards
                still render while the agent list is loading (the pre-list state is
                "unknown", not "absent").
              */}
              <div className="space-y-5">
                {claudeAgent?.installed !== false && (
                  <ProviderAccountsCard
                    provider="claude"
                    agent={claudeAgent}
                    compact
                    onSubmitApiKey={apiKeySubmitter(onClaudeApiKeySubmit)}
                  />
                )}

                {codexAgent?.installed !== false && (
                  <ProviderAccountsCard
                    provider="codex"
                    agent={codexAgent}
                    compact
                    onSubmitApiKey={apiKeySubmitter(onCodexApiKeySubmit)}
                  />
                )}

                {agents.filter((a) => a.installed && a.id !== "claude" && a.id !== "codex").map((agent) => (
                  <div key={agent.id} className="flex items-center gap-3 p-3 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary)">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      agent.authConfigured ? "bg-(--color-success)" : "bg-(--color-warning)"
                    }`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-(--color-text-primary)">{agent.name}</p>
                      <p className="text-xs text-(--color-text-secondary)">
                        {agent.authConfigured ? "Authenticated" : "Needs auth"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => {
                    setCompleting(true);
                    onComplete();
                  }}
                  disabled={!anyAgentReady || completing}
                  className="w-full rounded-lg py-2.5"
                  data-testid="get-started"
                >
                  {completing ? "Starting..." : "Get Started"}
                </Button>

                <Button
                  variant="ghost"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="w-full"
                  data-testid="refresh-agents"
                >
                  {refreshing ? "Refreshing..." : "Refresh status"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
