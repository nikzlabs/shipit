/**
 * **A `shipit.yaml` fixture that does not parse must fail the test that wrote
 * it, not silently disable the check under test.** (planning#480.)
 *
 * ## The failure class
 *
 * `resolveShipitConfig` THROWS a `ShipitConfigError` on an invalid config — an
 * `agent.install` entry that is not a string, a bad `release.mechanism`, a
 * malformed `compose`. Every production caller that reads it opportunistically
 * wraps that in a try/catch and returns a conservative empty result:
 * `classifyEmptyDepDirs` (`session/overlay-dep-check.ts`), `staleDepDirs`
 * (`session/dep-tree-staleness.ts`), `computeDepsHash` and
 * `warnOnSkippedInstallOutput` (`session/install-controller.ts`). That is
 * deliberate and load-bearing — an unreadable declaration must never fail a
 * user's install — and it is exactly what makes a malformed FIXTURE invisible.
 *
 * A test whose fixture does not parse takes the conservative branch, the check
 * under test evaluates nothing, and the assertion passes. It reads as a green
 * regression guard and is not one.
 *
 * This is not hypothetical. Three tests in
 * `session/install-controller-dep-dir-outcome.test.ts` were written with
 *
 *     agent:
 *       install:
 *         - true
 *
 * where YAML parses the unquoted `true` as a **boolean**, `parseInstallList`
 * rejects it, and the dep-dir checks were never reached. "Succeeds when a
 * declared dep dir is ABSENT", "succeeds when the tree matches the lockfile" and
 * "succeeds for a legitimately PARTIAL dep dir" all asserted a success nothing
 * had computed. It surfaced only because planning#480 needed one of them to
 * discriminate a case it could not see.
 *
 * ## Why a write hook and not a helper
 *
 * Per-file discipline cannot close this — the same argument `server-test-setup.ts`
 * makes for the git-config and credential strips. A `writeShipitConfig()` helper
 * would guard the fixtures that adopt it and nothing else, and the next fixture
 * is written by whoever did not know the helper exists. Hooking the write also
 * catches fixtures built by interpolation
 * (`` `agent:\n  install:\n    - ${cmd}\n` ``), which no source-level scan can
 * evaluate.
 *
 * Scope is deliberately tiny: only a write whose basename is `shipit.yaml`, only
 * in the server test project, and the validation is the SAME parse the product
 * runs. Nothing about production behaviour changes — this module is imported by
 * the test setup only.
 *
 * **What it does not cover.** It replaces the function on the `node:fs` /
 * `node:fs/promises` default exports, so a test reaching a write through some
 * OTHER binding is not intercepted: `import { writeFileSync } from "node:fs"`
 * and `import * as fs from "node:fs"` capture the original at module
 * instantiation, and a test that stubs `fs` itself replaces the wrapper. Every
 * fixture in the suite today uses the default-import form, so the coverage is
 * complete in practice — but this is a strong default, not an airtight
 * invariant, and it is not worth making airtight: the cost of a miss is one
 * fixture that silently checks nothing, which is the status quo everywhere this
 * guard does not reach.
 *
 * ## Opting out
 *
 * A test that writes an invalid config ON PURPOSE — `shipit-config.test.ts`
 * asserting that `resolveShipitConfig` propagates a `ShipitConfigError`, or any
 * test covering the conservative catch itself — wraps the write in
 * {@link expectInvalidShipitConfig}. That makes the intent explicit at the call
 * site, which is the point: an invalid fixture is fine when a test says it means
 * it, and a bug when it does not.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseShipitConfig } from "./shipit-config.js";

/** Nesting depth of {@link expectInvalidShipitConfig}; >0 disables the check. */
let invalidExpected = 0;

/**
 * Run `fn` with the fixture check suspended, for a test that writes an
 * intentionally-invalid `shipit.yaml`. Counted and restored in a `finally`, so a
 * throwing `fn` (the usual case — that is what such a test asserts) cannot leave
 * the guard off for the rest of the file.
 */
export function expectInvalidShipitConfig<T>(fn: () => T): T {
  invalidExpected += 1;
  try {
    return fn();
  } finally {
    invalidExpected -= 1;
  }
}

/**
 * Validate one fixture's text the way the product does. Returns the rejection
 * message, or `null` when the config is fine (including the empty file, which
 * `resolveShipitConfig` accepts as "all defaults").
 */
function rejectionReason(text: string): string | null {
  try {
    parseShipitConfig(parseYaml(text));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function checkFixture(file: string, data: unknown): void {
  if (invalidExpected > 0) return;
  if (path.basename(file) !== "shipit.yaml") return;

  let text: string;
  if (typeof data === "string") text = data;
  else if (data instanceof Uint8Array) text = Buffer.from(data).toString("utf8");
  else return; // A stream/iterable fixture is not a shape any test writes.

  // An empty fixture needs no special case: `parseShipitConfig(parseYaml(""))`
  // returns defaults, exactly as `resolveShipitConfig` does for an empty file.
  const reason = rejectionReason(text);
  if (reason === null) return;

  throw new Error(
    `Invalid shipit.yaml fixture written to ${file}: ${reason}\n` +
      `A fixture the config parser rejects makes every opportunistic reader ` +
      `(classifyEmptyDepDirs, staleDepDirs, computeDepsHash, ...) take its ` +
      `"config unreadable -> check nothing" branch, so the test passes without ` +
      `evaluating what it claims to. Fix the fixture — a bare YAML "true" is a ` +
      `BOOLEAN, so an install command needs quoting: - "true". If the invalid ` +
      `config is the point of the test, wrap the write in ` +
      `expectInvalidShipitConfig(() => ...).\n` +
      `Fixture:\n${text}`,
  );
}

/**
 * Install the fixture check over `fs.writeFileSync` and `fsp.writeFile`, the two
 * paths tests actually use. Idempotent, so a re-imported setup file cannot stack
 * wrappers.
 */
export function installShipitConfigFixtureGuard(): void {
  const fsWithFlag = fs as unknown as { __shipitFixtureGuard?: true };
  if (fsWithFlag.__shipitFixtureGuard) return;
  fsWithFlag.__shipitFixtureGuard = true;

  const writeFileSync = fs.writeFileSync.bind(fs);
  fs.writeFileSync = (file: unknown, data: unknown, options?: unknown) => {
    if (typeof file === "string") checkFixture(file, data);
    (writeFileSync as (...a: unknown[]) => void)(file, data, options);
  };

  // `async` deliberately: a promise-returning API must REJECT rather than throw
  // synchronously, or `await`-less callers and `.rejects` assertions see a
  // different failure shape than the real `fsp.writeFile` would ever produce.
  const writeFile = fsp.writeFile.bind(fsp);
  fsp.writeFile = (async (file: unknown, data: unknown, options?: unknown) => {
    if (typeof file === "string") checkFixture(file, data);
    await (writeFile as (...a: unknown[]) => Promise<void>)(file, data, options);
  }) as typeof fsp.writeFile;
}
