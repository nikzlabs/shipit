import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't implement `window.matchMedia`, so any component reached by a
// render — however deep — that calls `useMediaQuery`/`useIsMobile` throws
// "matchMedia is not a function". Without a default, adding a responsive hook
// to a leaf component breaks every ancestor's test file, which is what happened
// when `ChatQuoteReply` (mounted inside `MessageList`) started reading
// `useIsMobile()`. Default to "no query matches" — i.e. the desktop layout.
// Tests that need a different answer keep overriding `window.matchMedia`
// themselves; this runs in `beforeEach` so each test starts from the default
// again rather than inheriting the previous test's stub.
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

// Radix `FocusScope` (pulled in by every Radix Dialog) schedules a focus-restore
// `setTimeout(…, 0)` on unmount that ends with `container.dispatchEvent(…)`. If
// that timer fires AFTER the jsdom environment is torn down — e.g. it was queued
// by the last test in a worker — `dispatchEvent` throws "parameter 1 is not of
// type 'Event'", which Vitest surfaces as an UNHANDLED ERROR and fails an
// otherwise all-green run. Unmount synchronously, then await a macrotask so the
// pending restore timer drains while jsdom is still alive. `cleanup()` is
// idempotent, so this coexists with React Testing Library's own auto-cleanup
// regardless of afterEach ordering.
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
