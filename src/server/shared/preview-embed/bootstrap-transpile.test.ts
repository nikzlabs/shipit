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
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "embed-bootstrap-")), "probe.ts");
  fs.writeFileSync(probe, [
    `import { EMBED_RESOLVER_SOURCE } from ${JSON.stringify(module)};`,
    "process.stdout.write(EMBED_RESOLVER_SOURCE);",
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

// A page with no DOM to walk is the shape that proves the source parses and runs.
function browserStub(): Record<string, unknown> {
  const win: Record<string, unknown> = { addEventListener: () => undefined };
  win.parent = win;
  return {
    window: win,
    parent: win,
    document: { currentScript: null, documentElement: null, addEventListener: () => undefined },
    location: { host: "id--3000.localhost:8080", protocol: "http:" },
    console: { warn: () => undefined },
  };
}

describe("preview embed resolver serialization", () => {
  it("runs standalone under the production tsx transform", { timeout: 60_000 }, () => {
    const source = sourceUnderProductionLoader();
    const context = vm.createContext(browserStub());

    expect(() => vm.runInContext(source, context)).not.toThrow();
  });
});
