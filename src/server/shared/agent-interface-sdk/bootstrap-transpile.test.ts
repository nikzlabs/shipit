// Vitest omits the keepNames wrappers that production tsx adds to the serialized function.

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

function browserStub(): Record<string, unknown> {
  const listeners: unknown[] = [];
  const win: Record<string, unknown> = {
    addEventListener: (_type: string, listener: unknown) => listeners.push(listener),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    postMessage: () => undefined,
  };
  win.parent = win;
  return { window: win, document: { referrer: "" }, crypto: { randomUUID: () => "id" } };
}

describe("agent interface SDK bootstrap serialization", () => {
  it("runs standalone under the production tsx transform", { timeout: 60_000 }, () => {
    const source = sourceUnderProductionLoader();
    const context = vm.createContext(browserStub());

    expect(() => vm.runInContext(source, context)).not.toThrow();

    const installed = (context.window as { shipit?: unknown }).shipit;
    expect(installed).toBeTypeOf("object");
    void (installed as { ready: Promise<void> }).ready.catch(() => undefined);
  });
});
