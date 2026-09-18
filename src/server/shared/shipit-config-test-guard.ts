import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseShipitConfig } from "./shipit-config.js";

let invalidExpected = 0;

export function expectInvalidShipitConfig<T>(fn: () => T): T {
  invalidExpected += 1;
  try {
    return fn();
  } finally {
    invalidExpected -= 1;
  }
}

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
  else return;

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

/** Wrap default exports only; named imports and mocks can bypass this test guard. */
export function installShipitConfigFixtureGuard(): void {
  const fsWithFlag = fs as unknown as { __shipitFixtureGuard?: true };
  if (fsWithFlag.__shipitFixtureGuard) return;
  fsWithFlag.__shipitFixtureGuard = true;

  const writeFileSync = fs.writeFileSync.bind(fs);
  fs.writeFileSync = (file: unknown, data: unknown, options?: unknown) => {
    if (typeof file === "string") checkFixture(file, data);
    (writeFileSync as (...a: unknown[]) => void)(file, data, options);
  };

  // Keep validation failures asynchronous, like fsp.writeFile failures.
  const writeFile = fsp.writeFile.bind(fsp);
  fsp.writeFile = (async (file: unknown, data: unknown, options?: unknown) => {
    if (typeof file === "string") checkFixture(file, data);
    await (writeFile as (...a: unknown[]) => Promise<void>)(file, data, options);
  }) as typeof fsp.writeFile;
}
