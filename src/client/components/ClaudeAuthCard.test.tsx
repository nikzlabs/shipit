import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ClaudeAuthCard } from "./ClaudeAuthCard.js";
import type { AgentOption } from "./AgentPicker.js";

afterEach(cleanup);

const authedAgent: AgentOption = { id: "claude", name: "Claude CLI", installed: true, authConfigured: true, models: ["claude-sonnet"] };
const unauthedAgent: AgentOption = { id: "claude", name: "Claude CLI", installed: true, authConfigured: false, models: ["claude-sonnet"] };
const notInstalledAgent: AgentOption = { id: "claude", name: "Claude CLI", installed: false, authConfigured: false, models: [] };

function renderCard(overrides: Partial<Parameters<typeof ClaudeAuthCard>[0]> = {}) {
  const defaults = {
    agent: unauthedAgent,
    authUrl: null,
    onStartAuth: vi.fn(),
    onApiKeySubmit: vi.fn().mockResolvedValue(true),
    onPasteAuthCode: vi.fn(),
  };
  return { ...defaults, ...overrides, result: render(<ClaudeAuthCard {...defaults} {...overrides} />) };
}

describe("ClaudeAuthCard", () => {
  it("renders nothing when agent is undefined", () => {
    render(<ClaudeAuthCard agent={undefined} authUrl={null} onStartAuth={vi.fn()} onApiKeySubmit={vi.fn()} onPasteAuthCode={vi.fn()} />);
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("shows green dot and Authenticated when agent is authed", () => {
    renderCard({ agent: authedAgent });
    expect(screen.getByTestId("claude-status-dot")).toHaveClass("bg-green-400");
    expect(screen.getByText("Authenticated")).toBeInTheDocument();
  });

  it("shows yellow dot and Not authenticated when agent needs auth", () => {
    renderCard({ agent: unauthedAgent });
    expect(screen.getByTestId("claude-status-dot")).toHaveClass("bg-yellow-400");
    expect(screen.getByText("Not authenticated")).toBeInTheDocument();
  });

  it("shows gray dot and Not installed when agent is not installed", () => {
    renderCard({ agent: notInstalledAgent });
    expect(screen.getByTestId("claude-status-dot")).toHaveClass("bg-gray-400");
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });

  describe("Login button", () => {
    it("shows Login with Claude when needs auth and no authUrl", () => {
      renderCard();
      expect(screen.getByTestId("claude-start-auth")).toHaveTextContent("Login with Claude");
    });

    it("calls onStartAuth and shows waiting text on click", () => {
      const { onStartAuth } = renderCard();
      fireEvent.click(screen.getByTestId("claude-start-auth"));
      expect(onStartAuth).toHaveBeenCalled();
      expect(screen.getByTestId("claude-start-auth")).toHaveTextContent("Waiting for login...");
    });

    it("hides login button when already authenticated", () => {
      renderCard({ agent: authedAgent });
      expect(screen.queryByTestId("claude-start-auth")).not.toBeInTheDocument();
    });

    it("hides login button when authUrl is set", () => {
      renderCard({ authUrl: "https://auth.example.com" });
      expect(screen.queryByTestId("claude-start-auth")).not.toBeInTheDocument();
    });
  });

  describe("OAuth flow", () => {
    it("shows OAuth flow when needs auth and authUrl is set", () => {
      renderCard({ authUrl: "https://auth.example.com" });
      expect(screen.getByTestId("claude-oauth-flow")).toBeInTheDocument();
      expect(screen.getByTestId("claude-open-auth-url")).toHaveAttribute("href", "https://auth.example.com");
    });

    it("submits auth code on click", () => {
      const { onPasteAuthCode } = renderCard({ authUrl: "https://auth.example.com" });
      fireEvent.change(screen.getByTestId("claude-auth-code-input"), { target: { value: "my-code" } });
      fireEvent.click(screen.getByTestId("claude-auth-code-submit"));
      expect(onPasteAuthCode).toHaveBeenCalledWith("my-code");
    });

    it("disables submit when auth code is empty", () => {
      renderCard({ authUrl: "https://auth.example.com" });
      expect(screen.getByTestId("claude-auth-code-submit")).toBeDisabled();
    });
  });

  describe("API key input", () => {
    it("shows API key input when needs auth", () => {
      renderCard();
      expect(screen.getByTestId("claude-api-key-input")).toBeInTheDocument();
      expect(screen.getByText("Or authenticate with an API key:")).toBeInTheDocument();
    });

    it("validates sk-ant- prefix", () => {
      renderCard();
      fireEvent.change(screen.getByTestId("claude-api-key-input"), { target: { value: "bad-key" } });
      fireEvent.click(screen.getByTestId("claude-api-key-submit"));
      expect(screen.getByTestId("claude-api-key-error")).toHaveTextContent("sk-ant-");
    });

    it("calls onApiKeySubmit with valid key", async () => {
      const { onApiKeySubmit } = renderCard();
      fireEvent.change(screen.getByTestId("claude-api-key-input"), { target: { value: "sk-ant-valid-key" } });
      fireEvent.click(screen.getByTestId("claude-api-key-submit"));
      await waitFor(() => expect(onApiKeySubmit).toHaveBeenCalledWith("sk-ant-valid-key"));
    });

    it("shows error when onApiKeySubmit returns false", async () => {
      const { onApiKeySubmit } = renderCard();
      (onApiKeySubmit as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      fireEvent.change(screen.getByTestId("claude-api-key-input"), { target: { value: "sk-ant-bad" } });
      fireEvent.click(screen.getByTestId("claude-api-key-submit"));
      await waitFor(() => expect(screen.getByTestId("claude-api-key-error")).toHaveTextContent("Failed to set API key."));
    });

    it("clears error on input change", async () => {
      renderCard();
      fireEvent.change(screen.getByTestId("claude-api-key-input"), { target: { value: "bad" } });
      fireEvent.click(screen.getByTestId("claude-api-key-submit"));
      expect(screen.getByTestId("claude-api-key-error")).toBeInTheDocument();
      fireEvent.change(screen.getByTestId("claude-api-key-input"), { target: { value: "sk-ant-new" } });
      expect(screen.queryByTestId("claude-api-key-error")).not.toBeInTheDocument();
    });

    it("submits on Enter key", async () => {
      const { onApiKeySubmit } = renderCard();
      const input = screen.getByTestId("claude-api-key-input");
      fireEvent.change(input, { target: { value: "sk-ant-enter-key" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(onApiKeySubmit).toHaveBeenCalledWith("sk-ant-enter-key"));
    });

    it("submit button disabled when input empty", () => {
      renderCard();
      expect(screen.getByTestId("claude-api-key-submit")).toBeDisabled();
    });
  });

  describe("showApiKeyWhenAuthed", () => {
    it("hides API key input when authed and showApiKeyWhenAuthed is false", () => {
      renderCard({ agent: authedAgent });
      expect(screen.queryByTestId("claude-api-key-input")).not.toBeInTheDocument();
    });

    it("shows API key input with Override label when authed and showApiKeyWhenAuthed is true", () => {
      renderCard({ agent: authedAgent, showApiKeyWhenAuthed: true });
      expect(screen.getByTestId("claude-api-key-input")).toBeInTheDocument();
      expect(screen.getByText("Override authentication with an API key:")).toBeInTheDocument();
    });
  });

  describe("Clear API key", () => {
    it("hides clear button when onClearApiKey not provided", () => {
      renderCard({ agent: authedAgent });
      expect(screen.queryByTestId("claude-clear-api-key")).not.toBeInTheDocument();
    });

    it("shows clear button when authed and onClearApiKey provided", () => {
      const onClearApiKey = vi.fn();
      renderCard({ agent: authedAgent, onClearApiKey });
      fireEvent.click(screen.getByTestId("claude-clear-api-key"));
      expect(onClearApiKey).toHaveBeenCalled();
    });

    it("hides clear button when not authenticated", () => {
      renderCard({ onClearApiKey: vi.fn() });
      expect(screen.queryByTestId("claude-clear-api-key")).not.toBeInTheDocument();
    });
  });
});
