import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GLIBC_TUNABLES_ENV, GPU_GRAPHICS_GLIBC_TUNABLES } from "./gpu-graphics-env.js";

const LOADER = "/lib64/ld-linux-x86-64.so.2";
const [NAME, VALUE] = GPU_GRAPHICS_GLIBC_TUNABLES.split("=");
const NON_TEMPORAL = "glibc.cpu.x86_non_temporal_threshold";

/** What the loader reads for each tunable, or null where no x86-64 glibc of 2.33 or later can answer. */
function loaderReads(tunables?: string): Map<string, number> | null {
  let listed: string;
  try {
    listed = execFileSync(LOADER, ["--list-tunables"], {
      env: tunables === undefined ? {} : { [GLIBC_TUNABLES_ENV]: tunables },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const values = new Map<string, number>();
  for (const line of listed.split("\n")) {
    const match = /^(glibc\.[a-z0-9_.]+): (0x[0-9a-f]+|\d+) /.exec(line);
    if (match) values.set(match[1], Number(match[2]));
  }
  return values;
}

// The skip must not depend on the constant: a name that glibc does not know has to fail, not skip.
const defaults = loaderReads();
const loaderAnswers = defaults?.has(NON_TEMPORAL) ?? false;

describe("GPU_GRAPHICS_GLIBC_TUNABLES", () => {
  it("names one tunable, with a value above the copies that were slow (512 KiB)", () => {
    expect(GPU_GRAPHICS_GLIBC_TUNABLES).toMatch(/^glibc\.[a-z0-9_.]+=0x[0-9a-f]+$/);
    expect(Number(VALUE)).toBeGreaterThanOrEqual(512 * 1024);
  });

  // glibc ignores a name it does not know, so a wrong name would end the remedy with no message.
  it.skipIf(!loaderAnswers)("is read by this machine's glibc, and moves the default", () => {
    expect(defaults?.has(NAME)).toBe(true);
    expect(defaults?.get(NAME)).not.toBe(Number(VALUE));
    expect(loaderReads(GPU_GRAPHICS_GLIBC_TUNABLES)?.get(NAME)).toBe(Number(VALUE));
  });

  // `memcpy` gives `rep movsb` no copy at or above the non-temporal threshold.
  it.skipIf(!loaderAnswers)("leaves `rep movsb` no size on this machine", () => {
    expect(Number(VALUE)).toBeGreaterThanOrEqual(defaults?.get(NON_TEMPORAL) ?? Infinity);
  });
});
