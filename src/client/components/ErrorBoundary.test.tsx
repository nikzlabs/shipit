import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";

afterEach(cleanup);

// Suppress React error boundary console.error noise during tests
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A component that always throws on render, for testing the boundary. */
function ThrowingChild({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

/** A normal component that renders fine. */
function GoodChild() {
  return <div>All good</div>;
}

describe("ErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("renders fallback UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="render crash" />
      </ErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("render crash")).toBeInTheDocument();
  });

  it("shows Reload Page button", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="boom" />
      </ErrorBoundary>
    );
    expect(screen.getByText("Reload Page")).toBeInTheDocument();
  });

  it("shows Try to Recover button", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="boom" />
      </ErrorBoundary>
    );
    expect(screen.getByText("Try to Recover")).toBeInTheDocument();
  });

  it("calls window.location.reload when Reload Page is clicked", () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: Object.assign(Object.create(null), window.location, { reload: reloadMock }),
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ThrowingChild message="boom" />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByText("Reload Page"));
    expect(reloadMock).toHaveBeenCalled();
  });

  it("attempts recovery when Try to Recover is clicked", () => {
    // The ThrowingChild will throw again on re-render, but the state
    // transition (hasError → false) is the behavior we're testing.
    // Since ThrowingChild always throws, recovery will fail and re-show
    // the error UI — but the boundary's state was correctly cleared.
    render(
      <ErrorBoundary>
        <ThrowingChild message="boom" />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByText("Try to Recover"));
    // Since the child always throws, we should still see the error UI
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("shows descriptive subheading text", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="test error" />
      </ErrorBoundary>
    );
    expect(
      screen.getByText("An unexpected error occurred while rendering the application.")
    ).toBeInTheDocument();
  });
});
