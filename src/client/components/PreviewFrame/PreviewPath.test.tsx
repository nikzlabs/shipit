import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PreviewPath } from "./PreviewPath.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  // Define onto the real navigator rather than replacing it — jsdom and the
  // testing library read other properties off it.
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("PreviewPath", () => {
  it("renders no chip when the path is unknown", () => {
    // A non-proxied local preview never reports one; an empty chip would read
    // as "this page has no URL".
    const { container } = render(<PreviewPath path={null} fullUrl={null} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // The region itself stays, so the toolbar doesn't shift when a path arrives.
    expect(container.querySelector("div")).toBeInTheDocument();
  });

  it("shows the path and query string", () => {
    render(<PreviewPath path="/orders/8842?tab=open" fullUrl="http://a--5173.localhost/orders/8842?tab=open" />);
    expect(screen.getByText("/orders/8842")).toBeInTheDocument();
    expect(screen.getByText("?tab=open")).toBeInTheDocument();
  });

  it("reserves width for the copy button so it cannot be clipped away", () => {
    // The icon has always been shrink-0, which is not enough on its own: it
    // sits inside a region that was free to collapse to zero, so it was cut
    // away along with the text — losing the only route back to the absolute
    // URL exactly when the path had got too short to read. The region floor is
    // what keeps it, so assert the floor rather than the icon's own class.
    const { container } = render(<PreviewPath path="/orders" fullUrl="http://a--5173.localhost/orders" />);
    const region = container.firstElementChild as HTMLElement;
    expect(region.className).toContain("min-w-7");
    expect(region.className).not.toContain("min-w-0");
  });

  it("exposes the address text as the element the toolbar measures", () => {
    // usePreviewToolbarCollapse drops labels to keep THIS element above its
    // minimum. If the marker moves or disappears the hook silently reads null
    // and stops protecting the address, so pin it here.
    const { container } = render(<PreviewPath path="/orders?tab=open" fullUrl="http://a--5173.localhost/orders?tab=open" />);
    const measured = container.querySelector("[data-preview-address]");
    expect(measured).toBeInTheDocument();
    expect(measured).toHaveTextContent("/orders");
    expect(measured).toHaveTextContent("?tab=open");
    // Content-sized and shrinkable, never hidden: that is what stops a
    // truncated address leaving unused space beside the copy button.
    expect(measured?.className).toContain("min-w-0");
    expect(measured?.className).toContain("overflow-hidden");
  });

  it("never shows the host or port", () => {
    render(<PreviewPath path="/settings" fullUrl="http://a3f9c2--5173.localhost/settings" />);
    const button = screen.getByRole("button");
    expect(button.textContent).not.toContain("localhost");
    expect(button.textContent).not.toContain("5173");
  });

  it("keeps the route in its own element so the query truncates first", () => {
    // The two halves must stay separate elements — a single string would let a
    // long query push the route out of view, which is the part you read.
    render(<PreviewPath path="/a/b?x=1&y=2" fullUrl="http://h/a/b?x=1&y=2" />);
    expect(screen.getByText("/a/b")).not.toBe(screen.getByText("?x=1&y=2"));
  });

  it("splits a hash route at the query, not at the hash", () => {
    // Hash routers keep the real route after "#", so dimming from "#" would
    // grey out the only informative part.
    render(<PreviewPath path="/#/orders?tab=open" fullUrl="http://h/#/orders?tab=open" />);
    expect(screen.getByText("/#/orders")).toBeInTheDocument();
    expect(screen.getByText("?tab=open")).toBeInTheDocument();
  });

  it("renders the root path", () => {
    render(<PreviewPath path="/" fullUrl="http://h/" />);
    expect(screen.getByText("/")).toBeInTheDocument();
  });

  it("copies the full URL — including the host — on click", () => {
    const writeText = stubClipboard();
    render(<PreviewPath path="/settings" fullUrl="http://a3f9c2--5173.localhost/settings" />);
    fireEvent.click(screen.getByRole("button"));
    expect(writeText).toHaveBeenCalledWith("http://a3f9c2--5173.localhost/settings");
  });

  it("confirms the copy, then returns to the idle icon", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubClipboard();
    render(<PreviewPath path="/settings" fullUrl="http://h/settings" />);
    fireEvent.click(screen.getByRole("button"));
    const check = await screen.findByTestId("preview-path-copied");
    expect(check).toBeInTheDocument();
    vi.advanceTimersByTime(1500);
    await waitFor(() => expect(screen.queryByTestId("preview-path-copied")).not.toBeInTheDocument());
    vi.useRealTimers();
  });

  it("exposes the full URL as the tooltip", () => {
    render(<PreviewPath path="/settings" fullUrl="http://a3f9c2--5173.localhost/settings" />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "http://a3f9c2--5173.localhost/settings");
  });
});
