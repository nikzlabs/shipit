import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { credentialStorageEnvNames } from "./catalogue/index.js";
import { CREDENTIAL_ROUTE_ENV_PREFIX } from "./types/domain-types/credential-route.js";

describe("server test environment is hermetic", () => {
  it("still injects the ambient-credential sentinels", () => {
    expect(
      process.env.SHIPIT_TEST_AMBIENT_ENV_MARKER,
      "the `server` project's `env` block in vitest.config.ts no longer injects the sentinel "
        + "credentials, so nothing here proves server-test-setup.ts strips them",
    ).toBe("1");
  });

  it("strips every catalogue credential variable", () => {
    for (const name of credentialStorageEnvNames()) {
      expect(process.env[name], `${name} leaked into a server test`).toBeUndefined();
    }
  });

  it("strips every per-route credential variable", () => {
    const leaked = Object.keys(process.env).filter((n) =>
      n.startsWith(CREDENTIAL_ROUTE_ENV_PREFIX),
    );
    expect(leaked, `${CREDENTIAL_ROUTE_ENV_PREFIX}* leaked into a server test`).toEqual([]);
  });

  it("strips inherited sub-agent depth", () => {
    expect(
      process.env.SHIPIT_AGENT_DEPTH,
      "SHIPIT_AGENT_DEPTH leaked into a server test, so primary-agent fixtures run as nested agents",
    ).toBeUndefined();
  });

  it("re-strips between tests in the same file", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-written-by-a-test";
  });

  it("sees no credential from the preceding test", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("gives the suite its own throwaway global git config", () => {
    const configPath = process.env.GIT_CONFIG_GLOBAL;
    expect(
      configPath,
      "GIT_CONFIG_GLOBAL is unset, so `globalCredentialFilePath()` falls back to /credentials — "
        + "the session's own credential directory",
    ).toBeDefined();
    // macOS can resolve the temp directory through a symlink.
    const realTmp = fs.realpathSync(os.tmpdir());
    const realConfigDir = fs.realpathSync(path.dirname(configPath!));
    expect(
      realConfigDir.startsWith(realTmp + path.sep) || realConfigDir === realTmp,
      `GIT_CONFIG_GLOBAL points at ${configPath} — outside the temp dir, so a test's `
        + "`git config --global` write lands on a real config (in a session container, the "
        + "brokered /credentials/.gitconfig)",
    ).toBe(true);
  });

  // Scan source because a write in another test worker is not observable here.
  it("no test passes the live credentials volume as a host path", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    // These projects use server-test-setup.ts; the client uses a separate setup.
    const setupFileRoots = ["src/server", "scripts"];
    const roots = setupFileRoots.map((rel) => path.join(repoRoot, rel));
    const offenders: string[] = [];
    const scanned: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (entry.name.endsWith(".test.ts")) {
          const rel = path.relative(repoRoot, full);
          scanned.push(rel);
          const text = fs.readFileSync(full, "utf-8");
          text.split("\n").forEach((line, i) => {
            if (/credentialsDir:\s*"\/credentials"/.test(line)) {
              offenders.push(`${rel}:${i + 1}`);
            }
          });
        }
      }
    };
    for (const root of roots) walk(root);

    for (const rel of setupFileRoots) {
      expect(
        scanned.some((f) => f.startsWith(`${rel}${path.sep}`)),
        `the scan reached no *.test.ts under ${rel}/ — it covers a project whose tests load `
          + "server-test-setup.ts, so a live-credentials write there would go uncaught",
      ).toBe(true);
    }

    expect(
      offenders,
      "these tests would write fixture credential subtrees into the live /credentials volume — "
        + "import TEST_CREDENTIALS_DIR from orchestrator/credentials-test-helpers.js instead",
    ).toEqual([]);
  });
});
