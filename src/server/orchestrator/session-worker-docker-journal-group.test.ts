import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the docs/128 ops-session journal pillar (see
// docs/150 checklist). The ops `.docker` image must add `shipit` to the
// `systemd-journal` (and `adm`) group so `journalctl -D /var/log/journal` can
// read the 0640 root:systemd-journal host journal mounts.
//
// The original `usermod -aG systemd-journal,adm shipit || true` shipped broken:
// `usermod -aG a,b` is ATOMIC, the `systemd` install doesn't reliably create the
// `systemd-journal` group at build time, so the whole add failed and `|| true`
// masked it — every ops session shipped with `shipit` in NO supplementary
// groups. We can't `docker build` in-session (no daemon, and a build OOMs the
// box), so guard the Dockerfile source: the dangerous masked pattern must not
// come back, the groups must be created before membership, and membership must
// be asserted so a real build fails loudly on regression.
const DOCKERFILE_RAW = readFileSync(
  fileURLToPath(
    new URL(
      "../../../docker/Dockerfile.session-worker.docker",
      import.meta.url,
    ),
  ),
  "utf8",
);

// Match against instructions only — the Dockerfile comments quote the old
// broken `usermod ... || true` pattern as documentation, which would otherwise
// trip the "must not contain" guards below.
const DOCKERFILE = DOCKERFILE_RAW.split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("session-worker.docker journal group membership", () => {
  it("does not silently swallow the journal-group usermod", () => {
    // `|| true` on a usermod that adds journal groups is exactly the bug:
    // a failed add becomes a green build with shipit in no groups.
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
    // Per-group adds, not a single atomic `usermod -aG systemd-journal,adm`.
    expect(DOCKERFILE).toMatch(/usermod\s+-aG\s+systemd-journal\s+shipit/);
    expect(DOCKERFILE).toMatch(/usermod\s+-aG\s+adm\s+shipit/);
    expect(DOCKERFILE).not.toMatch(/usermod\s+-aG\s+systemd-journal,adm/);
  });

  it("asserts membership so a regression fails the build loudly", () => {
    // The build must verify shipit actually landed in both groups.
    expect(DOCKERFILE).toMatch(/grep\s+-qx\s+systemd-journal/);
    expect(DOCKERFILE).toMatch(/grep\s+-qx\s+adm/);
  });
});
