import { RobotIcon, KeyIcon, ColumnsIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { AgentOption } from "../agent-types.js";
import { Logo } from "./Logo.js";
import { ServicesPanel } from "./Settings/ServicesPanel.js";

const FEATURES = [
  {
    Icon: RobotIcon,
    tint: "bg-(--color-accent-subtle) text-(--color-accent)",
    label: "Any model provider ShipIt ships with",
  },
  {
    Icon: KeyIcon,
    tint: "bg-(--color-success-subtle) text-(--color-success)",
    label: "A subscription you pay for, or an API key",
  },
  {
    Icon: ColumnsIcon,
    tint: "bg-(--color-pr-subtle) text-(--color-pr)",
    label: "Parallel agents, one branch each",
  },
];

export function HarnessOnboardingPanel({ agentList }: { agentList: AgentOption[] }) {
  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto"
      data-testid="harness-onboarding-panel"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
        <div className="flex flex-col gap-2.5 px-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Logo size="md" textClassName="text-(--color-text-primary)" />
            <h1 className="text-lg font-semibold leading-snug text-(--color-text-primary)">
              Add a model provider, and the chat starts working.
            </h1>
          </div>
          <p className="text-sm leading-snug text-(--color-text-secondary)">
            ShipIt is agent-agnostic. Files, previews and the terminal already work — the chat is
            the one thing waiting on this.
          </p>
          <ul className="flex flex-col gap-1.5">
            {FEATURES.map((f, i) => (
              <li
                key={i}
                className="flex items-center gap-2 text-[13px] leading-snug text-(--color-text-secondary)"
              >
                <span
                  className={`w-[22px] h-[22px] rounded-md flex items-center justify-center shrink-0 ${f.tint}`}
                >
                  <f.Icon size={ICON_SIZE.XS} />
                </span>
                {f.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) px-4 py-3.5">
          <ServicesPanel agentList={agentList} />
        </div>
      </div>
    </div>
  );
}
