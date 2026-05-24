import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SpawnFailedCard } from "./SpawnFailedCard.js";

/**
 * Tests for the in-chat `SpawnFailedCard` (docs/117 cross-cutting follow-up).
 *
 * Counterpart to `SpawnedSessionCard.test.tsx`. The card is informational —
 * no clickable affordances — so the tests focus on:
 *
 *   - Each `reason` bucket maps to a distinct headline.
 *   - The orchestrator error message is rendered verbatim.
 *   - The status code is surfaced.
 *   - Title / branch / promptPreview are all optional.
 */

const BASE_PROPS = {
  reason: "quota_per_turn" as const,
  message: "Per-turn spawn limit reached (4).",
  statusCode: 429,
  title: "Port API to TypeScript",
  branch: "port-api-ts",
  promptPreview: "Port the REST API to TypeScript",
  failedAt: "2026-01-01T00:00:00Z",
};

afterEach(cleanup);

describe("SpawnFailedCard", () => {
  it("renders the title, branch, and prompt preview baked in by the spawn event", () => {
    render(<SpawnFailedCard {...BASE_PROPS} />);
    expect(screen.getByTestId("spawn-failed-title")).toHaveTextContent("Port API to TypeScript");
    expect(screen.getByText("port-api-ts")).toBeInTheDocument();
    expect(screen.getByTestId("spawn-failed-prompt")).toHaveTextContent(/Port the REST API to TypeScript/);
  });

  it("surfaces the orchestrator error message and status code", () => {
    render(<SpawnFailedCard {...BASE_PROPS} />);
    expect(screen.getByTestId("spawn-failed-message")).toHaveTextContent("Per-turn spawn limit reached (4).");
    expect(screen.getByTestId("spawn-failed-status")).toHaveTextContent("429");
  });

  it("renders the per-turn headline when reason is quota_per_turn", () => {
    render(<SpawnFailedCard {...BASE_PROPS} reason="quota_per_turn" />);
    expect(screen.getByTestId("spawn-failed-headline")).toHaveTextContent(/per-turn/i);
  });

  it("renders the per-session headline when reason is quota_per_parent", () => {
    render(<SpawnFailedCard {...BASE_PROPS} reason="quota_per_parent" />);
    expect(screen.getByTestId("spawn-failed-headline")).toHaveTextContent(/per-session/i);
  });

  it("renders the rejected-request headline when reason is invalid_request", () => {
    render(<SpawnFailedCard {...BASE_PROPS} reason="invalid_request" />);
    expect(screen.getByTestId("spawn-failed-headline")).toHaveTextContent(/rejected/i);
  });

  it("renders the parent-unavailable headline when reason is parent_missing", () => {
    render(<SpawnFailedCard {...BASE_PROPS} reason="parent_missing" />);
    expect(screen.getByTestId("spawn-failed-headline")).toHaveTextContent(/parent session unavailable/i);
  });

  it("falls back to the generic headline when reason is the catch-all error bucket", () => {
    render(<SpawnFailedCard {...BASE_PROPS} reason="error" />);
    expect(screen.getByTestId("spawn-failed-headline")).toHaveTextContent(/spawn failed/i);
  });

  it("falls back to 'Spawned session' when no title is supplied", () => {
    const { title: _omit, ...rest } = BASE_PROPS;
    render(<SpawnFailedCard {...rest} />);
    expect(screen.getByTestId("spawn-failed-title")).toHaveTextContent("Spawned session");
  });

  it("omits the branch line when no branch is supplied", () => {
    const { branch: _omit, ...rest } = BASE_PROPS;
    render(<SpawnFailedCard {...rest} />);
    expect(screen.queryByText("port-api-ts")).not.toBeInTheDocument();
  });

  it("omits the prompt preview when not supplied", () => {
    const { promptPreview: _omit, ...rest } = BASE_PROPS;
    render(<SpawnFailedCard {...rest} />);
    expect(screen.queryByTestId("spawn-failed-prompt")).not.toBeInTheDocument();
  });
});
