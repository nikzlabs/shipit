import { RobotIcon, KeyIcon, ColumnsIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { AgentOption } from "../agent-types.js";
import { Logo } from "./Logo.js";
import { ServicesPanel } from "./Settings/ServicesPanel.js";

/**
 * The hero's three claims: one line each, an icon and the claim, no gloss.
 *
 * They were three rows of lead-plus-explanation, which cost the panel more
 * height than the Services surface below it. Cutting the explanation is what
 * bought the space — what each one elaborated is either evident from the words
 * that remain or is said again inside the add-service dialog — so the rows
 * themselves stay a list rather than becoming wrapped chips: three claims
 * flowing 2 + 1 across two rows read as one claim left over.
 */
const FEATURES = [
  {
    Icon: RobotIcon,
    tint: "bg-(--color-accent-subtle) text-(--color-accent)",
    label: "Any service ShipIt ships with",
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
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
        <div className="flex flex-col gap-2.5 px-1">
          {/* Centred, not baseline-aligned: the lockup is an icon plus a
              wordmark, so matching its text baseline to the heading's hangs the
              icon above the line. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Logo size="md" textClassName="text-(--color-text-primary)" />
            <h1 className="text-lg font-semibold leading-snug text-(--color-text-primary)">
              Add a service, and the chat starts working.
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

        {/* The Settings surface, hosted whole. It brings no padding and no
            scroll container of its own, so the card is the frame. */}
        <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) px-4 py-3.5">
          <ServicesPanel agentList={agentList} />
        </div>
      </div>
    </div>
  );
}
