/**
 * `shipit-git-credential` — a brokering git credential helper.
 *
 * Installed at /usr/local/bin/shipit-git-credential in the session worker image
 * and wired into the *container's* gitconfig as
 *
 *   [credential]
 *     helper = /usr/local/bin/shipit-git-credential
 *
 * (see `writeContainerGitConfig` in src/server/orchestrator/git-config.ts).
 *
 * Why this exists (docs/088-security-audit, finding #5):
 * The orchestrator's own global gitconfig embeds the GitHub PAT inline as a
 * shell one-liner credential helper. Historically that exact file was copied
 * into every session's `/credentials/.gitconfig`, so a prompt-injected agent
 * could `cat /credentials/.gitconfig` (or `git credential fill`) and read the
 * token directly — the precise failure Anthropic's managed-agents writeup warns
 * about. This helper closes that hole the same way the `gh` shim closes the
 * GitHub *API* surface: the token is brokered, never resident in the sandbox.
 *
 * How it works:
 * - Git invokes the helper as `shipit-git-credential <get|store|erase>` with the
 *   request attributes (protocol, host, path, …) on stdin, blank-line terminated.
 * - On `get`, the helper POSTs the host/protocol to the worker's
 *   `/agent-ops/git/credential` route (localhost). The worker brokers to the
 *   orchestrator, which returns the token for github.com only. The helper
 *   writes `username=`/`password=` back to git on stdout. The token thus exists
 *   only transiently in this process's memory + git's — never on disk, never in
 *   env, never in the gitconfig.
 * - `store`/`erase` are no-ops: the orchestrator owns the credential, so there
 *   is nothing for the sandbox to cache or forget. (Returning success keeps git
 *   from warning.)
 *
 * If the worker is unreachable or no credential is available for the host, the
 * helper prints nothing and exits 0 — git then falls back to its other helpers
 * or anonymous access, exactly as with a normal helper that has no answer.
 */

// ---------------------------------------------------------------------------
// IO abstraction so tests can drive the helper without spawning a process
// ---------------------------------------------------------------------------

export interface CredIO {
  /** Resolve the full stdin contents git wrote (the credential description). */
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
}

const defaultIO: CredIO = {
  readStdin: () =>
    new Promise<string>((resolve) => {
      let data = "";
      const stdin = process.stdin;
      if (stdin.isTTY) {
        resolve("");
        return;
      }
      stdin.setEncoding("utf-8");
      stdin.on("data", (chunk: Buffer | string) => {
        data += chunk.toString();
      });
      stdin.on("end", () => resolve(data));
      stdin.on("error", () => resolve(data));
    }),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
};

export interface CredEnv {
  /** Worker URL. Defaults to http://127.0.0.1:${WORKER_PORT|9100}. */
  workerUrl?: string;
}

function workerBaseUrl(env: CredEnv = {}): string {
  if (env.workerUrl) return env.workerUrl.replace(/\/$/, "");
  const fromEnv = process.env.SHIPIT_AGENT_OPS_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = process.env.WORKER_PORT || "9100";
  return `http://127.0.0.1:${port}`;
}

/**
 * Parse git's credential description (key=value lines, blank-line terminated)
 * into a plain object. Unknown keys are preserved but unused.
 */
export function parseCredentialInput(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of input.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") break; // blank line terminates the request
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** POST the host/protocol to the worker broker. Network/parse errors → null. */
async function fetchCredential(
  attrs: Record<string, string>,
  env: CredEnv,
  fetchImpl: typeof fetch,
): Promise<{ username: string; password: string } | null> {
  const url = `${workerBaseUrl(env)}/agent-ops/git/credential`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: attrs.host, protocol: attrs.protocol }),
    });
  } catch {
    return null;
  }
  if (res.status < 200 || res.status >= 300) return null;
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return null;
  }
  return { username: body.username, password: body.password };
}

export interface RunCredDeps {
  io?: CredIO;
  env?: CredEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Helper entry point. `argv` is the args after the binary name (git passes a
 * single operation: get/store/erase). Tests call this directly with stubs.
 */
export async function runGitCredential(argv: string[], deps: RunCredDeps = {}): Promise<void> {
  const io = deps.io ?? defaultIO;
  const env = deps.env ?? {};
  const fetchImpl = deps.fetchImpl ?? fetch;

  const op = argv[0];

  // store/erase: the orchestrator owns the credential — nothing to persist or
  // forget in the sandbox. Drain stdin (git writes to it) and exit cleanly.
  if (op !== "get") {
    await io.readStdin();
    io.exit(0);
    return;
  }

  const input = await io.readStdin();
  const attrs = parseCredentialInput(input);
  const cred = await fetchCredential(attrs, env, fetchImpl);

  // No answer → print nothing. Git falls back to its other helpers / anonymous
  // access. This is the same contract as any helper that doesn't recognize the
  // request, so a missing token or unreachable worker never hard-fails git.
  if (!cred) {
    io.exit(0);
    return;
  }

  io.stdout(`username=${cred.username}\n`);
  io.stdout(`password=${cred.password}\n`);
  io.exit(0);
}

// ---------------------------------------------------------------------------
// Standalone entry — only when run as a script, not when imported by tests
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runGitCredential(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(
      `shipit-git-credential: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    // Exit 0 even on error: a failing credential helper must not block git.
    process.exit(0);
  });
}
