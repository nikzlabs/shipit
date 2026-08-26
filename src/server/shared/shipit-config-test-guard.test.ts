/**
 * planning#480 — the guard that stops a malformed `shipit.yaml` fixture from
 * silently disabling the check a test claims to exercise.
 *
 * The guard is installed by `server-test-setup.ts` for the whole server project,
 * so these tests exercise the LIVE hook rather than a locally-installed copy:
 * `fs.writeFileSync` is already wrapped by the time this file loads. That is the
 * point — a test asserting the guard works against its own private instance
 * would pass even if the setup file stopped installing it.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectInvalidShipitConfig } from "./shipit-config-test-guard.js";
import { resolveShipitConfig } from "./shipit-config.js";

describe("shipit.yaml fixture guard", () => {
  let dir: string;
  const at = (name = "shipit.yaml") => path.join(dir, name);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-fixture-guard-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects the exact fixture that made three dep-dir tests vacuous", () => {
    // YAML parses the unquoted `true` as a boolean; `parseInstallList` rejects
    // it, and every opportunistic reader then checks nothing.
    expect(() =>
      fs.writeFileSync(at(), "agent:\n  install:\n    - true\n  dep-dirs:\n    - node_modules\n"),
    ).toThrow(/Invalid shipit.yaml fixture/);
  });

  it("names the parser's own reason, and shows the fixture", () => {
    let message = "";
    try {
      fs.writeFileSync(at(), "agent:\n  install:\n    - 42\n");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("`agent.install[0]` must be a string");
    // The fixture is echoed because a fixture is often built by interpolation,
    // where the offending value is not visible in the test source.
    expect(message).toContain("- 42");
  });

  it("accepts the quoted form, and the file really lands", () => {
    const yaml = 'agent:\n  install:\n    - "true"\n  dep-dirs:\n    - node_modules\n';
    expect(() => fs.writeFileSync(at(), yaml)).not.toThrow();
    expect(resolveShipitConfig(dir).agent).toMatchObject({
      install: ["true"],
      depDirs: ["node_modules"],
    });
  });

  it("accepts an empty fixture, matching resolveShipitConfig's own tolerance", () => {
    // An empty shipit.yaml resolves to defaults rather than throwing, so the
    // guard must not be stricter than the product it is protecting.
    expect(() => fs.writeFileSync(at(), "")).not.toThrow();
    expect(() => fs.writeFileSync(at(), "\n  \n")).not.toThrow();
  });

  it("ignores files that are not shipit.yaml", () => {
    expect(() => fs.writeFileSync(at("docker-compose.yml"), "agent:\n  install:\n    - true\n")).not.toThrow();
    expect(() => fs.writeFileSync(at("shipit.yaml.bak"), "agent:\n  install:\n    - true\n")).not.toThrow();
  });

  it("guards the promise write too", async () => {
    await expect(fsp.writeFile(at(), "agent:\n  install:\n    - true\n")).rejects.toThrow(
      /Invalid shipit.yaml fixture/,
    );
  });

  it("checks a Buffer payload, not only a string", () => {
    expect(() => fs.writeFileSync(at(), Buffer.from("agent:\n  install:\n    - true\n"))).toThrow(
      /Invalid shipit.yaml fixture/,
    );
  });

  it("lets a test opt out when the invalid config IS the fixture", () => {
    expect(() =>
      expectInvalidShipitConfig(() => {
        fs.writeFileSync(at(), "agent: bad_value\n");
      }),
    ).not.toThrow();
    expect(fs.readFileSync(at(), "utf8")).toBe("agent: bad_value\n");
  });

  it("restores the guard even when the opted-out body throws", () => {
    // The usual shape of such a test is an assertion that something rejects, so
    // the body throwing is the normal path, not the edge case. A guard left off
    // would silently un-protect the rest of the file.
    expect(() =>
      expectInvalidShipitConfig(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(() => fs.writeFileSync(at(), "agent:\n  install:\n    - true\n")).toThrow(
      /Invalid shipit.yaml fixture/,
    );
  });
});
