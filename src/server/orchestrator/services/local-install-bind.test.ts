import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

  function stubTailscale(ip: string | null): void {
    const script =
      ip === null
        ? "#!/bin/sh\nexit 1\n"
        : `#!/bin/sh\n[ "$1" = "ip" ] && echo "${ip}"\n`;
    const p = path.join(binDir, "tailscale");
    fs.writeFileSync(p, script);
    fs.chmodSync(p, 0o755);
  }

  function refresh(opts: { withTailscale: boolean }): { args: string; stderr: string } {
    const stderrFile = path.join(root, "stderr.txt");
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
    expect(yml).not.toContain("127.0.0.1");
    const parts = args.trim().split("\n");
    expect(parts.filter((p) => p === "-f")).toHaveLength(2);
    expect(parts[parts.length - 1]).toBe(overlay);
  });

  it("still starts, on loopback only, when Tailscale is not installed (req 5)", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");

    const { args, stderr } = refresh({ withTailscale: false });

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

    expect(out.trim()).toBe("4");
  });

  it("drops a stale overlay when the user opts back out", () => {
    fs.writeFileSync(envFile, "SHIPIT_TAILNET_BIND=1\n");
    stubTailscale("100.83.12.47");
    refresh({ withTailscale: true });
    expect(fs.existsSync(overlay)).toBe(true);

    fs.writeFileSync(envFile, "");
    refresh({ withTailscale: true });

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
    run('shipit_persist_env SHIPIT_HARNESSES "codex"');
    const out = run('shipit_load_env_file; printf "%s" "$SHIPIT_HARNESSES"');
    expect(out).toBe("codex");
    expect(fs.readFileSync(path.join(home, ".shipit.env"), "utf8")).toContain("SHIPIT_HARNESSES=codex");
  });

  it("replaces an earlier answer instead of appending a second line", () => {
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
    // Skip the stable-channel remote probe.
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
    fs.writeFileSync(path.join(home, ".shipit.env"), "SESSION_EGRESS_ENFORCE=0\n");
    fs.writeFileSync(path.join(home, "some-other-untracked.txt"), "x\n");

    const { ok } = sync();

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(home, ".shipit.env"))).toBe(true);
  });

  it("still refuses when tracked files are modified, which reset --hard WOULD discard", () => {
    fs.writeFileSync(path.join(home, "tracked.txt"), "local edit\n");

    const { ok, stderr } = sync();

    expect(ok).toBe(false);
    expect(stderr).toContain("uncommitted changes to tracked files");
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

    expect(ports.length).toBeGreaterThan(0);
    for (const line of ports) {
      expect(line).toMatch(/\$\{SHIPIT_BIND_ADDR:-127\.0\.0\.1\}/);
    }
    expect(yml).not.toMatch(/^\s*- "\d+:\d+"\s*$/m);
  });
});
