/**
 * A credentials root for unit tests — never the live volume.
 *
 * `ContainerConfig.credentialsDir` and the service deps that carry the same
 * value are HOST paths (the container-side mount target is separately, and
 * correctly, the literal `/credentials`). Passing the literal host-side means
 * `createContainer` → `ensureSessionCredentialsScaffold` really creates
 * `/credentials/sessions/<fixture-id>/.gitconfig` — and inside a ShipIt session
 * container, which is where CLAUDE.md says the suite may be run, `/credentials`
 * is the running agent's own credentials directory. Six test files did it, and
 * a single suite run left a dozen fixture subtrees (`test-session-1`, `s1`,
 * `warm12345678`, …) sitting in it.
 *
 * Same family as #2432, which is the version of this that actually broke a
 * session: there the suite rewrote `/credentials/.gitconfig` and the session
 * could not push again. `app-di.ts`'s {@link resolveCredentialsDir} already
 * refuses the live volume for anything built through `buildApp()`; this covers
 * the tests that construct a config directly and never reach that guard.
 *
 * One directory for the whole worker: the fixtures use distinct session ids,
 * nothing asserts on the root itself, and a shared temp dir keeps the fix to a
 * one-line import per file. Removed at exit, best-effort.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_CREDENTIALS_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "shipit-test-credentials-dir-"),
);

process.on("exit", () => {
  try {
    fs.rmSync(TEST_CREDENTIALS_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort: a leftover temp dir is not worth failing a run over.
  }
});
