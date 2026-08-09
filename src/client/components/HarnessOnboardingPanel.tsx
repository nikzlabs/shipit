import { RobotIcon, KeyIcon, ColumnsIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { AgentOption } from "../agent-types.js";
import { Logo } from "./Logo.js";
import { ServicesPanel } from "./Settings/ServicesPanel.js";

const FEATURES = [
  {
    Icon: RobotIcon,
    tint: "bg-(--color-accent-subtle) text-(--color-accent)",
    lead: "Any service ShipIt ships with",
    rest: "— first-party providers, direct providers and gateways.",
  },
  {
    Icon: KeyIcon,
    tint: "bg-(--color-success-subtle) text-(--color-success)",
    lead: "Use a subscription you already pay for",
    rest: "— or paste an API key.",
  },
  {
    Icon: ColumnsIcon,
    tint: "bg-(--color-pr-subtle) text-(--color-pr)",
    lead: "Run agents in parallel",
    rest: "— each session its own branch.",
  },
];

/**
 * docs/257 (reqs 1, 2, 4, 5, 6, 7, 9) — first-run harness setup, **in** the
 * conversation view rather than over the product.
 *
 * Four properties, each of which a requirement asks for by name:
 *
 * - **It is not a modal and has no backdrop.** It sits in the chat pane's own
 *   slot, so the file tree, previews, the terminal, the sidebar and Settings
 *   all stay live beside it (reqs 1, 2). The only thing this flow ever puts on
 *   top of it is the "Add a service" dialog below (req 5).
 * - **It hosts the Settings → Services surface as-is** — same card list, same
 *   button, same dialog, same steps inside it (req 7). Connecting a harness
 *   here and connecting one from Settings are the same act, so they are the
 *   same code: docs/150 req 16 already paid for the alternative once, when a
 *   user's first account was connected by different code than their second.
 * - **There is no step rail and no completion button.** The panel's own step is
 *   one — add a service — and req 4's sequence is that dialog's own (service →
 *   billing mode → credential). Completion is a computed fact, not a click: the
 *   panel yields the pane the moment the server stamps
 *   `harnessOnboardingCompletedAt`, and what confirms success is the pane
 *   becoming the conversation with a live composer under it.
 * - **One column, not the gate's two.** The chat pane is narrow and tall, so
 *   the hero becomes a compact lede above the surface — which is also what
 *   makes the mobile case fall out without a `hidden md:flex`.
 *
 * GitHub does not appear here at all: that half keeps its blocking gate
 * (`GitHubGate`), and this panel is suppressed while the gate is up.
 */
export function HarnessOnboardingPanel({ agentList }: { agentList: AgentOption[] }) {
  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto"
      data-testid="harness-onboarding-panel"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-8">
        <div className="flex flex-col gap-3 px-1">
          <Logo size="lg" textClassName="text-(--color-text-primary)" />
          <div>
            <h1 className="text-xl font-semibold leading-snug text-(--color-text-primary)">
              Add a service, and the chat starts working.
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-(--color-text-secondary)">
              ShipIt is agent-agnostic — connect the AI subscription you already pay for, or
              paste an API key. Everything else already works: browse the files, open a preview,
              use the terminal. The chat is the one thing waiting on this.
            </p>
          </div>
          <div className="flex flex-col gap-0.5">
            {FEATURES.map((f, i) => (
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

        {/* The Settings surface, hosted whole. It brings its own padding and
            heading, so it is framed rather than re-chromed here. */}
        <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated)">
          <ServicesPanel agentList={agentList} />
        </div>
      </div>
    </div>
  );
}
