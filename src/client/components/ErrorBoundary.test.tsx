import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";

afterEach(cleanup);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function ThrowingChild({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

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
    render(
      <ErrorBoundary>
        <ThrowingChild message="boom" />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByText("Try to Recover"));
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
