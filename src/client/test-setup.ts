import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

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
