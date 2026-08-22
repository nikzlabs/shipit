import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  ViewportResizeHandles,
  computeViewportResize,
  computeKeyboardResize,
  KEYBOARD_RESIZE_STEP,
} from "./ViewportResizeHandles.js";
import { useDeviceFrame } from "./DeviceFrame.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { findPresetById } from "../device-presets.js";

// jsdom doesn't implement ResizeObserver — no-op stub for useDeviceFrame's
// container measurement (same stub as PreviewFrame.test.tsx).
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  useSessionStore.setState({ sessionId: undefined });
});

/**
 * Mirrors PreviewFrame's wiring: the size/scale props come from the real
 * `useDeviceFrame` (store-driven), so a drag's store writes flow back into the
 * handles and the badge exactly as in production. The available box is pinned
 * because jsdom measures the container as 0×0.
 */
function Harness({ availableWidth = 800, availableHeight = 900, scaleOverride }: {
  availableWidth?: number;
  availableHeight?: number;
  scaleOverride?: number;
}) {
  const { deviceWidth, deviceHeight, deviceScale } = useDeviceFrame();
  return (
    <ViewportResizeHandles
      deviceWidth={deviceWidth}
      deviceHeight={deviceHeight}
      deviceScale={scaleOverride ?? deviceScale}
      availableWidth={availableWidth}
      availableHeight={availableHeight}
    />
  );
}

describe("computeViewportResize", () => {
  it("moves the size by twice the pointer delta (center-anchored surface)", () => {
    expect(computeViewportResize(400, 10, 1, 800)).toBe(420);
    expect(computeViewportResize(400, -10, 1, 800)).toBe(380);
  });

  it("divides the delta by the gesture-start scale", () => {
    expect(computeViewportResize(400, 10, 0.5, 800)).toBe(440);
  });

  it("clamps at the minimum custom size", () => {
    expect(computeViewportResize(120, -400, 1, 800)).toBe(100);
  });

  it("cannot grow past what fits the panel", () => {
    expect(computeViewportResize(700, 500, 1, 800)).toBe(800);
  });

  it("a surface already larger than the panel can shrink but not grow", () => {
    expect(computeViewportResize(1000, 80, 1, 800)).toBe(1000);
    expect(computeViewportResize(1000, -50, 1, 800)).toBe(900);
  });

  it("tolerates a panel smaller than the minimum", () => {
    expect(computeViewportResize(100, 300, 1, 40)).toBe(100);
  });
});

describe("computeKeyboardResize", () => {
  it("steps a handle's own axis by the fixed step", () => {
    expect(computeKeyboardResize("x", { width: 400, height: 800 }, "ArrowRight"))
      .toEqual({ width: 400 + KEYBOARD_RESIZE_STEP, height: 800 });
    expect(computeKeyboardResize("x", { width: 400, height: 800 }, "ArrowLeft"))
      .toEqual({ width: 400 - KEYBOARD_RESIZE_STEP, height: 800 });
    expect(computeKeyboardResize("y", { width: 400, height: 800 }, "ArrowDown"))
      .toEqual({ width: 400, height: 800 + KEYBOARD_RESIZE_STEP });
    expect(computeKeyboardResize("y", { width: 400, height: 800 }, "ArrowUp"))
      .toEqual({ width: 400, height: 800 - KEYBOARD_RESIZE_STEP });
  });

  it("ignores the cross axis on an edge handle, so the event scrolls as usual", () => {
    expect(computeKeyboardResize("x", { width: 400, height: 800 }, "ArrowDown")).toBeNull();
    expect(computeKeyboardResize("y", { width: 400, height: 800 }, "ArrowRight")).toBeNull();
    expect(computeKeyboardResize("x", { width: 400, height: 800 }, "Enter")).toBeNull();
  });

  it("the corner acts on all four arrows", () => {
    expect(computeKeyboardResize("xy", { width: 400, height: 800 }, "ArrowRight"))
      .toEqual({ width: 410, height: 800 });
    expect(computeKeyboardResize("xy", { width: 400, height: 800 }, "ArrowUp"))
      .toEqual({ width: 400, height: 790 });
  });

  it("clamps to the absolute custom-size bounds, not the panel", () => {
    expect(computeKeyboardResize("x", { width: 105, height: 800 }, "ArrowLeft"))
      .toEqual({ width: 100, height: 800 });
    expect(computeKeyboardResize("y", { width: 400, height: 2555 }, "ArrowDown"))
      .toEqual({ width: 400, height: 2560 });
  });
});

describe("ViewportResizeHandles", () => {
  // iPhone 16 is 393×852 — the gesture-start size for every drag below.
  beforeEach(() => {
    usePreviewStore.getState().clearViewportMemory();
    localStorage.clear();
    usePreviewStore.getState().reset();
    usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
  });

  it("renders the three handles and no badge or shield while idle", () => {
    render(<Harness />);
    expect(screen.getByTestId("viewport-handle-x")).toBeInTheDocument();
    expect(screen.getByTestId("viewport-handle-y")).toBeInTheDocument();
    expect(screen.getByTestId("viewport-handle-xy")).toBeInTheDocument();
    expect(screen.queryByTestId("viewport-drag-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("viewport-drag-shield")).not.toBeInTheDocument();
  });

  it("dragging the width handle detaches a named preset into Custom at the dragged size", () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("viewport-handle-x"), { clientX: 100, clientY: 50, button: 0 });
    fireEvent.pointerMove(document, { clientX: 130, clientY: 50 });
    const s = usePreviewStore.getState();
    // 393 + 2×30 = 453 wide; height untouched by the width handle.
    expect(s.devicePreset).toMatchObject({ id: "custom", label: "Custom" });
    expect(s.customSize).toEqual({ width: 453, height: 852 });
    fireEvent.pointerUp(document);
  });

  it("the corner handle resizes both axes and the gesture ends on pointerup", () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("viewport-handle-xy"), { clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerMove(document, { clientX: 210, clientY: 190 });
    expect(usePreviewStore.getState().customSize).toEqual({ width: 413, height: 832 });
    fireEvent.pointerUp(document);
    // The gesture is over: further moves change nothing.
    fireEvent.pointerMove(document, { clientX: 400, clientY: 400 });
    expect(usePreviewStore.getState().customSize).toEqual({ width: 413, height: 832 });
  });

  it("applies deltas against the gesture-start size, not cumulatively", () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("viewport-handle-y"), { clientX: 50, clientY: 100, button: 0 });
    fireEvent.pointerMove(document, { clientY: 120 });
    fireEvent.pointerMove(document, { clientY: 110 });
    // Total delta +10 from start → 852 + 20, regardless of the path taken.
    expect(usePreviewStore.getState().customSize).toEqual({ width: 393, height: 872 });
    fireEvent.pointerUp(document);
  });

  it("shows the live size badge and shield only while dragging, and pins the body cursor", () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("viewport-handle-x"), { clientX: 100, clientY: 50, button: 0 });
    expect(screen.getByTestId("viewport-drag-shield")).toBeInTheDocument();
    expect(document.body.style.cursor).toBe("ew-resize");
    fireEvent.pointerMove(document, { clientX: 120 });
    // The badge tracks the live store-driven size: 393 + 2×20 = 433.
    expect(screen.getByTestId("viewport-drag-badge")).toHaveTextContent("433 × 852");
    fireEvent.pointerUp(document);
    expect(screen.queryByTestId("viewport-drag-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("viewport-drag-shield")).not.toBeInTheDocument();
    expect(document.body.style.cursor).toBe("");
  });

  it("restores body styles when unmounted mid-drag", () => {
    const { unmount } = render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("viewport-handle-y"), { clientX: 50, clientY: 100, button: 0 });
    expect(document.body.style.userSelect).toBe("none");
    unmount();
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
  });

  it("ignores non-primary buttons", () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("viewport-handle-x"), { clientX: 100, clientY: 50, button: 2 });
    expect(screen.queryByTestId("viewport-drag-shield")).not.toBeInTheDocument();
    fireEvent.pointerMove(document, { clientX: 200 });
    expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-16");
  });

  it("refuses to start against a degenerate scale", () => {
    render(<Harness scaleOverride={0} />);
    fireEvent.pointerDown(screen.getByTestId("viewport-handle-x"), { clientX: 100, clientY: 50, button: 0 });
    expect(screen.queryByTestId("viewport-drag-shield")).not.toBeInTheDocument();
  });

  it("arrow keys resize from the keyboard and detach the preset into Custom (req 9)", () => {
    render(<Harness />);
    const x = screen.getByTestId("viewport-handle-x");
    fireEvent.keyDown(x, { key: "ArrowRight" });
    expect(usePreviewStore.getState().devicePreset).toMatchObject({ id: "custom", label: "Custom" });
    expect(usePreviewStore.getState().customSize).toEqual({ width: 403, height: 852 });
    fireEvent.keyDown(screen.getByTestId("viewport-handle-y"), { key: "ArrowUp" });
    expect(usePreviewStore.getState().customSize).toEqual({ width: 403, height: 842 });
    fireEvent.keyDown(screen.getByTestId("viewport-handle-xy"), { key: "ArrowDown" });
    expect(usePreviewStore.getState().customSize).toEqual({ width: 403, height: 852 });
  });

  it("announces the size as focusable sliders, tracking each keyboard step", () => {
    render(<Harness />);
    const x = screen.getByTestId("viewport-handle-x");
    expect(x).toHaveAttribute("role", "slider");
    expect(x).toHaveAttribute("tabindex", "0");
    expect(x).toHaveAttribute("aria-valuenow", "393");
    expect(x).toHaveAttribute("aria-valuetext", "393 pixels wide");
    fireEvent.keyDown(x, { key: "ArrowRight" });
    expect(x).toHaveAttribute("aria-valuenow", "403");
    const y = screen.getByTestId("viewport-handle-y");
    expect(y).toHaveAttribute("role", "slider");
    expect(y).toHaveAttribute("aria-valuetext", "852 pixels tall");
    expect(screen.getByTestId("viewport-handle-xy")).toHaveAttribute("role", "button");
  });

  it("leaves keys a handle does not act on to the panel (no store write)", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId("viewport-handle-x"), { key: "ArrowDown" });
    expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-16");
  });
});
