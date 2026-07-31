/**
 * Regression guards for the non-root worker entrypoint.
 *
 * A restored workspace can contain the UID sentinel and every tracked file as
 * root:root. The sentinel must be ownership-validated: existence alone would
 * skip the recursive handoff and leave Git LFS unable to replace pointer files.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = fileURLToPath(
  new URL("../../../docker/session-worker/entrypoint.sh", import.meta.url),
);

describe("session worker ownership sentinel", () => {
  it("keeps valid shell syntax", () => {
    expect(() => execFileSync("sh", ["-n", ENTRYPOINT])).not.toThrow();
  });

  it("re-chowns when a restored sentinel is not owned by the worker UID", () => {
    const source = readFileSync(ENTRYPOINT, "utf8");
    expect(source).toContain("stat -c '%u' \"$marker\"");
    expect(source).toMatch(/stat -c '%u'.*!= "\$UID_GID"/);
    expect(source).toMatch(/if mkdir "\$marker".*\|\|.*stat -c[\s\S]*chown -R/);
  });
});
