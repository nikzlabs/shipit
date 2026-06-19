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
import { ClaudeAuthCard } from "./ClaudeAuthCard.js";
import { CodexAuthCard, type CodexDeviceAuthState } from "./CodexAuthCard.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";

export interface OnboardingWizardProps {
  // Step 1: GitHub connect
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
  // Step 2: Agent setup
  agents: AgentOption[];
  onClaudeApiKeySubmit: (key: string) => Promise<boolean>;
  onCodexApiKeySubmit: (key: string) => Promise<boolean>;
  onStartClaudeAuth: () => void;
  authUrl: string | null;
  onPasteAuthCode: (code: string) => void;
  onRefreshAgents: () => Promise<void>;
  // Codex device-auth (feature 119) — optional so legacy callers / tests
  // that only ever cared about the API-key path keep compiling.
  codexDeviceAuth?: CodexDeviceAuthState | null;
  codexDeviceAuthError?: string | null;
  onStartCodexDeviceAuth?: () => void;
  onCancelCodexDeviceAuth?: () => void;
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
      <div className="flex items-center gap-2.5">
        <img src="/favicon.svg" alt="" className="w-8 h-8 rounded-lg" />
        <span className="text-base font-bold tracking-tight text-(--color-text-primary)">
          ShipIt
        </span>
      </div>

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

export function OnboardingWizard({
  onGitHubTokenSubmit,
  agents,
  onClaudeApiKeySubmit,
  onCodexApiKeySubmit,
  onStartClaudeAuth,
  authUrl,
  onPasteAuthCode,
  onRefreshAgents,
  codexDeviceAuth = null,
  codexDeviceAuthError = null,
  onStartCodexDeviceAuth,
  onCancelCodexDeviceAuth,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-(--color-bg-overlay) backdrop-blur-sm p-4">
      {/* Fixed height on desktop so the modal never resizes when an agent's
          OAuth / device-auth flow or API-key field expands — the right pane
          scrolls internally instead (see the pane's overflow-y-auto + min-h-0).
          Height is auto on mobile (single column), capped by max-h-[92vh]. */}
      <div className="w-full max-w-3xl md:h-[600px] max-h-[92vh] overflow-hidden rounded-xl bg-(--color-bg-elevated) border border-(--color-border-secondary) grid md:grid-cols-2">
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

              <div className="space-y-3">
                <ClaudeAuthCard
                  agent={claudeAgent}
                  authUrl={authUrl}
                  onStartAuth={onStartClaudeAuth}
                  onApiKeySubmit={onClaudeApiKeySubmit}
                  onPasteAuthCode={onPasteAuthCode}
                />

                <CodexAuthCard
                  agent={codexAgent}
                  deviceAuth={codexDeviceAuth}
                  deviceAuthError={codexDeviceAuthError}
                  onStartDeviceAuth={onStartCodexDeviceAuth}
                  onCancelDeviceAuth={onCancelCodexDeviceAuth}
                  onApiKeySubmit={onCodexApiKeySubmit}
                />

                {agents.filter((a) => a.id !== "claude" && a.id !== "codex").map((agent) => (
                  <div key={agent.id} className="flex items-center gap-3 p-3 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary)">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      !agent.installed ? "bg-(--color-text-tertiary)" : agent.authConfigured ? "bg-(--color-success)" : "bg-(--color-warning)"
                    }`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-(--color-text-primary)">{agent.name}</p>
                      <p className="text-xs text-(--color-text-secondary)">
                        {!agent.installed ? "Not installed" : agent.authConfigured ? "Authenticated" : "Needs auth"}
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
