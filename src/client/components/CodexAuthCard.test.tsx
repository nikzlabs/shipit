import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { CodexAuthCard } from "./CodexAuthCard.js";
import type { AgentOption } from "../agent-types.js";

afterEach(cleanup);

const authedAgent: AgentOption = { id: "codex", name: "Codex", installed: true, authConfigured: true, models: ["gpt-5"], supportsReview: false };
const unauthedAgent: AgentOption = { id: "codex", name: "Codex", installed: true, authConfigured: false, models: ["gpt-5"], supportsReview: false };
const notInstalledAgent: AgentOption = { id: "codex", name: "Codex", installed: false, authConfigured: false, models: [], supportsReview: false };

function renderCard(overrides: Partial<Parameters<typeof CodexAuthCard>[0]> = {}) {
  const defaults = {
    agent: unauthedAgent,
    onApiKeySubmit: vi.fn().mockResolvedValue(true),
    onStartDeviceAuth: vi.fn(),
    onCancelDeviceAuth: vi.fn(),
    onSignOut: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  return { ...props, result: render(<CodexAuthCard {...props} />) };
}

describe("CodexAuthCard / status badge", () => {
  it("renders nothing when agent is undefined", () => {
    render(<CodexAuthCard agent={undefined} onApiKeySubmit={vi.fn()} />);
    expect(screen.queryByTestId("codex-auth-card")).not.toBeInTheDocument();
  });

  it("shows green dot and Authenticated when authed", () => {
    renderCard({ agent: authedAgent });
    expect(screen.getByTestId("codex-status-dot")).toHaveClass("bg-(--color-success)");
    expect(screen.getByText("Authenticated")).toBeInTheDocument();
  });

  it("shows yellow dot and Not authenticated when unauthed", () => {
    renderCard();
    expect(screen.getByTestId("codex-status-dot")).toHaveClass("bg-(--color-warning)");
    expect(screen.getByText("Not authenticated")).toBeInTheDocument();
  });

  it("shows gray dot and Not installed when not installed", () => {
    renderCard({ agent: notInstalledAgent });
    expect(screen.getByTestId("codex-status-dot")).toHaveClass("bg-(--color-text-tertiary)");
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });
});

describe("CodexAuthCard / sign-in flow", () => {
  it("shows the Sign in button when unauthed and no flow in progress", () => {
    renderCard();
    expect(screen.getByTestId("codex-start-device-auth")).toBeInTheDocument();
    expect(screen.getByTestId("codex-start-device-auth")).toHaveTextContent("Sign in");
  });

  it("hides the Sign in button when authenticated", () => {
    renderCard({ agent: authedAgent });
    expect(screen.queryByTestId("codex-start-device-auth")).not.toBeInTheDocument();
  });

  it("hides the Sign in button when not installed", () => {
    renderCard({ agent: notInstalledAgent });
    expect(screen.queryByTestId("codex-start-device-auth")).not.toBeInTheDocument();
  });

  it("calls onStartDeviceAuth when Sign in clicked", () => {
    const { onStartDeviceAuth } = renderCard();
    fireEvent.click(screen.getByTestId("codex-start-device-auth"));
    expect(onStartDeviceAuth).toHaveBeenCalledTimes(1);
  });

  it("renders the verification URL + user code in the pending state", () => {
    renderCard({
      deviceAuth: {
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "K8RE-8MIGC",
        expiresInSec: 900,
      },
    });
    const link = screen.getByTestId("codex-open-auth-url");
    expect(link).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByTestId("codex-user-code")).toHaveTextContent("K8RE-8MIGC");
  });

  it("Sign in button is hidden while a flow is pending", () => {
    renderCard({
      deviceAuth: {
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "K8RE-8MIGC",
        expiresInSec: 900,
      },
    });
    expect(screen.queryByTestId("codex-start-device-auth")).not.toBeInTheDocument();
    expect(screen.getByTestId("codex-cancel-auth")).toBeInTheDocument();
  });

  it("calls onCancelDeviceAuth when Cancel clicked", () => {
    const { onCancelDeviceAuth } = renderCard({
      deviceAuth: {
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "K8RE-8MIGC",
        expiresInSec: 900,
      },
    });
    fireEvent.click(screen.getByTestId("codex-cancel-auth"));
    expect(onCancelDeviceAuth).toHaveBeenCalledTimes(1);
  });

  it("surfaces deviceAuthError inline", () => {
    renderCard({ deviceAuthError: "Sign-in timed out. Try again." });
    expect(screen.getByTestId("codex-device-auth-error")).toHaveTextContent("Sign-in timed out. Try again.");
  });
});

describe("CodexAuthCard / API key fallback", () => {
  it("API key panel is collapsed by default", () => {
    renderCard();
    expect(screen.queryByTestId("codex-api-key-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("codex-toggle-api-key")).toHaveTextContent("Use API key instead");
  });

  it("toggling the disclosure reveals the API key input", () => {
    renderCard();
    fireEvent.click(screen.getByTestId("codex-toggle-api-key"));
    expect(screen.getByTestId("codex-api-key-input")).toBeInTheDocument();
  });

  it("calls onApiKeySubmit with trimmed key", async () => {
    const { onApiKeySubmit } = renderCard();
    fireEvent.click(screen.getByTestId("codex-toggle-api-key"));
    fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "  sk-test-key  " } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() => expect(onApiKeySubmit).toHaveBeenCalledWith("sk-test-key"));
  });

  it("shows error when onApiKeySubmit returns false", async () => {
    const { onApiKeySubmit } = renderCard();
    (onApiKeySubmit as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    fireEvent.click(screen.getByTestId("codex-toggle-api-key"));
    fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "bad-key" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("codex-api-key-error")).toHaveTextContent("Failed to set API key."),
    );
  });

  it("submits on Enter key", async () => {
    const { onApiKeySubmit } = renderCard();
    fireEvent.click(screen.getByTestId("codex-toggle-api-key"));
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-enter" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onApiKeySubmit).toHaveBeenCalledWith("sk-enter"));
  });

  it("clears input on success", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("codex-toggle-api-key"));
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-good" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("API key disclosure is hidden while a device-auth flow is pending", () => {
    renderCard({
      deviceAuth: {
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "K8RE-8MIGC",
        expiresInSec: 900,
      },
    });
    expect(screen.queryByTestId("codex-toggle-api-key")).not.toBeInTheDocument();
  });
});

describe("CodexAuthCard / signed-in state", () => {
  it("shows Sign out button when authed", () => {
    renderCard({ agent: authedAgent });
    expect(screen.getByTestId("codex-sign-out")).toBeInTheDocument();
  });

  it("calls onSignOut when Sign out clicked", () => {
    const { onSignOut } = renderCard({ agent: authedAgent });
    fireEvent.click(screen.getByTestId("codex-sign-out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("renders the API-key-ignored banner when both modes are configured", () => {
    renderCard({ agent: authedAgent, apiKeyIgnored: true });
    expect(screen.getByTestId("codex-api-key-ignored")).toBeInTheDocument();
    expect(screen.getByTestId("codex-api-key-ignored")).toHaveTextContent(/Using ChatGPT subscription/);
  });

  it("does not render the API-key-ignored banner when only one mode is configured", () => {
    renderCard({ agent: authedAgent, apiKeyIgnored: false });
    expect(screen.queryByTestId("codex-api-key-ignored")).not.toBeInTheDocument();
  });
});
