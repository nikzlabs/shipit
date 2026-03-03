import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createRef } from "react";

// Track calls through module-level arrays that survive vi.mock hoisting
const terminalInstances: Array<{
  write: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
}> = [];

const fitInstances: Array<{
  fit: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    write = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    cols = 80;
    rows = 24;
    constructor() {
      terminalInstances.push(this);
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
    constructor() {
      fitInstances.push(this);
    }
  }
  return { FitAddon: MockFitAddon };
});

vi.mock("@xterm/addon-web-links", () => {
  class MockWebLinksAddon {}
  return { WebLinksAddon: MockWebLinksAddon };
});

// Mock the CSS import
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// Stub ResizeObserver since jsdom doesn't support it
const observerInstances: Array<{
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  callback: () => void;
}> = [];

vi.stubGlobal("ResizeObserver", class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  callback: () => void;
  constructor(cb: () => void) {
    this.callback = cb;
    observerInstances.push(this);
  }
});

beforeEach(() => {
  terminalInstances.length = 0;
  fitInstances.length = 0;
  observerInstances.length = 0;
});

afterEach(cleanup);

// Import after mocks are set up
import { InteractiveTerminal, type InteractiveTerminalHandle } from "./InteractiveTerminal.js";

describe("InteractiveTerminal", () => {
  it("mounts and calls onStart", () => {
    const onStart = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();

    render(
      <InteractiveTerminal
        onStart={onStart}
        onInput={onInput}
        onResize={onResize}
      />,
    );

    expect(onStart).toHaveBeenCalledOnce();
  });

  it("creates an xterm Terminal and opens it", () => {
    const onStart = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();

    render(
      <InteractiveTerminal
        onStart={onStart}
        onInput={onInput}
        onResize={onResize}
      />,
    );

    expect(terminalInstances).toHaveLength(1);
    expect(terminalInstances[0].open).toHaveBeenCalledOnce();
    expect(terminalInstances[0].loadAddon).toHaveBeenCalledTimes(2); // FitAddon + WebLinksAddon
  });

  it("writes received data to terminal instance via ref", () => {
    const onStart = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();
    const ref = createRef<InteractiveTerminalHandle>();

    render(
      <InteractiveTerminal
        ref={ref}
        onStart={onStart}
        onInput={onInput}
        onResize={onResize}
      />,
    );

    ref.current?.write("hello from server");
    expect(terminalInstances[0].write).toHaveBeenCalledWith("hello from server");
  });

  it("user input triggers onInput callback", () => {
    const onStart = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();

    render(
      <InteractiveTerminal
        onStart={onStart}
        onInput={onInput}
        onResize={onResize}
      />,
    );

    // Get the callback passed to terminal.onData and invoke it
    const term = terminalInstances[0];
    expect(term.onData).toHaveBeenCalledOnce();
    const dataHandler = term.onData.mock.calls[0][0];
    dataHandler("user typed this");

    expect(onInput).toHaveBeenCalledWith("user typed this");
  });

  it("sets up ResizeObserver on the container", () => {
    const onStart = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();

    render(
      <InteractiveTerminal
        onStart={onStart}
        onInput={onInput}
        onResize={onResize}
      />,
    );

    expect(observerInstances).toHaveLength(1);
    expect(observerInstances[0].observe).toHaveBeenCalledOnce();
  });

  it("cleans up terminal and observer on unmount", () => {
    const onStart = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();

    const { unmount } = render(
      <InteractiveTerminal
        onStart={onStart}
        onInput={onInput}
        onResize={onResize}
      />,
    );

    const term = terminalInstances[0];
    const observer = observerInstances[0];

    unmount();

    expect(term.dispose).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("calls onStart with initial cols and rows", () => {
    const onStart = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();

    render(
      <InteractiveTerminal
        onStart={onStart}
        onInput={onInput}
        onResize={onResize}
      />,
    );

    expect(onStart).toHaveBeenCalledWith(80, 24);
  });

  it("debounces resize observer callbacks", async () => {
    const onStart = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();

    vi.useFakeTimers();

    render(
      <InteractiveTerminal
        onStart={onStart}
        onInput={onInput}
        onResize={onResize}
      />,
    );

    const observer = observerInstances[0];

    // Simulate rapid resize events
    observer.callback();
    observer.callback();
    observer.callback();

    // onResize should not have been called yet (debounced)
    expect(onResize).not.toHaveBeenCalled();

    // Advance timer past the debounce period (150ms)
    vi.advanceTimersByTime(150);

    // Now it should have been called exactly once
    expect(onResize).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});
