import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DOCKERFILE_RAW = readFileSync(
  fileURLToPath(
    new URL(
      "../../../docker/Dockerfile.session-worker.docker",
      import.meta.url,
    ),
  ),
  "utf8",
);

const DOCKERFILE = DOCKERFILE_RAW.split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("session-worker.docker journal group membership", () => {
  it("does not silently swallow the journal-group usermod", () => {
    expect(DOCKERFILE).not.toMatch(/usermod[^\n]*systemd-journal[^\n]*\|\|\s*true/);
  });

  it("creates the groups before adding membership", () => {
    expect(DOCKERFILE).toMatch(/groupadd\s+-rf\s+systemd-journal/);
    expect(DOCKERFILE).toMatch(/groupadd\s+-rf\s+adm/);
    const firstGroupadd = DOCKERFILE.indexOf("groupadd -rf systemd-journal");
    const firstUsermod = DOCKERFILE.indexOf("usermod -aG systemd-journal");
    expect(firstGroupadd).toBeGreaterThanOrEqual(0);
    expect(firstUsermod).toBeGreaterThan(firstGroupadd);
  });

  it("adds each group independently so one missing group can't drop the other", () => {
    expect(DOCKERFILE).toMatch(/usermod\s+-aG\s+systemd-journal\s+shipit/);
    expect(DOCKERFILE).toMatch(/usermod\s+-aG\s+adm\s+shipit/);
    expect(DOCKERFILE).not.toMatch(/usermod\s+-aG\s+systemd-journal,adm/);
  });

  it("asserts membership so a regression fails the build loudly", () => {
    expect(DOCKERFILE).toMatch(/grep\s+-qx\s+systemd-journal/);
    expect(DOCKERFILE).toMatch(/grep\s+-qx\s+adm/);
  });
});
