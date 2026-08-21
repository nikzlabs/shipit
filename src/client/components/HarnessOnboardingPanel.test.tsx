/**
 * docs/257 phase 2 — the panel.
 *
 * What these check is deliberately about *shape*, not about credentials: the
 * credential behaviour is the Settings → Services surface's own, and req 7's
 * whole point is that this panel does not have a second copy of it to test. So
 * the assertions here are the ones a green Services suite cannot make — that
 * the panel covers nothing, that it hosts that surface rather than
 * re-implementing it, and that the one dialog this flow opens is the one
 * Settings opens.
 */

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
    // Req 1 is the whole feature: the panel occupies the conversation view, it
    // does not draw on top of the product. A `fixed inset-0` here would put the
    // file tree, the preview and the terminal back behind a sheet of glass.
    const { container } = render(<HarnessOnboardingPanel agentList={agentList} />);
    const root = container.firstElementChild!;
    expect(root).not.toHaveClass("fixed");
    expect(container.querySelector(".fixed")).toBeNull();
    expect(container.querySelector("[class*='bg-(--color-bg-overlay)']")).toBeNull();
  });

  it("hosts the Settings → Services surface rather than its own card list", () => {
    // Req 7 — behavioural identity, achieved by literal reuse. docs/150-multiple-provider-subscriptions req 16
    // paid for the alternative once, when a user's first account was connected
    // by different code than their second.
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.getByTestId("services-panel")).toBeInTheDocument();
    expect(screen.getByTestId("services-empty")).toBeInTheDocument();
  });

  it("has no step rail and no completion button", () => {
    // Completion is a computed fact, not a click (req 9): the panel yields the
    // pane when the server stamps. A rail whose only entry is an inert
    // "GitHub — done" marker also contradicts GitHub being absent from here.
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.queryByTestId("step-dots")).not.toBeInTheDocument();
    expect(screen.queryByTestId("get-started")).not.toBeInTheDocument();
    expect(screen.queryByText(/connect github/i)).not.toBeInTheDocument();
  });

  it("opens exactly one dialog — the same 'Add a service' dialog Settings opens", () => {
    // Req 5, as amended 2026-08-09: the panel is not a modal, so the add dialog
    // is the ONE thing this flow puts on top of anything. The complaint the
    // requirement records was two modals at once.
    render(<HarnessOnboardingPanel agentList={agentList} />);
    fireEvent.click(screen.getByTestId("services-add-empty"));
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(screen.getByTestId("add-service-dialog")).toBeInTheDocument();
  });

  it("carries the launch set inside that dialog, not on the panel", () => {
    // Req 6 — the surface is proportional to the user's setup, not to the
    // catalogue: a first-run user has zero cards, and the catalogue appears at
    // the moment it is a choice. So the panel itself must not list services.
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.queryByTestId("add-service-option-anthropic")).not.toBeInTheDocument();

    // Read from the catalogue rather than a hard-coded list: req 6's bar is
    // "docs/252's launch set", so the test should follow that set rather than a
    // copy of it that can drift.
    fireEvent.click(screen.getByTestId("services-add-empty"));
    const dialog = within(screen.getByTestId("add-service-dialog"));
    expect(allServices().length).toBeGreaterThan(1);
    for (const service of allServices()) {
      expect(dialog.getByTestId(`add-service-option-${service.id}`)).toBeInTheDocument();
    }
  });

  it("does not ask a first-run user for a background-work model", () => {
    // The setting defaults to whatever the install can run (docs/252 req 9), so
    // there is nothing to decide here and the row would spend the space the
    // credential needs. It lives in the Settings tab that hosts this panel's
    // component, which is why the guard is on the panel rather than on
    // `ServicesPanel` — putting it back inside the panel is the regression.
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.queryByTestId("background-work-section")).not.toBeInTheDocument();
  });

  it("tells a first-time user what ShipIt is, and that everything else works", () => {
    // The drop-off req 3 names: a user asked to connect an account before they
    // have seen anything has been given no reason to. The gate's hero content
    // survives as a compact lede rather than a facing panel.
    render(<HarnessOnboardingPanel agentList={agentList} />);
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/the chat is the one thing waiting on this/i)).toBeInTheDocument();
  });
});
