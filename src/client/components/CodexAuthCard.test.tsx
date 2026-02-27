import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { CodexAuthCard } from "./CodexAuthCard.js";
import type { AgentOption } from "./AgentPicker.js";

afterEach(cleanup);

const authedAgent: AgentOption = { id: "codex", name: "Codex", installed: true, authConfigured: true, models: ["gpt-4"] };
const unauthedAgent: AgentOption = { id: "codex", name: "Codex", installed: true, authConfigured: false, models: ["gpt-4"] };
const notInstalledAgent: AgentOption = { id: "codex", name: "Codex", installed: false, authConfigured: false, models: [] };

function renderCard(overrides: Partial<Parameters<typeof CodexAuthCard>[0]> = {}) {
  const defaults = {
    agent: unauthedAgent,
    onApiKeySubmit: vi.fn().mockResolvedValue(true),
  };
  return { ...defaults, ...overrides, result: render(<CodexAuthCard {...defaults} {...overrides} />) };
}

describe("CodexAuthCard", () => {
  it("renders nothing when agent is undefined", () => {
    render(<CodexAuthCard agent={undefined} onApiKeySubmit={vi.fn()} />);
    expect(screen.queryByTestId("codex-auth-card")).not.toBeInTheDocument();
  });

  it("shows green dot and Authenticated when authed", () => {
    renderCard({ agent: authedAgent });
    expect(screen.getByTestId("codex-status-dot")).toHaveClass("bg-green-400");
    expect(screen.getByText("Authenticated")).toBeInTheDocument();
  });

  it("shows yellow dot and API key not set when needs auth", () => {
    renderCard();
    expect(screen.getByTestId("codex-status-dot")).toHaveClass("bg-yellow-400");
    expect(screen.getByText("API key not set")).toBeInTheDocument();
  });

  it("shows gray dot and Not installed when not installed", () => {
    renderCard({ agent: notInstalledAgent });
    expect(screen.getByTestId("codex-status-dot")).toHaveClass("bg-gray-400");
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });

  it("shows API key input when needs auth", () => {
    renderCard();
    expect(screen.getByTestId("codex-api-key-input")).toBeInTheDocument();
  });

  it("hides API key input when authenticated", () => {
    renderCard({ agent: authedAgent });
    expect(screen.queryByTestId("codex-api-key-input")).not.toBeInTheDocument();
  });

  it("hides API key input when not installed", () => {
    renderCard({ agent: notInstalledAgent });
    expect(screen.queryByTestId("codex-api-key-input")).not.toBeInTheDocument();
  });

  it("submit button disabled when input empty", () => {
    renderCard();
    expect(screen.getByTestId("codex-api-key-submit")).toBeDisabled();
  });

  it("calls onApiKeySubmit with trimmed key", async () => {
    const { onApiKeySubmit } = renderCard();
    fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "  sk-test-key  " } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() => expect(onApiKeySubmit).toHaveBeenCalledWith("sk-test-key"));
  });

  it("shows error when onApiKeySubmit returns false", async () => {
    const { onApiKeySubmit } = renderCard();
    (onApiKeySubmit as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "bad-key" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() => expect(screen.getByTestId("codex-api-key-error")).toHaveTextContent("Failed to set API key."));
  });

  it("clears error on input change", async () => {
    const { onApiKeySubmit } = renderCard();
    (onApiKeySubmit as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "bad" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() => expect(screen.getByTestId("codex-api-key-error")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "new" } });
    expect(screen.queryByTestId("codex-api-key-error")).not.toBeInTheDocument();
  });

  it("submits on Enter key", async () => {
    const { onApiKeySubmit } = renderCard();
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-enter" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onApiKeySubmit).toHaveBeenCalledWith("sk-enter"));
  });

  it("clears input on success", async () => {
    renderCard();
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-good" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() => expect(input).toHaveValue(""));
  });
});
