import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STALE_FIX_DAYS,
  evaluateReport,
  grypeScanArgs,
  pinnedImages,
  renderSummary,
  runScan,
  type GrypeReport,
  type ScanDeps,
} from "./check-image-vulns.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const NODE = "node:24-slim@sha256:" + "a".repeat(64);
const UV = "ghcr.io/astral-sh/uv:0.13.4@sha256:" + "b".repeat(64);
const GOLANG = "golang:1.27.2-alpine@sha256:" + "c".repeat(64);

function daysAgo(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Shaped like Grype 0.120.1's JSON: a perl-base match from a real debian:bookworm-slim scan.
function match(opts: {
  id?: string;
  severity?: string;
  state?: string;
  dates?: string[];
  path?: string;
}): GrypeReport["matches"][number] {
  return {
    vulnerability: {
      id: opts.id ?? "CVE-2026-8376",
      severity: opts.severity ?? "Critical",
      fix: {
        state: opts.state ?? "fixed",
        versions: ["5.36.0-7+deb12u4"],
        available: (opts.dates ?? [daysAgo(40)]).map((date) => ({
          version: "5.36.0-7+deb12u4",
          date,
          kind: "first-observed",
        })),
      },
    },
    artifact: {
      name: "perl-base",
      version: "5.36.0-7+deb12u3",
      type: "deb",
      locations: [{ path: opts.path ?? "/var/lib/dpkg/status" }],
    },
  };
}

describe("pinnedImages", () => {
  it("collects digest-pinned FROM and COPY --from refs, once per ref, with every file that uses it", () => {
    const images = pinnedImages([
      { path: "docker/Dockerfile.a", text: `FROM ${NODE} AS build\nRUN true\nFROM ${NODE}\nCOPY --from=${UV} /uv /usr/local/bin/\n` },
      { path: "docker/Dockerfile.b", text: `FROM --platform=linux/amd64 ${GOLANG} AS proxy-build\nFROM ${NODE}\n` },
    ]);
    expect(images).toEqual([
      { ref: UV, files: ["docker/Dockerfile.a"] },
      { ref: GOLANG, files: ["docker/Dockerfile.b"] },
      { ref: NODE, files: ["docker/Dockerfile.a", "docker/Dockerfile.b"] },
    ]);
  });

  it("reads an instruction that continues onto the next line", () => {
    const images = pinnedImages([
      { path: "docker/Dockerfile.d", text: `FROM \\\n  ${NODE} AS build\nCOPY \\\n  --from=${UV} \\\n  /uv /usr/local/bin/\n` },
    ]);
    expect(images.map((img) => img.ref)).toEqual([UV, NODE]);
  });

  it("skips refs that name no digest: build args, stage names and bare tags", () => {
    const images = pinnedImages([
      {
        path: "docker/Dockerfile.c",
        text: "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nFROM node:24-slim AS dev\nCOPY --from=build /app /app\n",
      },
    ]);
    expect(images).toEqual([]);
  });

  it("finds the repo's own Node base and uv pins, so a pin added to any Dockerfile is scanned", () => {
    const dockerfiles = readdirSync(join(REPO_ROOT, "docker"))
      .filter((name) => name.startsWith("Dockerfile."))
      .map((name) => ({ path: `docker/${name}`, text: readFileSync(join(REPO_ROOT, "docker", name), "utf8") }));
    const refs = pinnedImages(dockerfiles).map((img) => img.ref);
    expect(refs.some((ref) => ref.startsWith("node:24-slim@sha256:"))).toBe(true);
    expect(refs.some((ref) => ref.startsWith("ghcr.io/astral-sh/uv:"))).toBe(true);
    const digestLines = dockerfiles.flatMap((f) =>
      f.text.split("\n").filter((line) => /^\s*(FROM|COPY)\s.*@sha256:[0-9a-f]{64}/i.test(line)),
    );
    expect(digestLines.every((line) => refs.some((ref) => line.includes(ref)))).toBe(true);
  });
});

describe("evaluateReport", () => {
  it(`fails a HIGH/CRITICAL fix that is ${STALE_FIX_DAYS}+ days old and keeps a newer one as recent`, () => {
    const findings = evaluateReport(
      NODE,
      {
        matches: [
          match({ id: "CVE-old", dates: [daysAgo(STALE_FIX_DAYS)] }),
          match({ id: "CVE-new", severity: "High", dates: [daysAgo(STALE_FIX_DAYS - 1)] }),
        ],
      },
      NOW,
    );
    expect(findings.map((f) => [f.id, f.stale, f.ageDays])).toEqual([
      ["CVE-old", true, STALE_FIX_DAYS],
      ["CVE-new", false, STALE_FIX_DAYS - 1],
    ]);
  });

  it("dates a fix by its earliest available entry", () => {
    const [finding] = evaluateReport(NODE, { matches: [match({ dates: [daysAgo(3), daysAgo(45)] })] }, NOW);
    expect(finding.fixedSince).toBe(daysAgo(45));
    expect(finding.stale).toBe(true);
  });

  it("fails a fix with no usable date, because its age cannot be shown to be recent", () => {
    const findings = evaluateReport(NODE, { matches: [match({ dates: [] }), match({ dates: ["not-a-date"] })] }, NOW);
    expect(findings.map((f) => [f.fixedSince, f.stale])).toEqual([
      [undefined, true],
      [undefined, true],
    ]);
  });

  it("fails a finding when one of its fix versions has no date, even if another has a recent one", () => {
    const partly = match({ dates: [daysAgo(1)] });
    partly.vulnerability.fix.versions = ["1.1.0", "5.36.0-7+deb12u4"];
    const [finding] = evaluateReport(NODE, { matches: [partly] }, NOW);
    expect(finding.fixedSince).toBeUndefined();
    expect(finding.stale).toBe(true);
  });

  it("ignores lower severities, unfixed vulnerabilities and npm's bundled dependencies", () => {
    const findings = evaluateReport(
      NODE,
      {
        matches: [
          match({ severity: "Medium" }),
          match({ state: "not-fixed" }),
          match({ path: "/usr/local/lib/node_modules/npm/node_modules/tar/package.json" }),
        ],
      },
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("still reports a package that sits outside npm's bundled tree", () => {
    const findings = evaluateReport(NODE, { matches: [match({ path: "/usr/local/lib/node_modules/corepack/package.json" })] }, NOW);
    expect(findings).toHaveLength(1);
  });

  it("throws on a severity Grype does not use, so a changed report format cannot pass silently", () => {
    expect(() => evaluateReport(NODE, { matches: [match({ severity: "high" })] }, NOW)).toThrow(/unknown Grype severity/);
  });
});

describe("grypeScanArgs", () => {
  it("scans the pinned ref from the registry, for the deployed platform, as JSON", () => {
    expect(grypeScanArgs(NODE)).toEqual([`registry:${NODE}`, "--platform", "linux/amd64", "--only-fixed", "-o", "json"]);
  });
});

describe("runScan", () => {
  function deps(reports: Record<string, GrypeReport>, overrides: Partial<ScanDeps> = {}) {
    const calls: string[] = [];
    const summaries: string[] = [];
    const logs: string[] = [];
    const scanDeps: ScanDeps = {
      dockerfiles: [
        { path: "docker/Dockerfile.prod", text: `FROM ${NODE} AS build\nFROM ${NODE}\n` },
        { path: "docker/Dockerfile.egress-sidecar", text: `FROM ${GOLANG} AS proxy-build\n` },
      ],
      updateDb: () => calls.push("db update"),
      scanImage: (ref) => {
        calls.push(`scan ${ref}`);
        return reports[ref] ?? { matches: [] };
      },
      now: NOW,
      writeSummary: (markdown) => summaries.push(markdown),
      log: (line) => logs.push(line),
      ...overrides,
    };
    return { scanDeps, calls, summaries, logs };
  }

  it("updates the database once, then scans each pinned image once", () => {
    const { scanDeps, calls } = deps({});
    expect(runScan(scanDeps)).toBe(0);
    expect(calls).toEqual(["db update", `scan ${GOLANG}`, `scan ${NODE}`]);
  });

  it("exits 1 and names the image when a fix is stale", () => {
    const { scanDeps, summaries, logs } = deps({ [NODE]: { matches: [match({ dates: [daysAgo(40)] })] } });
    expect(runScan(scanDeps)).toBe(1);
    expect(logs).toEqual([expect.stringMatching(/^::error title=Stale image pin::node:24-slim@sha256:a+ \(docker\/Dockerfile\.prod\) has 1 /)]);
    expect(summaries.join("")).toContain("CVE-2026-8376");
  });

  it("exits 0 when every fix is recent, and still lists them", () => {
    const { scanDeps, summaries, logs } = deps({ [NODE]: { matches: [match({ dates: [daysAgo(2)] })] } });
    expect(runScan(scanDeps)).toBe(0);
    expect(logs).toEqual([]);
    expect(summaries.join("")).toMatch(/Recent fixes, not failing yet \(1\)/);
  });

  it("fails when the database update or a scan fails, instead of passing with no findings", () => {
    const updateFails = deps({}, { updateDb: () => { throw new Error("db update failed"); } });
    expect(() => runScan(updateFails.scanDeps)).toThrow("db update failed");
    const scanFails = deps({}, { scanImage: () => { throw new Error("registry unreachable"); } });
    expect(() => runScan(scanFails.scanDeps)).toThrow("registry unreachable");
  });

  it("fails when no Dockerfile pins an image, so a broken parser cannot scan nothing", () => {
    const { scanDeps } = deps({}, { dockerfiles: [{ path: "docker/Dockerfile.x", text: "FROM node:24-slim\n" }] });
    expect(() => runScan(scanDeps)).toThrow(/no digest-pinned images/);
  });
});

describe("renderSummary", () => {
  it("lists every scanned image and splits findings into failing and recent", () => {
    const images = [{ ref: NODE, files: ["docker/Dockerfile.prod"] }, { ref: UV, files: ["docker/Dockerfile.session-worker.prod"] }];
    const findings = evaluateReport(
      NODE,
      { matches: [match({ id: "CVE-old", dates: [daysAgo(40)] }), match({ id: "CVE-new", dates: [daysAgo(2)] })] },
      NOW,
    );
    const summary = renderSummary(images, findings);
    expect(summary).toContain(`| \`${NODE}\` | docker/Dockerfile.prod | 1 | 1 |`);
    expect(summary).toContain(`| \`${UV}\` | docker/Dockerfile.session-worker.prod | 0 | 0 |`);
    expect(summary).toMatch(/### Fails: fix available 30\+ days \(1\)[\s\S]*CVE-old/);
    expect(summary).toMatch(/### Recent fixes, not failing yet \(1\)[\s\S]*CVE-new/);
  });
});
