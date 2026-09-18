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
    fs.writeFileSync(
      path.join(binDir, "systemctl"),
      `#!/bin/bash\necho "$@" >> "${reloadLog}"\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // Include stderr so warnings fail the silence assertions.
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
    expect(reloads()).toBe(1);
  });

  it("replaces a unit that drifted from the checkout", () => {
    const service = path.join(unitDir, "shipit-updater.service");
    sync();
    fs.writeFileSync(service, "[Service]\nExecStart=/opt/shipit/deployment/vps/update.sh\n");
    fs.rmSync(reloadLog);

    sync();

    expect(fs.readFileSync(service, "utf8")).toMatch(/^TimeoutStartSec=90min$/m);
    expect(reloads()).toBe(1);
  });

  it("copies nothing when every unit already matches, but still reloads", () => {
    sync();
    fs.rmSync(reloadLog);

    const out = sync();

    expect(out).toBe("");
    expect(reloads()).toBe(1);
  });

  it("leaves no partial unit when the install fails", () => {
    sync();
    const service = path.join(unitDir, "shipit-updater.service");
    const good = fs.readFileSync(service, "utf8");
    fs.writeFileSync(service, "stale\n");
    fs.mkdirSync(path.join(unitDir, ".shipit-updater.service.new"));

    const out = sync();

    expect(out).toContain("WARNING: could not install shipit-updater.service");
    expect(fs.readFileSync(service, "utf8")).toBe("stale\n");
    expect(fs.readFileSync(path.join(unitDir, "shipit-restarter.path"), "utf8")).toBe(
      fs.readFileSync(path.join(UNIT_SRC, "shipit-restarter.path"), "utf8"),
    );
    expect(good).toMatch(/TimeoutStartSec/);
  });

  it("is a silent no-op when there is nowhere to install units", () => {
    const out = sync(path.join(root, "no-such-dir"));

    expect(out).toBe("");
    expect(reloads()).toBe(0);
  });

  it("is a silent no-op when the unit directory is read-only", () => {
    const readOnly = path.join(root, "read-only");
    fs.mkdirSync(readOnly, { mode: 0o500 });

    const out = sync(readOnly);

    expect(out).toBe("");
    expect(reloads()).toBe(0);
    expect(fs.readdirSync(readOnly)).toEqual([]);
  });

  describe("wiring into deploy.sh", () => {
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
      expect(marker).toBeGreaterThan(restart);
    });
  });
});
