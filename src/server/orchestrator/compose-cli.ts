/**
 * ComposeCli — `docker compose` command construction + execution for a session.
 *
 * Extracted from {@link ServiceManager} (docs/201 Phase P8). The manager still
 * owns the start/stop/reconcile state machine, the install gate, log streaming,
 * and collaborator wiring; this class owns the narrow concern of *talking to the
 * compose CLI*:
 *
 *   - Building the common arg vector (`-f <file> -f override -p <project>`).
 *   - Running a command (resolve on exit 0 / reject otherwise) via the injected
 *     {@link ComposeRunner}, and querying stdout via the injected
 *     {@link ComposeQuery} (both overridable for tests).
 *   - `up`/`upService`/`stop`/`down` wrappers with the exact same flags.
 *   - Container-name conflict recovery on `up`.
 *   - Pre-start stale-container sweep (`killStaleContainers`).
 *
 * Behavior is preserved byte-for-byte from the previous inline implementation —
 * same flags, same `--volumes`/removeVolumes semantics, same single conflict
 * retry, same long-lived-sidecar exclusion in the stale sweep.
 */

import { spawn } from "node:child_process";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

/**
 * Receives a compose command's own output (stdout + stderr) as it arrives.
 *
 * This is how the image build / pull phase becomes visible. See
 * {@link ComposeRunner} and `ServiceManager.composeLogSink`.
 */
export interface ComposeOutputSink {
  (chunk: string): void;
  /**
   * Emit whatever the sink still holds — a trailing record the command never
   * terminated with a newline. Called once per PROCESS, not once per call:
   * the conflict-recovery retry is a second `docker` process, and a partial
   * line from the failed attempt must not be glued onto the retry's first.
   */
  flush?(): void;
}

/**
 * Runs a docker compose command. Resolves on exit 0, rejects otherwise.
 *
 * `onOutput`, when supplied, is called with each chunk of the command's output
 * as it is produced — NOT buffered until exit. `up` is the caller that needs
 * this: with `--build` it can run for minutes with nothing else to show for
 * itself, and until this existed that whole window was silent.
 */
export type ComposeRunner = (
  args: string[],
  cwd: string,
  onOutput?: ComposeOutputSink,
) => Promise<void>;

/** Runs a docker compose command and returns stdout. */
export type ComposeQuery = (args: string[], cwd: string) => Promise<string>;

export interface ComposeCliOptions {
  /** Session ID — drives the compose project name, labels, and network name. */
  sessionId: string;
  /** Absolute path to the workspace directory (compose cwd). */
  workspaceDir: string;
  /** Compose file path, relative to the workspace (e.g. "docker-compose.yml"). */
  composeFile: string;
  /**
   * docs/246 — absolute path to the generated compose override, which lives in
   * the session's state dir, never in `<clone>/.shipit/`. Required: there is no
   * safe default, and the in-clone one this replaced (planning#288) put a generated
   * file where the post-turn `git add -A` stages it into the user's repository.
   *
   * Passing an absolute path is safe: compose anchors the **project directory**
   * to the first `-f` (still the user's compose file, relative to cwd), so the
   * user's own relative build contexts and bind sources resolve exactly as
   * before, and the generated override contains only absolute paths anyway.
   */
  overrideFile: string;
  /**
   * docs/262 — this project declares NO compose file of its own, so the stack is
   * its plugins' services alone (req 5: wiring a plugin in costs one
   * declaration, not a declaration plus an empty compose file to hang it on).
   * The project file is then left off the argument vector entirely and the
   * generated override is the only source.
   *
   * Deliberately "absent", not "optional": keying it on whether a conventional
   * `docker-compose.yml` happens to EXIST would start a stack the project never
   * declared — ShipIt runs a compose file because `shipit.yaml` names it, and a
   * repository that adds a plugin has not asked for that to change (review
   * finding).
   */
  noProjectFile?: boolean;
  /** Optional override for running compose commands (useful for testing). */
  composeRunner?: ComposeRunner;
  /** Optional override for querying compose commands (useful for testing). */
  composeQuery?: ComposeQuery;
}

export class ComposeCli {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private composeFile: string;
  private readonly overrideFile: string;
  private noProjectFile: boolean;
  private readonly runner: ComposeRunner;
  /** Exposed so the poller / direct-spawn callers can run their own queries. */
  readonly query: ComposeQuery;

  constructor(opts: ComposeCliOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeFile = opts.composeFile;
    this.overrideFile = opts.overrideFile;
    this.noProjectFile = opts.noProjectFile ?? false;
    this.runner = opts.composeRunner ?? defaultComposeRunner;
    this.query = opts.composeQuery ?? defaultComposeQuery;
  }

  /**
   * Point subsequent commands at a different compose file. Used when the
   * session's `shipit.yaml` changes its `compose:` path mid-session (a git
   * sync/rebase can rewrite it) — see `ServiceManager.updateComposeConfig`.
   */
  setComposeFile(file: string, noProjectFile = false): void {
    this.composeFile = file;
    this.noProjectFile = noProjectFile;
  }

  /** Build common compose CLI args with the user file and override. */
  args(...extra: string[]): string[] {
    return [
      "compose",
      ...(this.noProjectFile ? [] : ["-f", this.composeFile]),
      "-f", this.overrideFile,
      "-p", `shipit-${this.sessionId.slice(0, 12)}`,
      ...extra,
    ];
  }

  /**
   * Run `docker compose up -d --build`, optionally for specific services only.
   *
   * `--build` matters for any service that declares a `build:` section (e.g.
   * the ShipIt-in-ShipIt dogfood `dev` service). Without it, `docker compose
   * up` only builds when the named image is *missing* — so a changed
   * `Dockerfile` or build context on a host that already has the cached image
   * is silently ignored, and the stale image runs forever. `--build` forces
   * Compose to re-evaluate the build every `up`; Docker's layer cache makes
   * the no-change case cheap (all cache hits). For services that only declare
   * `image:` (the common case — most user repos pull a prebuilt image), there
   * is nothing to build and `--build` is a harmless no-op.
   *
   * `onOutput` receives the command's own progress as it runs — the build /
   * pull output that otherwise reaches no one.
   */
  up(serviceNames?: string[], onOutput?: ComposeOutputSink): Promise<void> {
    return this.timedUp(
      serviceNames ?? [],
      onOutput,
      "up", "-d", "--build", "--remove-orphans", ...(serviceNames ?? []),
    );
  }

  /** Run `docker compose up -d --build` for a specific manual service. */
  upService(name: string, onOutput?: ComposeOutputSink): Promise<void> {
    return this.timedUp([name], onOutput, "up", "-d", "--build", name);
  }

  /**
   * Run an `up` and report how long each phase of it took.
   *
   * The phases come from the command's own progress output, which is the only
   * source that distinguishes them: `build` runs from the first build/pull line
   * to the first container line, `create` from there to exit. A stack whose
   * images are all present prints no build lines at all, and then only `total`
   * and `create` are reported — an absent number beats an invented one.
   */
  private async timedUp(
    serviceNames: string[],
    onOutput: ComposeOutputSink | undefined,
    ...subArgs: string[]
  ): Promise<void> {
    const start = Date.now();
    let buildAt: number | undefined;
    let createAt: number | undefined;
    // A chunk is an arbitrary slice of the stream, not a line — `" Contai"` and
    // `"ner … Creating\n"` arrive separately often enough to matter. Hold the
    // unterminated tail until the rest of it lands.
    let partial = "";
    const observe: ComposeOutputSink = Object.assign(
      (chunk: string) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          const phase = composeUpPhaseOf(line);
          if (phase === "build") buildAt ??= Date.now();
          else if (phase === "create") createAt ??= Date.now();
        }
        onOutput?.(chunk);
      },
      {
        flush: () => {
          // The process ended, so the held tail is a complete line after all.
          if (partial) {
            const phase = composeUpPhaseOf(partial);
            if (phase === "build") buildAt ??= Date.now();
            else if (phase === "create") createAt ??= Date.now();
            partial = "";
          }
          onOutput?.flush?.();
        },
      },
    );
    try {
      await this.upWithConflictRecovery(observe, ...subArgs);
    } finally {
      const end = Date.now();
      const parts = [`total=${end - start}ms`];
      if (buildAt !== undefined) parts.push(`build=${(createAt ?? end) - buildAt}ms`);
      if (createAt !== undefined) parts.push(`create=${end - createAt}ms`);
      console.log(
        `[timing] compose.up for ${this.sessionId} ` +
          `services=${serviceNames.join(",") || "all"} ${parts.join(" ")}`,
      );
    }
  }

  /** Run `docker compose stop <service>`. */
  stop(name: string): Promise<void> {
    return this.run(undefined, "stop", name);
  }

  /** Run `docker compose down --remove-orphans`, optionally dropping volumes. */
  down(opts: { removeVolumes: boolean }): Promise<void> {
    const args = ["down", "--remove-orphans"];
    if (opts.removeVolumes) args.push("--volumes");
    return this.run(undefined, ...args);
  }

  /**
   * Kill and remove any containers from a previous compose stack for this
   * session. Uses the `shipit-parent-session` label so no compose files needed.
   */
  async killStaleContainers(): Promise<void> {
    const stdout = await this.query(
      ["ps", "-aq", "--filter", `label=shipit-parent-session=${this.sessionId}`],
      this.workspaceDir,
    );
    let ids = stdout.split("\n").map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    // The Tier B resolver and Tier C SNI proxy (docs/172, planning#92) share the agent's
    // netns and are LONG-LIVED sidecars, not stale compose containers — they carry
    // shipit-parent-session only so destroy-time cleanup reaps them. Exclude them
    // from this pre-start sweep, or we'd SIGKILL them ~1s after the agent launches
    // and leave the session with no resolver / no HTTPS. Docker `--filter` has no
    // label negation, so subtract a query per keep-label and union the results.
    //
    // planning#224: the keep-list must be INCARNATION-aware. Both labels are keyed on
    // the session id, which is stable across container recreations — so a naive
    // label match also spares the sidecars of a PREVIOUS, dead agent container
    // (the session OOM'd and was recreated). Those share a torn-down namespace
    // and are pure garbage; sparing them is exactly the leak. Keep a sidecar only
    // while its netns parent is still running.
    const keep = new Set<string>();
    for (const label of [EGRESS_RESOLVER_LABEL, EGRESS_PROXY_LABEL]) {
      const out = await this.query(
        [
          "ps", "-aq",
          "--filter", `label=shipit-parent-session=${this.sessionId}`,
          "--filter", `label=${label}=${this.sessionId}`,
        ],
        this.workspaceDir,
      );
      for (const id of out.split("\n").map(s => s.trim()).filter(Boolean)) {
        if (await this.hasLiveNetnsParent(id)) keep.add(id);
      }
    }
    ids = ids.filter(id => !keep.has(id));
    if (ids.length === 0) return;
    console.log(`[compose:${this.sessionId}] Removing ${ids.length} stale container(s)`);
    await this.query(["rm", "-f", ...ids], this.workspaceDir);
    // Also remove the old network if it exists
    try {
      await this.query(
        ["network", "rm", `shipit-session-${this.sessionId}`],
        this.workspaceDir,
      );
    } catch {
      // Network may not exist or may be in use — that's fine
    }
  }

  /**
   * Is `id`'s netns parent (`HostConfig.NetworkMode: container:<parentId>`) still
   * a running container? — the incarnation test for {@link killStaleContainers}'s
   * egress-sidecar keep-list (planning#224).
   *
   * The agent container carries no `RestartPolicy`, so it never legitimately goes
   * running → stopped → running underneath a live sidecar: "parent not running"
   * always means "this sidecar's namespace is gone", never "wait a moment."
   *
   * Fails **safe toward keeping**. A false reap costs a running session its DNS
   * and HTTPS; a false keep costs one stale container that the boot janitor's
   * parent-liveness sweep (`egress-orphan-reaper.ts`) reaps anyway. So anything
   * we can't positively establish — an unreadable sidecar, a non-netns network
   * mode, a Docker daemon that won't answer — resolves to "keep". Only a
   * positive read that the parent is absent from the running set reaps.
   */
  private async hasLiveNetnsParent(id: string): Promise<boolean> {
    let parentId: string;
    try {
      const mode = (
        await this.query(["inspect", "-f", "{{.HostConfig.NetworkMode}}", id], this.workspaceDir)
      ).trim();
      if (!mode.startsWith("container:")) return true; // not netns-sharing → not ours to judge
      parentId = mode.slice("container:".length).trim();
      if (!parentId) return true;
    } catch {
      return true; // can't tell → keep (preserves the pre-planning#224 behavior)
    }
    try {
      // `ps --filter` rather than `inspect`, deliberately. `docker inspect` exits
      // NON-ZERO both when the container is gone AND when the daemon is merely
      // unhappy (500, timeout, socket error, permission denied) — the two are
      // indistinguishable from the catch, so treating a rejection as "parent
      // gone" would let a transient daemon blip reap a LIVE session's resolver
      // and proxy. `ps` exits 0 either way: it prints the id when the parent is
      // up and nothing when it isn't, so "not up" is a VALUE we read rather than
      // an exception we guess at, and a genuine daemon failure still surfaces as
      // a throw we can fail safe on.
      //
      // NO `--filter status=running`, deliberately. `docker ps` without `-a`
      // already lists exactly the containers whose namespace is alive — and that
      // set includes PAUSED ones (`Up (Paused)`), which `status=running` would
      // exclude. A paused parent still owns a perfectly good netns; reaping its
      // sidecars would leave the session with no DNS and no HTTPS on unpause. The
      // question here is "is this namespace alive?", not "is this process
      // scheduled?" — and bare `ps` is exactly that question.
      //
      // We pass the full 64-char id (Docker echoes back the id we launched the
      // sidecar with in `NetworkMode`), so `--filter id=` — which matches on
      // unique ID *prefix* — is an exact match in practice.
      const out = (
        await this.query(
          ["ps", "-q", "--no-trunc", "--filter", `id=${parentId}`],
          this.workspaceDir,
        )
      ).trim();
      return out.length > 0;
    } catch {
      return true; // daemon problem → don't know → keep
    }
  }

  /**
   * Run `docker compose up …` and, on a Docker container-name conflict
   * (a stale container with the predicted name exists but compose doesn't
   * adopt it — e.g., labels drifted across orchestrator versions, the prior
   * teardown was interrupted, or another `up` call raced and left a zombie),
   * force-remove the conflicting container by ID and retry once.
   *
   * Why this lives here, not in `killStaleContainers()`: the broad pre-start
   * label sweep was over-aggressive — it SIGKILLed healthy preview containers
   * on every config reconcile (see efa1ec150 / docs/127-restart-agent §"Out
   * of scope"). This handler is surgical: it only removes the *specific*
   * container Docker named in the conflict error, so working stacks aren't
   * disturbed. The conflicting container can't be useful anyway — its name
   * is blocking the create we're about to issue.
   */
  private async upWithConflictRecovery(
    onOutput: ComposeOutputSink | undefined,
    ...subArgs: string[]
  ): Promise<void> {
    try {
      await this.run(onOutput, ...subArgs);
    } catch (err) {
      const conflictId = extractConflictContainerId((err as Error).message);
      if (!conflictId) throw err;
      console.warn(
        `[compose:${this.sessionId}] Container-name conflict; removing ${conflictId.slice(0, 12)} and retrying`,
      );
      try {
        await this.query(["rm", "-f", conflictId], this.workspaceDir);
      } catch {
        // Removal failed — surface the original conflict error so the cause
        // is clear, rather than masking it with the removal failure.
        throw err;
      }
      await this.run(onOutput, ...subArgs);
    }
  }

  /** Run a docker compose command and resolve/reject based on exit code. */
  private async run(
    onOutput: ComposeOutputSink | undefined,
    ...subArgs: string[]
  ): Promise<void> {
    const args = this.args(...subArgs);
    try {
      await this.runner(args, this.workspaceDir, onOutput);
    } finally {
      // The process is over either way, so its last unterminated line is now
      // complete. In the `finally` so a FAILED attempt flushes too — see the
      // per-process note on `ComposeOutputSink.flush`.
      onOutput?.flush?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Spawn environment
// ---------------------------------------------------------------------------

/**
 * The only variables a `docker` / `docker compose` child inherits (planning#371).
 *
 * **Compose interpolates `${VAR}` in the compose file from the environment of
 * the process that runs it**, and that process is the ORCHESTRATOR — whose
 * environment holds its GitHub credentials, its provider keys, and everything
 * else a deployment sets. A `LEAK: ${GITHUB_TOKEN}` in a repository's own
 * compose file resolved against it and arrived inside a container. This is
 * exactly what `plugin-compose.ts` escapes every `$` in a plugin fragment to
 * prevent; the project file was the way around that escaping, and it is worth
 * closing on its own merits well beyond plugins — the file is repository content
 * either way, and no repository has a reason to read the orchestrator's env.
 *
 * Interpolation itself still works, from the sources Compose documents for it:
 * a `.env` file in the project directory, `env_file:`, and `environment:`. Only
 * the accidental inheritance is gone.
 *
 * **This alone does not put the orchestrator's environment out of reach, and
 * saying so would be the overstatement this area keeps shipping** (review
 * finding). A scrubbed `env` does not unmount `/proc`: the child runs as the
 * same uid as its parent, so `/proc/1/environ` — mode 0400, owned by the
 * orchestrator process — is readable to it. What closes that is the companion
 * rule in `compose-generator.ts`'s `validateTopLevelFileRefs`, which keeps a
 * repository's `secrets:` sources inside the workspace: a BUILD secret is the
 * one compose-file field that makes the CLI read an arbitrary path in ITS own
 * filesystem and hand the contents to a container. The two are one fix; neither
 * half is sufficient.
 *
 * **The list below is load-bearing in a second place** (planning#386): a
 * `secrets:`/`configs:` entry may say `environment: VAR` instead of `file:`,
 * which resolves against exactly this environment and mounts the result in a
 * container. That is allowed precisely because nothing here is sensitive — so
 * adding a name that is would open that path without any edit to the validator.
 *
 * The list is what the CLI needs to find the daemon and its own config, and
 * nothing else:
 *  - `PATH` — Node resolves the executable through the env it is handed, so
 *    omitting this makes the spawn fail with ENOENT rather than run unconfigured.
 *  - `HOME` / `DOCKER_CONFIG` — where the CLI reads `config.json` (registry
 *    auth for a `build:`/`image:` pull, buildx state).
 *  - `DOCKER_HOST` + the TLS/context vars — which daemon, and how to reach it.
 *  - `DOCKER_BUILDKIT` / `BUILDKIT_PROGRESS` / `COMPOSE_DOCKER_CLI_BUILD` —
 *    builder selection and output format, which deployments do set.
 *  - `TMPDIR` — buildx and compose write temporary files.
 *
 * Deliberately NOT forwarded: `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`,
 * `COMPOSE_PROFILES` and friends. ShipIt passes `-f` and `-p` explicitly, and a
 * deployment-level value for them would silently redefine which stack a session
 * is operating on.
 */
const COMPOSE_ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "DOCKER_BUILDKIT",
  "BUILDKIT_PROGRESS",
  "COMPOSE_DOCKER_CLI_BUILD",
] as const;

/**
 * Build the environment for a `docker` spawn — see {@link COMPOSE_ENV_PASSTHROUGH}.
 *
 * Exported because every `docker` invocation that names a compose FILE must use
 * it, not just the two in this module: `ServiceManager`'s log snapshot and log
 * follower spawn `docker compose … logs` with the same `-f <project file>`, so
 * Compose parses and interpolates that file for them too.
 */
export function composeSpawnEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMPOSE_ENV_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Default compose runner / query
// ---------------------------------------------------------------------------

/**
 * How much of a failed command's stderr survives into the rejection message.
 *
 * Unbounded before: a failing `up --build` can emit megabytes of build output,
 * and the whole string ends up in `ManagedService.error` — which is rendered in
 * the services drawer and returned by `shipit service list`. The TAIL is kept
 * because that is where the actual failure is; the preceding cache hits are
 * noise, and they now stream live anyway.
 */
const MAX_ERROR_STDERR = 8_000;

function defaultComposeRunner(
  args: string[],
  cwd: string,
  onOutput?: ComposeOutputSink,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: composeSpawnEnv(),
    });

    let stderr = "";
    // Both streams are drained unconditionally, sink or no sink. stdout used to
    // be piped and never read, so a command that wrote more than the pipe's
    // buffer (~64 KiB) would block on write and never reach `close` — the
    // promise would never settle. Compose keeps progress on stderr today, which
    // is the only reason that never fired.
    proc.stdout?.on("data", (chunk: Buffer) => {
      onOutput?.(chunk.toString());
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > MAX_ERROR_STDERR) stderr = stderr.slice(-MAX_ERROR_STDERR);
      onOutput?.(text);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker compose ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", reject);
  });
}

function defaultComposeQuery(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: composeSpawnEnv(),
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`docker ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the conflicting container ID out of a Docker compose-up error.
 *
 * The daemon's name-collision message looks like:
 *   `… The container name "/shipit-…-dev-1" is already in use by container
 *    "6f943f7b45f75e4b321b707752b26f460155c64e6625243b312da9a3acdb0631". …`
 *
 * Returns the 64-hex container ID when present, otherwise `undefined` so the
 * caller can rethrow the original error untouched.
 */
export function extractConflictContainerId(message: string): string | undefined {
  const m = /already in use by container "([0-9a-f]{12,64})"/.exec(message);
  return m?.[1];
}

/** Container/network/volume lines — compose has the image and is now making things. */
const COMPOSE_CREATE_LINE =
  /\b(?:Container|Network|Volume)\b.*\b(?:Creating|Created|Starting|Started|Recreating|Recreated|Running)\b/;

/**
 * Image lines. A PULL counts as `build`: both answer "how long until compose
 * had an image", which is the number an operator acts on, and a stack rarely
 * does both for the same service.
 */
const COMPOSE_BUILD_LINE =
  /(?:\bBuilding\b|\bBuilt\b|\bPulling\b|\bPulled\b|\bDownloading\b|\bExtracting\b|load build definition|exporting to image|naming to)/;

/** BuildKit's own step output — `#5 [builder 2/6] RUN …`, `=> CACHED …`. */
const BUILDKIT_STEP_LINE = /^\s*(?:#\d+\s|=>)/;

/**
 * Which phase of a `docker compose up` a progress line reports, or `null` when
 * it reports neither. Exported for the unit test — the classification is the
 * whole of the build/create split, and it is the part that can silently rot
 * when Docker changes its progress format.
 */
export function composeUpPhaseOf(line: string): "build" | "create" | null {
  if (COMPOSE_CREATE_LINE.test(line)) return "create";
  if (COMPOSE_BUILD_LINE.test(line) || BUILDKIT_STEP_LINE.test(line)) return "build";
  return null;
}
