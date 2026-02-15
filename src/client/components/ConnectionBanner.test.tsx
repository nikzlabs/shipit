import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner.js";

afterEach(cleanup);

describe("ConnectionBanner", () => {
  it("renders nothing when status is open", () => {
    const { container } = render(<ConnectionBanner status="open" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows reconnecting message when status is connecting", () => {
    render(<ConnectionBanner status="connecting" />);
    expect(screen.getByText("Reconnecting to server...")).toBeInTheDocument();
  });

  it("shows connection lost message when status is closed", () => {
    render(<ConnectionBanner status="closed" />);
    expect(
      screen.getByText("Connection lost — waiting to reconnect...")
    ).toBeInTheDocument();
  });

  it("has role=alert for accessibility", () => {
    render(<ConnectionBanner status="closed" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("uses yellow styling for connecting state", () => {
    render(<ConnectionBanner status="connecting" />);
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("yellow");
  });

  it("uses red styling for closed state", () => {
    render(<ConnectionBanner status="closed" />);
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("red");
  });
});
