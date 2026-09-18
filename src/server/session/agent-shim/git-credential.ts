// Broker credentials through the worker without storing tokens on disk.

import { exitAfterFlush, shimWrite } from "./shim-exit.js";


export interface CredIO {
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
  stdout: (text) => shimWrite(process.stdout, text),
  stderr: (text) => shimWrite(process.stderr, text),
  exit: (code) => exitAfterFlush(code),
};

export interface CredEnv {
  workerUrl?: string;
}

function workerBaseUrl(env: CredEnv = {}): string {
  if (env.workerUrl) return env.workerUrl.replace(/\/$/, "");
  const fromEnv = process.env.SHIPIT_AGENT_OPS_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = process.env.WORKER_PORT || "9100";
  return `http://127.0.0.1:${port}`;
}

export function parseCredentialInput(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of input.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") break;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

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

export async function runGitCredential(argv: string[], deps: RunCredDeps = {}): Promise<void> {
  const io = deps.io ?? defaultIO;
  const env = deps.env ?? {};
  const fetchImpl = deps.fetchImpl ?? fetch;

  const op = argv[0];

  // The orchestrator owns storage; git still needs its input drained.
  if (op !== "get") {
    await io.readStdin();
    io.exit(0);
    return;
  }

  const input = await io.readStdin();
  const attrs = parseCredentialInput(input);
  const cred = await fetchCredential(attrs, env, fetchImpl);

  // Empty output lets git try other helpers or anonymous access.
  if (!cred) {
    io.exit(0);
    return;
  }

  io.stdout(`username=${cred.username}\n`);
  io.stdout(`password=${cred.password}\n`);
  io.exit(0);
}


if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runGitCredential(process.argv.slice(2)).catch((err: unknown) => {
    shimWrite(
      process.stderr,
      `shipit-git-credential: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exitAfterFlush(0);
  });
}
