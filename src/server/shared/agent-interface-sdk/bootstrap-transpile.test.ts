/**
 * The serialized bootstrap must run in a browser as-is — under the transform that
 * *production* uses, not the one vitest uses.
 *
 * `AGENT_INTERFACE_SDK_SOURCE` is built with `Function.prototype.toString()`, so it
 * captures whatever the running transpiler emitted inside the function but never the
 * module-scope helpers that emission may reference. Production serves previews from
 * `node --import tsx` (docker/Dockerfile.prod), and esbuild's `keepNames` wraps inner
 * functions in `__name(fn, "fn")` — leaving the injected script to die on
 * `ReferenceError: __name is not defined` before it could define `window.shipit`.
 * Importing the module normally here cannot catch that: vitest's transform emits no
 * wrappers. So this spawns the real production loader and runs what it produces.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

function sourceUnderProductionLoader(): string {
  const module = fileURLToPath(new URL("./bootstrap.ts", import.meta.url));
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sdk-bootstrap-")), "probe.ts");
  fs.writeFileSync(probe, [
    `import { AGENT_INTERFACE_SDK_SOURCE } from ${JSON.stringify(module)};`,
    "process.stdout.write(AGENT_INTERFACE_SDK_SOURCE);",
  ].join("\n"));
  try {
    return execFileSync(process.execPath, ["--import", "tsx", probe], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    fs.rmSync(path.dirname(probe), { recursive: true, force: true });
  }
}

/** Enough of a browser for the install path; the handshake itself is covered in the DOM test. */
function browserStub(): Record<string, unknown> {
  const listeners: unknown[] = [];
  const win: Record<string, unknown> = {
    addEventListener: (_type: string, listener: unknown) => listeners.push(listener),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    postMessage: () => undefined,
  };
  win.parent = win; // top-level: installs the SDK, then fails the handshake without posting
  return { window: win, document: { referrer: "" }, crypto: { randomUUID: () => "id" } };
}

describe("agent interface SDK bootstrap serialization", () => {
  it("runs standalone under the production tsx transform", { timeout: 60_000 }, () => {
    const source = sourceUnderProductionLoader();
    const context = vm.createContext(browserStub());

    expect(() => vm.runInContext(source, context)).not.toThrow();

    const installed = (context.window as { shipit?: unknown }).shipit;
    expect(installed).toBeTypeOf("object");
    // A rejected handshake is expected for a top-level page; don't leave it unhandled.
    void (installed as { ready: Promise<void> }).ready.catch(() => undefined);
  });
});
