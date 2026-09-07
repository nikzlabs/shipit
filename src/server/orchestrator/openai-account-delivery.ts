/** One-way account delivery for OpenCode. Only the source owns renewal. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureManagedOpenCodeData,
  openCodeAccessToken,
  writeOpenCodeAccount,
  removeOpenCodeAccount,
  managedOpenCodeDataHome,
  OPENCODE_ACCOUNT_MARKER,
} from "../shared/opencode-account.js";

const MARKER = OPENCODE_ACCOUNT_MARKER;
interface Binding {
  id: string;
  accountId: string;
  identity: string;
  dataHome: string;
}
interface SourceWatch {
  watcher: fs.FSWatcher;
  bindings: Map<string, Binding>;
}
const sources = new Map<string, SourceWatch>();

function currentBinding(binding: Binding): boolean {
  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(binding.dataHome, MARKER), "utf8"),
    ) as Binding;
    return record.id === binding.id;
  } catch {
    return false;
  }
}

function updateBinding(sourceRoot: string, binding: Binding): void {
  if (!currentBinding(binding)) return;
  const file = path.join(sourceRoot, ".codex", "auth.json");
  try {
    const auth: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    // Validate identity even if expiry has elapsed. A stale or torn source
    // during renewal must not delete a still-loaded consumer's auth record.
    const token = openCodeAccessToken(auth, 0);
    if (token.accountId !== binding.identity) {
      removeOpenCodeAccount(binding.dataHome);
      return;
    }
    if (token.expires > Date.now() && currentBinding(binding))
      {writeOpenCodeAccount(binding.dataHome, token);}
  } catch {
    if (!fs.existsSync(file) && currentBinding(binding))
      {removeOpenCodeAccount(binding.dataHome);}
  }
}

/** Subscribe to atomic source rewrites, not token writes from the consumer. */
export function provisionOpenCodeAccount(
  sourceRoot: string,
  home: string,
  accountId: string,
  xdgHome?: string,
): string {
  const token = openCodeAccessToken(
    JSON.parse(
      fs.readFileSync(path.join(sourceRoot, ".codex", "auth.json"), "utf8"),
    ),
  );
  const dataHome = xdgHome ?? ensureManagedOpenCodeData(home);
  fs.mkdirSync(dataHome, { recursive: true });
  const binding: Binding = {
    id: randomUUID(),
    accountId,
    identity: token.accountId,
    dataHome,
  };
  const marker = path.join(dataHome, MARKER);
  const temporary = `${marker}.${binding.id}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(binding), { mode: 0o600 });
    const owner = fs.statSync(dataHome);
    fs.chownSync(temporary, owner.uid, owner.gid);
    fs.renameSync(temporary, marker);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  writeOpenCodeAccount(dataHome, token);
  watchBinding(sourceRoot, binding);
  // Close the read-before-watch race against a concurrent source renewal.
  updateBinding(sourceRoot, binding);
  return dataHome;
}

function watchBinding(sourceRoot: string, binding: Binding): void {
  let source = sources.get(sourceRoot);
  if (!source) {
    const bindings = new Map<string, Binding>();
    const watcher = fs.watch(
      path.join(sourceRoot, ".codex"),
      { persistent: false },
      () => {
        for (const [dest, entry] of bindings) {
          if (!currentBinding(entry)) bindings.delete(dest);
          else {
            try {
              updateBinding(sourceRoot, entry);
            } catch {
              console.warn(
                "[openai-account-delivery] could not update a consumer",
              );
            }
          }
        }
        if (bindings.size === 0) {
          watcher.close();
          sources.delete(sourceRoot);
        }
      },
    );
    watcher.on("error", () => {
      for (const entry of bindings.values()) {
        try { if (currentBinding(entry)) removeOpenCodeAccount(entry.dataHome); }
        catch { console.warn("[openai-account-delivery] could not remove a consumer after watch failure"); }
      }
      watcher.close();
      sources.delete(sourceRoot);
    });
    source = { watcher, bindings };
    sources.set(sourceRoot, source);
  }
  source.bindings.set(binding.dataHome, binding);
}

/** Reattach a persisted consumer after orchestrator restart, before renewal. */
export function restoreOpenCodeAccount(
  home: string,
  sourceForAccount: (accountId: string) => string,
): void {
  const dataHome = managedOpenCodeDataHome(home);
  let binding: Binding;
  try {
    binding = JSON.parse(
      fs.readFileSync(path.join(dataHome, MARKER), "utf8"),
    ) as Binding;
  } catch {
    return;
  }
  if (
    binding.dataHome !== dataHome ||
    typeof binding.accountId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(binding.accountId)
  ) {
    revokeOpenCodeAccount(home);
    return;
  }
  const sourceRoot = sourceForAccount(binding.accountId);
  try {
    watchBinding(sourceRoot, binding);
    updateBinding(sourceRoot, binding);
  } catch {
    revokeOpenCodeAccount(home);
  }
}

/** Invalidate provenance first so a delayed source event cannot restore auth. */
export function revokeOpenCodeAccount(home: string, xdgHome?: string): void {
  const dataHome = xdgHome ?? managedOpenCodeDataHome(home);
  fs.rmSync(path.join(dataHome, MARKER), { force: true });
  removeOpenCodeAccount(dataHome);
  for (const [root, source] of sources) {
    source.bindings.delete(dataHome);
    if (!source.bindings.size) {
      source.watcher.close();
      sources.delete(root);
    }
  }
}

/** Revoke scoped consumers as well as primary session copies on sign-out. */
export function revokeOpenCodeSource(sourceRoot: string): void {
  const source = sources.get(sourceRoot);
  if (!source) return;
  for (const entry of [...source.bindings.values()]) {
    if (currentBinding(entry)) revokeOpenCodeAccount("", entry.dataHome);
  }
  source.watcher.close();
  sources.delete(sourceRoot);
}
