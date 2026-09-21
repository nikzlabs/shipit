import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PnpmIneligible } from "./pnpm-base-inputs.js";
import { scanTarballForBuildTriggers } from "./pnpm-install-scripts.js";

/**
 * Resolve, fetch and verify the tarballs the verified pnpm base is built from
 * (docs/276-shared-package-cache-integrity plan.md section 5, "Inputs and verification").
 *
 * Every package is resolved as `<name>@<version>` against the registry the ORCHESTRATOR
 * configures — never a URL the lockfile names — and admitted only when three digests agree:
 * the lockfile's `resolution.integrity`, the packument's `dist.integrity`, and the sha512 of
 * the bytes actually downloaded. A disagreement between the first two is the H1 shape.
 *
 * This is also where the ONE decision that sees package CONTENT is taken: which packages carry
 * an install-time build. The verified bytes here are the only place lockfile v9 leaves that
 * readable. The verdict NAMES those packages (planning#604) — the builder prunes them from the
 * published tree (`pnpm-base-prune.ts`) so the session's own install re-imports and builds them
 * as its own uid. A tarball the scan cannot read is still ineligible: one that cannot be shown
 * to have no build must not become one assumed to have none.
 */

export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

/**
 * Bounds one build's download, and with it the build's disk: everything the builder installs
 * is derived from these tarballs. A lockfile is repo-authored and can name any number of
 * dependencies, and Docker's own `StorageOpt` quota needs a storage driver ShipIt cannot
 * assume, so the bound is applied where the bytes enter.
 */
export const MAX_TOTAL_TARBALL_BYTES = 1024 * 1024 * 1024;
/** Each tarball is buffered whole in orchestrator memory, so it needs its own bound. */
export const MAX_TARBALL_BYTES = 512 * 1024 * 1024;
export const REGISTRY_REQUEST_TIMEOUT_MS = 60_000;

export interface VerifiedPackageRequest {
  key: string;
  name: string;
  version: string;
  integrity: string;
}

export interface BuildTriggerPackage {
  key: string;
  name: string;
  version: string;
  /** What the scan found, for the log line that explains why the base is missing a package. */
  trigger: string;
}

export interface StagedRegistry {
  /** Directory holding `tarballs/`, `index.json` and `tarballs.json`. */
  dir: string;
  packageCount: number;
  totalBytes: number;
  /** The prune set: packages the published base must not carry, in lockfile order. */
  buildTriggers: BuildTriggerPackage[];
}

export interface VerificationFailure {
  ok: false;
  /** The first package that failed, which is what the publish outcome reports. */
  failedPackage: string;
  detail: string;
}

/**
 * Not a failure: the candidate simply gets no base, and the repo takes the plain private
 * install it took before verified bases existed. Reported through the ineligible path so a
 * build-bearing repo never reads as a verification problem.
 */
export interface RegistryIneligible {
  ok: false;
  ineligible: PnpmIneligible;
}

export type StageRegistryResult =
  | ({ ok: true } & StagedRegistry)
  | VerificationFailure
  | RegistryIneligible;

export function sha512Integrity(bytes: Buffer): string {
  return `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
}

/** `@scope/name` -> `@scope%2fname`; the registry addresses a scoped package that way. */
function packumentPath(name: string): string {
  return name.replace("/", "%2f");
}

/** The conventional registry tarball path, which pnpm derives rather than reading a packument. */
export function conventionalTarballPath(name: string, version: string): string {
  return `/${name}/-/${name.split("/").pop() ?? name}-${version}.tgz`;
}

/**
 * Named by the digest, not by the package: two distinct packages can flatten to one readable
 * name (`@foo/bar@1.0.0` and `foo-bar@1.0.0` both give `foo-bar-1.0.0.tgz`), and the second
 * would overwrite the first while both routes kept serving it. A digest name cannot collide
 * without the bytes being identical, and cannot escape `tarballs/` whatever the package is
 * called.
 */
export function tarballFileName(integrity: string): string {
  return `${Buffer.from(integrity.slice(integrity.indexOf("-") + 1), "base64").toString("hex")}.tgz`;
}

/**
 * npm's own name and version grammar, narrowed. The lockfile is repo-authored and its keys
 * become both a URL path and a file name, so anything outside the grammar is refused rather
 * than escaped — a name npm could not have published is not a name worth fetching.
 */
const VALID_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VALID_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/;

export function isFetchableCoordinate(name: string, version: string): boolean {
  return VALID_NAME.test(name) && VALID_VERSION.test(version);
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

interface PackumentVersion {
  dist?: { integrity?: unknown; tarball?: unknown };
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function joinRegistry(registryUrl: string, suffix: string): string {
  return `${registryUrl.replace(/\/+$/, "")}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

/**
 * Fetch, verify and stage every package, plus the packument index the builder's loopback
 * registry serves. Stops at the first failure and names the package, per plan.md section 5's
 * "skips the publish naming the first failing package".
 */
export async function stageVerifiedRegistry(args: {
  packages: readonly VerifiedPackageRequest[];
  destDir: string;
  registryUrl?: string;
  /** Registry the BUILDER reaches the staged tarballs at; only its origin appears in the index. */
  builderRegistryUrl: string;
  /**
   * `@scope` -> registry, for the scopes the operator authorized. A scoped package resolves
   * against its own registry; every other package resolves against `registryUrl`. The map is
   * the orchestrator's, never the repo's — eligibility already refuses an `.npmrc` that
   * introduces one of its own.
   */
  authorizedScopeRegistries?: Record<string, string>;
  fetchImpl?: FetchLike;
  maxTotalBytes?: number;
  maxTarballBytes?: number;
}): Promise<StageRegistryResult> {
  const defaultRegistry = args.registryUrl ?? DEFAULT_REGISTRY_URL;
  const registryFor = (name: string): string =>
    (name.startsWith("@")
      ? args.authorizedScopeRegistries?.[name.slice(0, name.indexOf("/"))]
      : undefined) ?? defaultRegistry;
  const doFetch = args.fetchImpl ?? ((url, init) => fetch(url, init));
  const maxTotal = args.maxTotalBytes ?? MAX_TOTAL_TARBALL_BYTES;
  const maxTarball = args.maxTarballBytes ?? MAX_TARBALL_BYTES;

  const tarballDir = path.join(args.destDir, "tarballs");
  fs.mkdirSync(tarballDir, { recursive: true });

  const index: Record<string, unknown> = {};
  const routes: Record<string, string> = {};
  const packuments = new Map<string, Record<string, PackumentVersion>>();
  const buildTriggers: BuildTriggerPackage[] = [];
  let totalBytes = 0;

  for (const pkg of args.packages) {
    if (!isFetchableCoordinate(pkg.name, pkg.version)) {
      return {
        ok: false,
        failedPackage: pkg.key,
        detail: `${pkg.key} is not a name and version the registry could have published`,
      };
    }
    const registryUrl = registryFor(pkg.name);
    let versions = packuments.get(pkg.name);
    if (!versions) {
      let body: unknown;
      try {
        body = await withTimeout(
          async (signal) => {
            const res = await doFetch(joinRegistry(registryUrl, packumentPath(pkg.name)), { signal });
            if (!res.ok) throw new Error(`registry answered ${res.status}`);
            return (await res.json()) as unknown;
          },
          REGISTRY_REQUEST_TIMEOUT_MS,
        );
      } catch (err) {
        return {
          ok: false,
          failedPackage: pkg.key,
          detail: `could not resolve ${pkg.name} against ${registryUrl}: ${message(err)}`,
        };
      }
      const raw = (body as { versions?: unknown }).versions;
      if (typeof raw !== "object" || raw === null) {
        return { ok: false, failedPackage: pkg.key, detail: `${pkg.name} has no versions map` };
      }
      versions = raw as Record<string, PackumentVersion>;
      packuments.set(pkg.name, versions);
    }

    const record = versions[pkg.version];
    if (!record) {
      return {
        ok: false,
        failedPackage: pkg.key,
        detail: `${registryUrl} has no record of version ${pkg.version}`,
      };
    }
    const published = record.dist?.integrity;
    if (typeof published !== "string") {
      return {
        ok: false,
        failedPackage: pkg.key,
        detail: `${registryUrl} publishes no dist.integrity for ${pkg.key}`,
      };
    }
    // The H1 shape: a lockfile that names a digest the registry never published.
    if (published !== pkg.integrity) {
      return {
        ok: false,
        failedPackage: pkg.key,
        detail: `the lockfile pins ${pkg.integrity} but ${registryUrl} publishes ${published}`,
      };
    }

    const tarballUrl =
      typeof record.dist?.tarball === "string" && /^https?:\/\//.test(record.dist.tarball)
        ? record.dist.tarball
        : joinRegistry(registryUrl, conventionalTarballPath(pkg.name, pkg.version));

    let bytes: Buffer;
    try {
      bytes = await withTimeout(
        async (signal) => {
          const res = await doFetch(tarballUrl, { signal });
          if (!res.ok) throw new Error(`tarball fetch answered ${res.status}`);
          const declared = Number(res.headers.get("content-length") ?? "0");
          if (declared > maxTarball) {
            throw new Error(`declares ${declared} bytes, past the ${maxTarball}-byte per-package cap`);
          }
          const body = Buffer.from(await res.arrayBuffer());
          if (body.length > maxTarball) {
            throw new Error(`is ${body.length} bytes, past the ${maxTarball}-byte per-package cap`);
          }
          return body;
        },
        REGISTRY_REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      return { ok: false, failedPackage: pkg.key, detail: `could not download: ${message(err)}` };
    }

    const actual = sha512Integrity(bytes);
    if (actual !== pkg.integrity) {
      return {
        ok: false,
        failedPackage: pkg.key,
        detail: `downloaded bytes hash to ${actual}, not the pinned ${pkg.integrity}`,
      };
    }

    // Read AFTER the three digests agree, so the scan runs over the bytes the registry
    // published rather than over whatever the download happened to return.
    const scan = await scanTarballForBuildTriggers(bytes);
    if (scan.kind === "requires-build") {
      // Still staged and still installed by the builder: the tree it produces is what every
      // retained package's links are generated against, and the prune happens afterwards over
      // the finished tree (`pnpm-base-prune.ts`).
      buildTriggers.push({
        key: pkg.key,
        name: pkg.name,
        version: pkg.version,
        trigger: scan.trigger,
      });
    }
    if (scan.kind === "unreadable") {
      return {
        ok: false,
        ineligible: {
          eligible: false,
          code: "unreadable-input",
          detail: `${pkg.key} could not be checked for an install-time build: ${scan.detail}`,
        },
      };
    }

    totalBytes += bytes.length;
    if (totalBytes > maxTotal) {
      return {
        ok: false,
        failedPackage: pkg.key,
        detail: `the staged set passed the ${maxTotal}-byte cap`,
      };
    }

    const file = tarballFileName(pkg.integrity);
    fs.writeFileSync(path.join(tarballDir, file), bytes);

    const route = conventionalTarballPath(pkg.name, pkg.version);
    routes[route] = file;
    const entry = (index[pkg.name] ??= {
      name: pkg.name,
      "dist-tags": {},
      versions: {} as Record<string, unknown>,
    }) as { versions: Record<string, unknown>; "dist-tags": Record<string, string> };
    entry.versions[pkg.version] = {
      name: pkg.name,
      version: pkg.version,
      dist: { tarball: joinRegistry(args.builderRegistryUrl, route), integrity: pkg.integrity },
    };
    // pnpm reads a tag only when resolving a range; a lockfile build never does. Keep one
    // anyway so the served packument is a well-formed document.
    entry["dist-tags"].latest = pkg.version;
  }

  fs.writeFileSync(path.join(args.destDir, "index.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(args.destDir, "tarballs.json"), JSON.stringify(routes));

  return {
    ok: true,
    dir: args.destDir,
    packageCount: args.packages.length,
    totalBytes,
    buildTriggers,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
