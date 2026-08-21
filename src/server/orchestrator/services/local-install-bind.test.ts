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

  it("finds the CLI inside the macOS app bundle, absent from PATH (req 4)", () => {
    // The bug this pins: the standalone macOS Tailscale app keeps its CLI at
    // /Applications/Tailscale.app/Contents/MacOS/Tailscale and never puts
    // `tailscale` on PATH, so the original `command -v tailscale` reported "not
    // installed" on a fully connected Mac — with no configuration that fixed it.
    // Verified broken on a real laptop, and the previous tests could not catch
    // it because they all stubbed the binary ONTO PATH, which is precisely the
    // assumption that doesn't hold there.
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");
    const bundleDir = path.join(root, "prefix", "Applications", "Tailscale.app", "Contents", "MacOS");
    fs.mkdirSync(bundleDir, { recursive: true });
    const bundleBin = path.join(bundleDir, "Tailscale");
    fs.writeFileSync(bundleBin, '#!/bin/sh\n[ "$1" = "ip" ] && echo 100.76.154.41\n');
    fs.chmodSync(bundleBin, 0o755);

    const stderrFile = path.join(root, "bundle-err.txt");
    const out = execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
         SHIPIT_HOME=${JSON.stringify(home)}
         . ${JSON.stringify(LIB_SH)}
         shipit_load_env_file
         shipit_refresh_tailnet_bind
         shipit_compose_files`,
      ],
      {
        // PATH deliberately WITHOUT any `tailscale`, as on a stock Mac.
        env: {
          ...process.env,
          HOME: home,
          SHIPIT_TAILSCALE_PREFIX: path.join(root, "prefix"),
        },
        stdio: ["pipe", "pipe", fs.openSync(stderrFile, "w")],
      },
    ).toString();

    expect(fs.existsSync(overlay)).toBe(true);
    expect(fs.readFileSync(overlay, "utf8")).toContain('"100.76.154.41:4123:4123"');
    expect(out.trim().split("\n").filter((p) => p === "-f")).toHaveLength(2);
  });

  it("honours SHIPIT_TAILSCALE_BIN for an install in a nonstandard place", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");
    const custom = path.join(root, "somewhere", "ts");
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    fs.writeFileSync(custom, '#!/bin/sh\n[ "$1" = "ip" ] && echo 100.5.5.5\n');
    fs.chmodSync(custom, 0o755);
    // A DIFFERENT tailscale is on PATH; the explicit override must win, so a user
    // pointing at the bundle isn't silently overridden by a stale shim on PATH.
    stubTailscale("100.99.99.99");

    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
         SHIPIT_HOME=${JSON.stringify(home)}
         . ${JSON.stringify(LIB_SH)}
         shipit_load_env_file
         shipit_refresh_tailnet_bind`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          HOME: home,
          SHIPIT_TAILSCALE_BIN: custom,
        },
      },
    );

    expect(fs.readFileSync(overlay, "utf8")).toContain('"100.5.5.5:4123:4123"');
  });

  it("still starts when the overlay cannot be written at all (req 5)", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");
    stubTailscale("100.83.12.47");
    // An unwritable parent directory, so `mktemp` cannot create the temp file.
    // Models the read-only-checkout / full-disk class of failure. The binding is
    // best-effort, so this must degrade to loopback, not abort the start.
    fs.chmodSync(home, 0o555);
    try {
      const { args, stderr } = refresh({ withTailscale: true });
      expect(args.trim().split("\n").filter((p) => p === "-f")).toHaveLength(1);
      expect(stderr).toContain("localhost only");
    } finally {
      fs.chmodSync(home, 0o755);
    }
  });

  it("warns rather than silently binding on when a stale overlay cannot be removed", () => {
    // Opted out, but the overlay can't be deleted. shipit_compose_files keys off
    // the file's existence, so staying silent would keep binding an address the
    // user opted out of — and fail the container outright once it stops existing.
    fs.writeFileSync(envFile, "");
    fs.writeFileSync(overlay, "services: {}\n");
    const dir = path.dirname(overlay);
    fs.chmodSync(dir, 0o555);
    try {
      const { stderr } = refresh({ withTailscale: false });
      expect(stderr).toContain("could not remove");
    } finally {
      fs.chmodSync(dir, 0o755);
    }
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

describe("deployment/local/lib.sh — shipit_persist_env (docs/276 req 3)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-persist-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Run a snippet with lib.sh sourced against a throwaway SHIPIT_HOME. */
  function run(snippet: string): string {
    return execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
         SHIPIT_HOME=${JSON.stringify(home)}
         . ${JSON.stringify(LIB_SH)}
         ${snippet}`,
      ],
      { env: { ...process.env, HOME: home }, encoding: "utf8" },
    );
  }

  it("writes the harness answer where every later build reads it", () => {
    // The whole point of persisting: `update.sh` never re-asks, so an answer that
    // did not land here would silently revert to the default set on the next
    // update — an install quietly growing back a harness the operator removed.
    run('shipit_persist_env SHIPIT_HARNESSES "codex"');
    const out = run('shipit_load_env_file; printf "%s" "$SHIPIT_HARNESSES"');
    expect(out).toBe("codex");
    expect(fs.readFileSync(path.join(home, ".shipit.env"), "utf8")).toContain("SHIPIT_HARNESSES=codex");
  });

  it("replaces an earlier answer instead of appending a second line", () => {
    // Two lines for one key is not a cosmetic problem: `. file` takes the LAST
    // one, so a re-run would look correct in the file and install the old set.
    run('shipit_persist_env SHIPIT_HARNESSES "codex"');
    run('shipit_persist_env SHIPIT_HARNESSES "claude,codex"');
    const lines = fs
      .readFileSync(path.join(home, ".shipit.env"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("SHIPIT_HARNESSES="));
    expect(lines).toEqual(["SHIPIT_HARNESSES=claude,codex"]);
  });

  it("leaves the other operator settings alone", () => {
    run("shipit_persist_env SESSION_EGRESS_ENFORCE 0");
    run('shipit_persist_env SHIPIT_HARNESSES "claude"');
    const body = fs.readFileSync(path.join(home, ".shipit.env"), "utf8");
    expect(body).toContain("SESSION_EGRESS_ENFORCE=0");
    expect(body).toContain("SHIPIT_HARNESSES=claude");
    // 0600: it sits in the checkout and now carries install-shaping answers.
    expect(fs.statSync(path.join(home, ".shipit.env")).mode & 0o777).toBe(0o600);
  });
});

describe("deployment/local/lib.sh — shipit_sync_checkout untracked files (docs/254-local-bind-and-tailnet-access req 9)", () => {
  let root: string;
  let home: string;
  let bare: string;

  const git = (args: string, cwd: string): string =>
    execFileSync("git", args.split(" "), {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    }).toString();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-sync-"));
    bare = path.join(root, "origin.git");
    home = path.join(root, "home");
    fs.mkdirSync(bare, { recursive: true });
    git("init --bare -b main .", bare);
    git(`clone ${bare} ${home}`, root);
    fs.writeFileSync(path.join(home, "tracked.txt"), "v1\n");
    git("add -A", home);
    git("commit -m first", home);
    git("push -u origin main", home);
    // `edge` resolves straight to origin/main, skipping the stable ls-remote probe.
    fs.writeFileSync(path.join(home, ".release-channel"), "edge\n");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function sync(): { ok: boolean; stderr: string } {
    const stderrFile = path.join(root, "err.txt");
    const script = `
      set -uo pipefail
      SHIPIT_HOME=${JSON.stringify(home)}
      . ${JSON.stringify(LIB_SH)}
      shipit_sync_checkout
    `;
    try {
      execFileSync("bash", ["-c", script], {
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", fs.openSync(stderrFile, "w")],
      });
      return { ok: true, stderr: fs.readFileSync(stderrFile, "utf8") };
    } catch {
      return { ok: false, stderr: fs.readFileSync(stderrFile, "utf8") };
    }
  }

  it("syncs despite untracked operator files, which reset --hard never touches", () => {
    // The bug this fixes: .shipit.env (written by the egress opt-out) is untracked
    // and lives in the checkout, so the old `git status --porcelain` check
    // refused forever — wedging the only supported update path.
    fs.writeFileSync(path.join(home, ".shipit.env"), "SESSION_EGRESS_ENFORCE=0\n");
    fs.writeFileSync(path.join(home, "some-other-untracked.txt"), "x\n");

    const { ok } = sync();

    expect(ok).toBe(true);
    // ...and the file is still there afterwards, which is why refusing on it was
    // never protecting anything.
    expect(fs.existsSync(path.join(home, ".shipit.env"))).toBe(true);
  });

  it("still refuses when tracked files are modified, which reset --hard WOULD discard", () => {
    fs.writeFileSync(path.join(home, "tracked.txt"), "local edit\n");

    const { ok, stderr } = sync();

    expect(ok).toBe(false);
    expect(stderr).toContain("uncommitted changes to tracked files");
    // The edit must survive the refusal — that is the whole point of the guard.
    expect(fs.readFileSync(path.join(home, "tracked.txt"), "utf8")).toBe("local edit\n");
  });
});

describe("docker/local/prod/compose.yml — default bind address (docs/254-local-bind-and-tailnet-access req 2)", () => {
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
