import { describe, it, expect } from "vitest";
import type { TrackerDestination } from "./declared-tracker.js";
import { resolveDestinationByName, resolveIssueRef } from "./issue-ref-resolution.js";

/** The session's own repository — req 12's one unnamed destination. */
const OWN: TrackerDestination = { id: "github", kind: "github", key: "acme/app" };
const PLANNING: TrackerDestination = {
  id: "github:acme/planning",
  kind: "github",
  key: "acme/planning",
  name: "planning",
};
const ROADMAP: TrackerDestination = {
  id: "linear:SHI",
  kind: "linear",
  key: "SHI",
  name: "roadmap",
};

const ok = (r: ReturnType<typeof resolveIssueRef>) => {
  if (!r.ok) throw new Error(`expected a resolution, got ${r.reason}: ${r.message}`);
  return r.ref;
};

describe("resolveIssueRef — the three reference forms (req 10)", () => {
  it("resolves `name#<backend id>` on GitHub", () => {
    const ref = ok(resolveIssueRef("planning#123", [OWN, PLANNING]));
    expect(ref).toMatchObject({
      tracker: "github:acme/planning",
      trackerName: "planning",
      identifier: "planning#123",
      issueId: "123",
    });
  });

  it("resolves `name#<backend id>` on Linear", () => {
    const ref = ok(resolveIssueRef("roadmap#SHI-304", [OWN, ROADMAP]));
    expect(ref).toMatchObject({
      tracker: "linear:SHI",
      trackerName: "roadmap",
      identifier: "roadmap#SHI-304",
      issueId: "SHI-304",
    });
  });

  // req 5 — the declaration's team key is what completes a bare number into a
  // Linear key. That is the whole reason the key lives in the declaration.
  it("completes `name#<number>` on Linear from the declared team key", () => {
    const ref = ok(resolveIssueRef("roadmap#304", [OWN, ROADMAP]));
    expect(ref).toMatchObject({ tracker: "linear:SHI", issueId: "SHI-304", identifier: "roadmap#SHI-304" });
  });

  it("resolves a GitHub canonical address through the declaration that names it", () => {
    const ref = ok(resolveIssueRef("acme/planning#42", [OWN, PLANNING]));
    // req 15 — the resolved identifier is rendered in the NAME form, because
    // that is what ShipIt writes back into cards, branches and CLI output.
    expect(ref).toMatchObject({
      tracker: "github:acme/planning",
      trackerName: "planning",
      identifier: "planning#42",
      issueId: "42",
    });
  });

  it("resolves a GitHub issue URL the same way, keeping the URL", () => {
    const ref = ok(
      resolveIssueRef("https://github.com/acme/planning/issues/42", [OWN, PLANNING]),
    );
    expect(ref).toMatchObject({
      tracker: "github:acme/planning",
      identifier: "planning#42",
      url: "https://github.com/acme/planning/issues/42",
    });
  });

  it("resolves a bare Linear key through its team prefix", () => {
    const ref = ok(resolveIssueRef("SHI-304", [OWN, ROADMAP]));
    expect(ref).toMatchObject({ tracker: "linear:SHI", trackerName: "roadmap", issueId: "SHI-304" });
  });

  it("resolves a Linear issue URL through its team prefix", () => {
    const ref = ok(resolveIssueRef("https://linear.app/ws/issue/SHI-304/some-slug", [ROADMAP]));
    expect(ref).toMatchObject({ tracker: "linear:SHI", issueId: "SHI-304" });
  });

  it("matches a canonical GitHub address case-insensitively", () => {
    const ref = ok(resolveIssueRef("Acme/Planning#42", [OWN, PLANNING]));
    expect(ref.tracker).toBe("github:acme/planning");
  });
});

describe("resolveIssueRef — the session's own repository (req 12)", () => {
  it("resolves an address for the session's own repository with no declaration", () => {
    const ref = ok(resolveIssueRef("acme/app#7", [OWN]));
    expect(ref).toMatchObject({ tracker: "github", identifier: "acme/app#7", issueId: "7" });
    expect(ref.trackerName).toBeUndefined();
  });

  // A self-declaration wins over the unnamed fallback, so its references render
  // in the name form (req 15) and route through the declared destination.
  it("prefers a self-declaration over the unnamed own-repo fallback", () => {
    const selfDeclared: TrackerDestination = {
      id: "github:acme/app",
      kind: "github",
      key: "acme/app",
      name: "code",
    };
    const ref = ok(resolveIssueRef("acme/app#7", [OWN, selfDeclared]));
    expect(ref).toMatchObject({ tracker: "github:acme/app", trackerName: "code", identifier: "code#7" });
  });
});

describe("resolveIssueRef — fail closed (req 11)", () => {
  it("rejects a name nobody declared, naming what IS declared", () => {
    const result = resolveIssueRef("nope#5", [OWN, PLANNING, ROADMAP]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("undeclared");
    expect(result.message).toContain("planning");
    expect(result.message).toContain("roadmap");
  });

  // Recognizing an address is not the same as reaching it: req 1 leaves no
  // destination outside the declarations, so a well-formed address for an
  // undeclared repository has nowhere to go.
  it("rejects a canonical GitHub address for an undeclared repository", () => {
    const result = resolveIssueRef("someone-else/private-notes#9", [OWN, PLANNING]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("undeclared");
  });

  it("rejects a bare Linear key whose team nobody declared", () => {
    const result = resolveIssueRef("OPS-3", [OWN, ROADMAP]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("undeclared");
  });

  // Where more than one declaration matches, the reference fails rather than
  // resolving to one of them.
  it("rejects an address matching two declarations as ambiguous", () => {
    const alias: TrackerDestination = {
      id: "github:acme/planning",
      kind: "github",
      key: "acme/planning",
      name: "alias",
    };
    const result = resolveIssueRef("acme/planning#42", [OWN, PLANNING, alias]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
    expect(result.message).toContain("planning");
    expect(result.message).toContain("alias");
  });

  it("rejects a string that isn't a reference at all", () => {
    const result = resolveIssueRef("just some words", [OWN, PLANNING]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unrecognized");
  });

  it("rejects a bare `#42` — it names no destination", () => {
    expect(resolveIssueRef("#42", [OWN, PLANNING]).ok).toBe(false);
  });

  // Still fails closed, and is NOT the name-wins case below: a GitHub tracker's
  // issues are numbered, so `planning#5` names no issue there at all. There is nothing
  // to prefer the name *to*, which is the difference from a Linear team key.
  it("rejects a Linear-shaped suffix on a GitHub tracker", () => {
    const result = resolveIssueRef("planning#SHI-3", [OWN, PLANNING]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mismatched");
  });

  // req 16 — in a name form the NAME wins and an embedded backend id is
  // advisory. This is what lets `planning#306`, written before `roadmap` was
  // re-pointed to another team, keep resolving instead of failing on the stale
  // key. Deliberately an exception to reqs 11/17: nothing is guessed, one of two
  // stated things is preferred, and the name still identifies exactly one
  // declared destination.
  it("re-targets a key from another team to the name's current team", () => {
    const result = resolveIssueRef("roadmap#OPS-3", [OWN, ROADMAP]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref.issueId).toBe("SHI-3");
    expect(result.ref.identifier).toBe("roadmap#SHI-3");
  });

  it("resolves the same issue whether the name form carries the team key or not", () => {
    const keyed = resolveIssueRef("roadmap#SHI-304", [OWN, ROADMAP]);
    const bare = resolveIssueRef("roadmap#304", [OWN, ROADMAP]);
    expect(keyed.ok && bare.ok).toBe(true);
    if (!keyed.ok || !bare.ok) return;
    expect(keyed.ref.issueId).toBe(bare.ref.issueId);
  });

  it("declares nothing helpful when the repository declares nothing", () => {
    const result = resolveIssueRef("planning#5", [OWN]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("declares no issue trackers");
  });
});

describe("resolveIssueRef — resolution happens at use (req 16)", () => {
  // Nothing pins a reference to what it resolved to when written: the same
  // string routes wherever the name points *now*.
  it("re-targets an existing reference when the name is re-pointed", () => {
    const before = ok(resolveIssueRef("planning#42", [OWN, PLANNING]));
    expect(before.tracker).toBe("github:acme/planning");

    const repointed: TrackerDestination = {
      id: "github:acme/planning-v2",
      kind: "github",
      key: "acme/planning-v2",
      name: "planning",
    };
    const after = ok(resolveIssueRef("planning#42", [OWN, repointed]));
    expect(after.tracker).toBe("github:acme/planning-v2");
    expect(after.identifier).toBe("planning#42");
  });
});

describe("resolveDestinationByName", () => {
  it("matches case-insensitively", () => {
    const found = resolveDestinationByName([OWN, PLANNING], "PLANNING");
    expect(found.ok).toBe(true);
  });

  it("fails closed on an unknown name, listing the declared ones", () => {
    const found = resolveDestinationByName([OWN, PLANNING], "nope");
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.reason).toBe("undeclared");
    expect(found.message).toContain("planning");
  });

  it("fails closed rather than picking one when a name is declared twice", () => {
    const dup: TrackerDestination = { ...PLANNING, id: "github:acme/other", key: "acme/other" };
    const found = resolveDestinationByName([PLANNING, dup], "planning");
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.reason).toBe("ambiguous");
  });
});
