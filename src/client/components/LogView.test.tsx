import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { LogView } from "./LogView.js";
import { useLogStore } from "../stores/log-store.js";

// ---- xterm + addon mocks (no DOM/canvas in jsdom) ----
interface MockTerm {
  writes: string[];
  clears: number;
  resets: number;
  write: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}
const terms: MockTerm[] = [];
let lastSearch: { findNext: ReturnType<typeof vi.fn>; findPrevious: ReturnType<typeof vi.fn> } | null = null;

vi.mock("@xterm/xterm", () => {
  class Terminal {
    writes: string[] = [];
    clears = 0;
    resets = 0;
    write = vi.fn((s: string) => { this.writes.push(s); });
    clear = vi.fn(() => { this.clears++; });
    reset = vi.fn(() => { this.resets++; });
    scrollToBottom = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    dispose = vi.fn();
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    buffer = { active: { viewportY: 0, baseY: 0 } };
    constructor() { terms.push(this as unknown as MockTerm); }
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { activate = vi.fn(); } }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn();
    findPrevious = vi.fn();
    clearDecorations = vi.fn();
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
    constructor() { lastSearch = this as unknown as NonNullable<typeof lastSearch>; }
  },
}));
vi.stubGlobal("ResizeObserver", class {
  observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
});

function lastTerm(): MockTerm { return terms[terms.length - 1]; }
function allWrites(): string { return lastTerm().writes.join(""); }

beforeEach(() => {
  terms.length = 0;
  lastSearch = null;
  useLogStore.getState().reset();
});
afterEach(cleanup);

describe("LogView", () => {
  it("writes a snapshot's records with a source prefix when showSource", () => {
    render(<LogView channel="agent" showSource send={vi.fn()} />);
    act(() => {
      useLogStore.getState().snapshot("agent", [
        { ts: "2026-01-01T00:00:00.000Z", source: "server", text: "Agent process started" },
        { ts: "2026-01-01T00:00:01.000Z", source: "stderr", text: "boom" },
      ]);
    });
    const out = allWrites();
    expect(out).toContain("[srv]");
    expect(out).toContain("Agent process started");
    expect(out).toContain("[err]");
    expect(out).toContain("boom");
  });

  it("writes service records raw (no source prefix)", () => {
    render(<LogView channel="service:web" send={vi.fn()} />);
    act(() => {
      useLogStore.getState().snapshot("service:web", [{ ts: "", text: "line one\nline two\n" }]);
    });
    const out = allWrites();
    expect(out).toContain("line one\nline two\n");
    expect(out).not.toContain("[");
  });

  it("appends incrementally without rewriting prior records", () => {
    render(<LogView channel="agent" showSource send={vi.fn()} />);
    act(() => {
      useLogStore.getState().snapshot("agent", [{ ts: "t", source: "server", text: "first" }]);
    });
    const term = lastTerm();
    const clearsAfterSnapshot = term.clears;
    act(() => {
      useLogStore.getState().append("agent", [{ ts: "t", source: "stdout", text: "second" }]);
    });
    // No extra clear/reset on a pure append — only the new record is written.
    expect(term.clears).toBe(clearsAfterSnapshot);
    expect(allWrites()).toContain("second");
  });

  it("clears (epoch bump) by rewriting an empty buffer", () => {
    render(<LogView channel="agent" showSource send={vi.fn()} />);
    act(() => {
      useLogStore.getState().snapshot("agent", [{ ts: "t", source: "server", text: "keep?" }]);
    });
    const term = lastTerm();
    const clearsBefore = term.clears;
    act(() => {
      useLogStore.getState().clearChannel("agent");
    });
    // Epoch bumped → full rewrite path runs term.clear()/reset() again.
    expect(term.clears).toBeGreaterThan(clearsBefore);
  });

  it("subscribes to its channel on mount", () => {
    const send = vi.fn();
    render(<LogView channel="service:api" send={send} />);
    expect(send).toHaveBeenCalledWith({ type: "subscribe_logs", channel: "service:api" });
  });

  it("runs a forward search as the query changes", () => {
    const { getByLabelText } = render(<LogView channel="agent" showSource send={vi.fn()} />);
    fireEvent.change(getByLabelText("Search logs"), { target: { value: "boom" } });
    expect(lastSearch!.findNext).toHaveBeenCalledWith("boom", expect.anything());
  });

  it("searches backward on Shift+Enter", () => {
    const { getByLabelText } = render(<LogView channel="agent" showSource send={vi.fn()} />);
    const input = getByLabelText("Search logs");
    fireEvent.change(input, { target: { value: "boom" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(lastSearch!.findPrevious).toHaveBeenCalledWith("boom", expect.anything());
  });
});
