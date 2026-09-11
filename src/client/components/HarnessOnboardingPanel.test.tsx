import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { HarnessOnboardingPanel } from "./HarnessOnboardingPanel.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { allServices } from "../../server/shared/catalogue/index.js";

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ credentialRoutes: [], providerAccounts: [], providerAccountNotices: {} });
});

const agentList = [
  { id: "claude" as const, name: "Claude Code", installed: true, hasRunnableModels: false, models: ["sonnet"], supportsReview: true },
];

describe("HarnessOnboardingPanel (docs/257 reqs 1, 2, 5, 7)", () => {
  it("is not a modal — no fixed overlay, no backdrop", () => {
    const { container } = render(<HarnessOnboardingPanel agentList={agentList} />);
    const root = container.firstElementChild!;
    expect(root).not.toHaveClass("fixed");
    expect(container.querySelector(".fixed")).toBeNull();
    expect(container.querySelector("[class*='bg-(--color-bg-overlay)']")).toBeNull();
  });

  it("hosts the Settings → Services surface rather than its own card list", () => {
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.getByTestId("services-panel")).toBeInTheDocument();
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();
  });

  it("has no step rail and no completion button", () => {
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.queryByTestId("step-dots")).not.toBeInTheDocument();
    expect(screen.queryByTestId("get-started")).not.toBeInTheDocument();
    expect(screen.queryByText(/connect github/i)).not.toBeInTheDocument();
  });

  it("opens exactly one dialog — the same 'Add a service' dialog Settings opens", () => {
    render(<HarnessOnboardingPanel agentList={agentList} />);
    fireEvent.click(screen.getByTestId("services-add-empty"));
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(screen.getByTestId("add-service-dialog")).toBeInTheDocument();
  });

  it("carries the launch set inside that dialog, not on the panel", () => {
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.queryByTestId("add-service-option-anthropic")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("services-add-empty"));
    const dialog = within(screen.getByTestId("add-service-dialog"));
    expect(allServices().length).toBeGreaterThan(1);
    for (const service of allServices()) {
      expect(dialog.getByTestId(`add-service-option-${service.id}`)).toBeInTheDocument();
    }
  });

  it("does not ask a first-run user for a background-work model", () => {
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.queryByTestId("background-work-section")).not.toBeInTheDocument();
  });

  it("tells a first-time user what ShipIt is, and that everything else works", () => {
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/the chat is the one thing waiting on this/i)).toBeInTheDocument();
  });
});
