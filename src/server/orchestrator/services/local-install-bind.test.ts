import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Drives the REAL local-install helpers (deployment/local/lib.sh) against a
 * throwaway SHIPIT_HOME and a stubbed `tailscale` binary on PATH, in the same
 * spirit as update-script.test.ts (which drives the real VPS updater and stubs
 * only the Docker build).
 *
 * The properties under test are docs/254's requirements, not the implementation:
 * a user without Tailscale is untouched (req 3), an opted-in user gets a tailnet
 * binding ALONGSIDE loopback (req 4), Tailscale being unavailable never blocks
 * startup (req 5), and a changed tailnet address is re-derived rather than
 * remembered (req 6).
 *
 * Why this matters enough to test the shell directly: the failure mode it guards
 * is "ShipIt won't start", and the reason the binding is computed at runtime at
 * all is that Docker fails the whole container when any one published binding
 * can't be bound. That is invisible in a unit test of anything else.
 */
const LIB_SH = fileURLToPath(
  new URL("../../../../deployment/local/lib.sh", import.meta.url),
);
const COMPOSE_YML = fileURLToPath(
  new URL("../../../../docker/local/prod/compose.yml", import.meta.url),
);

describe("deployment/local/lib.sh — tailnet bind resolution (docs/254)", () => {
  let root: string;
  let home: string;
  let binDir: string;
  let envFile: string;
  let overlay: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-bind-"));
    home = path.join(root, "home");
    binDir = path.join(root, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    envFile = path.join(home, ".shipit.env");
    overlay = path.join(home, ".shipit-tailnet.compose.yml");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Install a fake `tailscale` on PATH. `ip: null` models installed-but-not-connected. */
  function stubTailscale(ip: string | null): void {
    const script =
      ip === null
        ? "#!/bin/sh\nexit 1\n"
        : `#!/bin/sh\n[ "$1" = "ip" ] && echo "${ip}"\n`;
    const p = path.join(binDir, "tailscale");
    fs.writeFileSync(p, script);
    fs.chmodSync(p, 0o755);
  }

  /**
   * Source lib.sh and run the refresh, returning the `-f` args it would hand to
   * docker compose plus whatever it wrote to stderr. `withTailscale: false`
   * models a machine that has never had Tailscale installed.
   */
  function refresh(opts: { withTailscale: boolean }): { args: string; stderr: string } {
    const stderrFile = path.join(root, "stderr.txt");
    // A PATH without the stub dir still needs the real coreutils lib.sh calls.
    const pathEnv = opts.withTailscale
      ? `${binDir}:${process.env.PATH ?? ""}`
      : (process.env.PATH ?? "");
    const script = `
      set -euo pipefail
      SHIPIT_HOME=${JSON.stringify(home)}
      . ${JSON.stringify(LIB_SH)}
      shipit_load_env_file
      shipit_refresh_tailnet_bind
      shipit_compose_files
    `;
    const out = execFileSync("bash", ["-c", script], {
      env: { ...process.env, PATH: pathEnv, HOME: home },
      stdio: ["pipe", "pipe", fs.openSync(stderrFile, "w")],
    }).toString();
    return { args: out, stderr: fs.readFileSync(stderrFile, "utf8") };
  }

  it("leaves a non-opted-in install completely alone, even with Tailscale running (req 3)", () => {
    stubTailscale("100.83.12.47");
    const { args } = refresh({ withTailscale: true });

    expect(fs.existsSync(overlay)).toBe(false);
    // Exactly one -f, the base compose file: nothing about this install changed.
    expect(args.trim().split("\n")).toEqual([
      "-f",
      path.join(home, "docker/local/prod/compose.yml"),
    ]);
  });

  it("adds a tailnet binding alongside loopback when opted in (req 4)", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");
    stubTailscale("100.83.12.47");

    const { args } = refresh({ withTailscale: true });

    expect(fs.existsSync(overlay)).toBe(true);
    const yml = fs.readFileSync(overlay, "utf8");
    expect(yml).toContain('"100.83.12.47:4123:4123"');
    // The overlay ADDS a port; it must not restate/replace the loopback binding,
    // which lives in compose.yml and is what keeps localhost working.
    expect(yml).not.toContain("127.0.0.1");
    // Both files are passed to compose, base first so the overlay merges onto it.
    const parts = args.trim().split("\n");
    expect(parts.filter((p) => p === "-f")).toHaveLength(2);
    expect(parts[parts.length - 1]).toBe(overlay);
  });

  it("still starts, on loopback only, when Tailscale is not installed (req 5)", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");

    const { args, stderr } = refresh({ withTailscale: false });

    // The whole point: no overlay, no non-zero exit, no bind on a missing IP.
    expect(fs.existsSync(overlay)).toBe(false);
    expect(args.trim().split("\n").filter((p) => p === "-f")).toHaveLength(1);
    expect(stderr).toContain("localhost only");
  });

  it("still starts, on loopback only, when Tailscale is installed but disconnected (req 5)", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");
    stubTailscale(null);

    const { args, stderr } = refresh({ withTailscale: true });

    expect(fs.existsSync(overlay)).toBe(false);
    expect(args.trim().split("\n").filter((p) => p === "-f")).toHaveLength(1);
    expect(stderr).toContain("localhost only");
  });

  it("re-derives a changed tailnet address instead of reusing the old one (req 6)", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");
    stubTailscale("100.83.12.47");
    refresh({ withTailscale: true });
    expect(fs.readFileSync(overlay, "utf8")).toContain("100.83.12.47");

    stubTailscale("100.99.1.2");
    refresh({ withTailscale: true });

    const yml = fs.readFileSync(overlay, "utf8");
    expect(yml).toContain('"100.99.1.2:4123:4123"');
    expect(yml).not.toContain("100.83.12.47");
  });

  it("survives a SHIPIT_HOME containing spaces", () => {
    // Not hypothetical: SHIPIT_HOME defaults to $HOME/.shipit, and macOS home
    // directories are routinely "/Users/First Last". A naive $(...) split here
    // would shred the path into separate argv entries and hand docker compose a
    // -f that doesn't exist.
    const spaced = path.join(root, "My Home Dir");
    fs.mkdirSync(spaced, { recursive: true });
    fs.writeFileSync(path.join(spaced, ".shipit.env"), "SHIPIT_TAILNET_BIND=1\n");
    stubTailscale("100.83.12.47");

    const out = execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
         SHIPIT_HOME=${JSON.stringify(spaced)}
         . ${JSON.stringify(LIB_SH)}
         shipit_load_env_file
         shipit_refresh_tailnet_bind
         files=()
         while IFS= read -r a; do files+=("$a"); done < <(shipit_compose_files)
         printf '%s\\n' "\${#files[@]}"`,
      ],
      { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, HOME: spaced } },
    ).toString();

    // Exactly 4: -f, base, -f, overlay — not 6 from a split on the space.
    expect(out.trim()).toBe("4");
  });

  it("drops a stale overlay when the user opts back out", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");
    stubTailscale("100.83.12.47");
    refresh({ withTailscale: true });
    expect(fs.existsSync(overlay)).toBe(true);

    // Opt out — an empty env file, as if the line were deleted by hand.
    fs.writeFileSync(envFile, "");
    refresh({ withTailscale: true });

    // A leftover overlay would keep binding the tailnet IP after opt-out, and
    // would fail the container outright once that address stopped existing.
    expect(fs.existsSync(overlay)).toBe(false);
  });
});

describe("docker/local/prod/compose.yml — default bind address (docs/254 req 2)", () => {
  it("defaults to loopback, so a laptop on untrusted wifi exposes nothing", () => {
    const yml = fs.readFileSync(COMPOSE_YML, "utf8");
    const ports = yml
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- "${SHIPIT_BIND_ADDR'));

    // Every published port is bound through the variable...
    expect(ports.length).toBeGreaterThan(0);
    // ...and every one of them defaults to loopback. ShipIt has no built-in
    // auth, so a bare "4123:4123" here (0.0.0.0) is a security regression.
    for (const line of ports) {
      expect(line).toMatch(/\$\{SHIPIT_BIND_ADDR:-127\.0\.0\.1\}/);
    }
    expect(yml).not.toMatch(/^\s*- "\d+:\d+"\s*$/m);
  });
});
