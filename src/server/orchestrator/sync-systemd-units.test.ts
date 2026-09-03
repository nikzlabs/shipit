/**
 * Drives the REAL unit sync (deployment/lib/sync-systemd-units.sh) against a
 * throwaway "installed units" directory and a fake `systemctl` on PATH.
 *
 * Why it exists: setup.sh installs the systemd units at PROVISIONING time only.
 * Every unit change since — the self-updater's `TimeoutStartSec=` among them —
 * therefore sat in the repo and never reached the running production host, no
 * matter how many times it updated itself. deploy.sh calls this on every deploy
 * to close that gap, so what must hold is that it installs a drifted unit,
 * reloads systemd exactly once, and stays completely silent when there is
 * nothing to do or nowhere to write.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = fileURLToPath(
  new URL("../../../deployment/lib/sync-systemd-units.sh", import.meta.url),
);
const UNIT_SRC = fileURLToPath(new URL("../../../deployment/vps", import.meta.url));

describe("deployment/lib/sync-systemd-units.sh", () => {
  let root: string;
  let unitDir: string;
  let binDir: string;
  let reloadLog: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-units-"));
    unitDir = path.join(root, "units");
    binDir = path.join(root, "bin");
    reloadLog = path.join(root, "reloads");
    fs.mkdirSync(unitDir);
    fs.mkdirSync(binDir);
    // Fake systemctl: records each invocation instead of talking to a real init.
    fs.writeFileSync(
      path.join(binDir, "systemctl"),
      `#!/bin/bash\necho "$@" >> "${reloadLog}"\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /**
   * Source the helper and run it against the temp dirs, returning stdout AND
   * stderr — the warnings this thing emits when it cannot install a unit go to
   * stderr, so a stdout-only assertion could not fail on them.
   */
  const sync = (dir = unitDir): string =>
    execFileSync(
      "bash",
      ["-c", `. "${HELPER}"; shipit_sync_systemd_units "${UNIT_SRC}" "${dir}" 2>&1`],
      { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
    ).toString();

  const reloads = (): number =>
    fs.existsSync(reloadLog) ? fs.readFileSync(reloadLog, "utf8").trim().split("\n").length : 0;

  it("installs the units and reloads systemd once", () => {
    const out = sync();

    const service = path.join(unitDir, "shipit-updater.service");
    expect(fs.readFileSync(service, "utf8")).toBe(
      fs.readFileSync(path.join(UNIT_SRC, "shipit-updater.service"), "utf8"),
    );
    expect(fs.existsSync(path.join(unitDir, "shipit-restarter.path"))).toBe(true);
    expect(out).toContain("Updated systemd unit shipit-updater.service");
    // One reload for the batch, not one per unit.
    expect(reloads()).toBe(1);
  });

  it("replaces a unit that drifted from the checkout", () => {
    const service = path.join(unitDir, "shipit-updater.service");
    sync();
    // An old install: same unit, missing the bound the checkout now carries.
    fs.writeFileSync(service, "[Service]\nExecStart=/opt/shipit/deployment/vps/update.sh\n");
    fs.rmSync(reloadLog);

    sync();

    // Anchored: `toContain("TimeoutStartSec=")` would also match the comment
    // that explains the setting, so deleting the directive left it green.
    expect(fs.readFileSync(service, "utf8")).toMatch(/^TimeoutStartSec=90min$/m);
    expect(reloads()).toBe(1);
  });

  it("copies nothing when every unit already matches, but still reloads", () => {
    sync();
    fs.rmSync(reloadLog);

    const out = sync();

    expect(out).toBe(""); // no churn, no log line on the common path
    // The reload is unconditional on purpose: one that failed on an earlier run
    // would otherwise never be retried, since the files already match.
    expect(reloads()).toBe(1);
  });

  it("leaves no partial unit when the install fails", () => {
    sync();
    const service = path.join(unitDir, "shipit-updater.service");
    const good = fs.readFileSync(service, "utf8");
    fs.writeFileSync(service, "stale\n");
    // Block the atomic rename's destination name, so the install cannot finish.
    fs.mkdirSync(path.join(unitDir, ".shipit-updater.service.new"));

    const out = sync();

    expect(out).toContain("WARNING: could not install shipit-updater.service");
    // Either the old unit or the new one — never a truncated file.
    expect(fs.readFileSync(service, "utf8")).toBe("stale\n");
    // The other units still installed; one bad unit does not abort the sweep.
    expect(fs.readFileSync(path.join(unitDir, "shipit-restarter.path"), "utf8")).toBe(
      fs.readFileSync(path.join(UNIT_SRC, "shipit-restarter.path"), "utf8"),
    );
    expect(good).toMatch(/TimeoutStartSec/);
  });

  it("is a silent no-op when there is nowhere to install units", () => {
    // A host with no such directory: the deploy must carry on rather than fail
    // on a path it was never meant to touch.
    const out = sync(path.join(root, "no-such-dir"));

    expect(out).toBe("");
    expect(reloads()).toBe(0);
  });

  it("is a silent no-op when the unit directory is read-only", () => {
    // `bash deploy.sh` as a normal user. Separate from the missing-directory
    // case: one guard covers each, and neither alone covers both.
    const readOnly = path.join(root, "read-only");
    fs.mkdirSync(readOnly, { mode: 0o500 });

    const out = sync(readOnly);

    expect(out).toBe("");
    expect(reloads()).toBe(0);
    expect(fs.readdirSync(readOnly)).toEqual([]);
  });

  describe("wiring into deploy.sh", () => {
    // Comment-stripped, so a mention in prose cannot stand in for the call.
    const deploySrc = fs
      .readFileSync(fileURLToPath(new URL("../../../deployment/vps/deploy.sh", import.meta.url)), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    it("sources the helper and calls it", () => {
      expect(deploySrc).toMatch(/deployment\/lib\/sync-systemd-units\.sh/);
      expect(deploySrc).toMatch(/shipit_sync_systemd_units\s/);
    });

    it("writes the restart marker after the restart, never before", () => {
      const restart = deploySrc.indexOf("up -d --no-build shipit");
      const marker = deploySrc.indexOf("SHIPIT_RESTART_MARKER");
      expect(restart).toBeGreaterThan(-1);
      // update.sh treats the marker as "the new container is running". Written
      // any earlier, it would suppress a rollback that must still happen.
      expect(marker).toBeGreaterThan(restart);
    });
  });
});
