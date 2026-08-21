import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ViewportResizeHandles } from "./ViewportResizeHandles.js";
import { VIEWPORT_SIZE_MIN } from "../device-presets.js";

afterEach(cleanup);

const WIDTH_HANDLE = "Drag to resize the preview width";
const HEIGHT_HANDLE = "Drag to resize the preview height";
const CORNER_HANDLE = /Drag to resize the preview width and height/;

function setup(over: Partial<React.ComponentProps<typeof ViewportResizeHandles>> = {}) {
  const onResize = vi.fn();
  render(
    <ViewportResizeHandles
      deviceWidth={400}
      deviceHeight={800}
      deviceScale={1}
      isLandscape={false}
      onResize={onResize}
      {...over}
    />,
  );
  return { onResize };
}

/** Press, move and release a handle, in device-independent screen px. */
function drag(handle: HTMLElement, dx: number, dy: number) {
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
}

describe("ViewportResizeHandles", () => {
  it("resizes the width when the right edge is dragged", () => {
    const { onResize } = setup();
    drag(screen.getByLabelText(WIDTH_HANDLE), 25, 0);
    expect(onResize).toHaveBeenLastCalledWith({ width: 450, height: 800 });
  });

  it("resizes the height when the bottom edge is dragged", () => {
    const { onResize } = setup();
    drag(screen.getByLabelText(HEIGHT_HANDLE), 0, 25);
    expect(onResize).toHaveBeenLastCalledWith({ width: 400, height: 850 });
  });

  it("resizes both axes from the corner", () => {
    const { onResize } = setup();
    drag(screen.getByLabelText(CORNER_HANDLE), 25, 25);
    expect(onResize).toHaveBeenLastCalledWith({ width: 450, height: 850 });
  });

  it("reports every step of a drag, so the readout can follow it live", () => {
    const { onResize } = setup();
    const handle = screen.getByLabelText(WIDTH_HANDLE);
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 110, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, clientY: 100, pointerId: 1 });
    expect(onResize.mock.calls.map((c) => c[0].width)).toEqual([420, 460]);
  });

  it("measures every move from where the drag STARTED, not from the last move", () => {
    // Accumulating per-move deltas instead would make the size drift away from
    // the pointer over a long drag, and back-and-forth would not return.
    const { onResize } = setup();
    const handle = screen.getByLabelText(WIDTH_HANDLE);
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith({ width: 400, height: 800 });
  });

  it("ignores pointer movement before a drag has begun", () => {
    const { onResize } = setup();
    fireEvent.pointerMove(screen.getByLabelText(WIDTH_HANDLE), { clientX: 300, clientY: 100, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("stops resizing once the pointer is released", () => {
    const { onResize } = setup();
    const handle = screen.getByLabelText(WIDTH_HANDLE);
    drag(handle, 25, 0);
    onResize.mockClear();
    fireEvent.pointerMove(handle, { clientX: 400, clientY: 100, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("abandons the drag when the pointer is cancelled", () => {
    const { onResize } = setup();
    const handle = screen.getByLabelText(WIDTH_HANDLE);
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    onResize.mockClear();
    fireEvent.pointerMove(handle, { clientX: 400, clientY: 100, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("does not start a drag on a right-click", () => {
    const { onResize } = setup();
    const handle = screen.getByLabelText(WIDTH_HANDLE);
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1, button: 2 });
    fireEvent.pointerMove(handle, { clientX: 200, clientY: 100, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("commits a landscape drag the right way round", () => {
    // Rendered 800×400 (a rotated 400×800). Widening the rendered frame has to
    // grow the STORED height, or rotating back would transpose the drag.
    const { onResize } = setup({ deviceWidth: 800, deviceHeight: 400, isLandscape: true });
    drag(screen.getByLabelText(WIDTH_HANDLE), 25, 0);
    expect(onResize).toHaveBeenLastCalledWith({ width: 400, height: 850 });
  });

  it("turns pointer travel into more viewport px when the frame is scaled down", () => {
    const { onResize } = setup({ deviceScale: 0.5 });
    drag(screen.getByLabelText(WIDTH_HANDLE), 25, 0);
    expect(onResize).toHaveBeenLastCalledWith({ width: 500, height: 800 });
  });

  it("resizes from the keyboard on the handle's own axis", () => {
    const { onResize } = setup();
    fireEvent.keyDown(screen.getByLabelText(WIDTH_HANDLE), { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith({ width: 410, height: 800 });
  });

  it("leaves keys it does not act on to the page", () => {
    const { onResize } = setup();
    const event = fireEvent.keyDown(screen.getByLabelText(WIDTH_HANDLE), { key: "ArrowUp" });
    expect(onResize).not.toHaveBeenCalled();
    // `fireEvent` returns false when the handler called preventDefault.
    expect(event).toBe(true);
  });

  it("will not shrink past the minimum viewport", () => {
    const { onResize } = setup({ deviceWidth: VIEWPORT_SIZE_MIN });
    drag(screen.getByLabelText(WIDTH_HANDLE), -500, 0);
    expect(onResize).toHaveBeenLastCalledWith({ width: VIEWPORT_SIZE_MIN, height: 800 });
  });

  it("exposes the live size to assistive tech as the handles move", () => {
    const { rerender } = render(
      <ViewportResizeHandles
        deviceWidth={400} deviceHeight={800} deviceScale={1} isLandscape={false} onResize={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(WIDTH_HANDLE)).toHaveAttribute("aria-valuenow", "400");
    rerender(
      <ViewportResizeHandles
        deviceWidth={640} deviceHeight={800} deviceScale={1} isLandscape={false} onResize={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(WIDTH_HANDLE)).toHaveAttribute("aria-valuenow", "640");
  });

  it("is reachable by keyboard", () => {
    setup();
    for (const label of [WIDTH_HANDLE, HEIGHT_HANDLE]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("tabindex", "0");
    }
  });
});
