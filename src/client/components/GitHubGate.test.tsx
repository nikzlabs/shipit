/**
 * docs/257 — what used to be `OnboardingWizard.test.tsx`.
 *
 * The step-1 cases are kept verbatim in substance: the GitHub step keeps
 * today's behaviour in full, including that it blocks. The step-2 cases are
 * gone with step 2 — connecting a harness is now `HarnessOnboardingPanel`, and
 * `HarnessOnboardingPanel.test.tsx` covers it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { GitHubGate } from "./GitHubGate.js";

afterEach(cleanup);

const defaultProps = () => ({
  onGitHubTokenSubmit: vi.fn().mockResolvedValue(true),
  onComplete: vi.fn(),
});

describe("GitHubGate", () => {
  it("renders the GitHub heading and token form", () => {
    render(<GitHubGate {...defaultProps()} />);
    expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
  });

  it("is GitHub-only — no manual / sandbox fallback door", () => {
    render(<GitHubGate {...defaultProps()} />);
    expect(screen.queryByTestId("switch-manual")).not.toBeInTheDocument();
    expect(screen.queryByText("Set up manually instead")).not.toBeInTheDocument();
  });

  // docs/257 — the gate carries ONE step, so the sequence chrome goes with the
  // second one. A rail whose entries are "GitHub" and nothing else is a rail
  // that is always true by construction.
  it("has no step dots and nothing about connecting an agent", () => {
    render(<GitHubGate {...defaultProps()} />);
    expect(screen.queryByTestId("step-dots")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect an agent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("get-started")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-account-rows-claude")).not.toBeInTheDocument();
  });

  it("blocks the product — it is a fixed overlay with a backdrop", () => {
    // Out of scope for docs/257 is not "leave it roughly alone": the GitHub
    // step keeps today's behaviour IN FULL, and blocking is part of it.
    const { container } = render(<GitHubGate {...defaultProps()} />);
    const backdrop = container.firstElementChild!;
    expect(backdrop).toHaveClass("fixed", "inset-0");
  });

  it("dismisses on a successful connect", async () => {
    const props = defaultProps();
    render(<GitHubGate {...props} />);
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
    fireEvent.click(screen.getByTestId("github-token-submit"));
    await waitFor(() => {
      expect(props.onComplete).toHaveBeenCalled();
    });
  });

  it("stays up, and does not dismiss, when the token is rejected", async () => {
    const props = { ...defaultProps(), onGitHubTokenSubmit: vi.fn().mockResolvedValue(false) };
    render(<GitHubGate {...props} />);
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByTestId("github-token-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("github-token-error")).toBeInTheDocument();
    });
    expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    expect(props.onComplete).not.toHaveBeenCalled();
  });

  it("does not dismiss when clicking the backdrop", () => {
    const props = defaultProps();
    const { container } = render(<GitHubGate {...props} />);
    const backdrop = container.firstElementChild!;
    fireEvent.mouseDown(backdrop);
    expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    expect(props.onComplete).not.toHaveBeenCalled();
  });
});
