import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { PLUGIN_SKILL_MARKER, PLUGIN_SKILL_MARKER_ID } from "../../shared/plugin-skill-marker.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { planRelease, prepareRelease } from "./release-prepare.js";

const { agentCreatePrMock, findBranchPullRequestMock } = vi.hoisted(() => ({
  agentCreatePrMock: vi.fn(),
  findBranchPullRequestMock: vi.fn(),
}));

vi.mock("./github.js", () => ({
  agentCreatePr: agentCreatePrMock,
  findBranchPullRequest: findBranchPullRequestMock,
}));

interface GitOverrides {
  remoteBranches?: string[];
  commitsAhead?: number;
  diffFiles?: number;
  isClean?: boolean;
  stableVersion?: string | null;
  remoteNotes?: string | null;
  /** Whether the workflow the release ships reads `.release-notes/` (docs/309). */
  notesWorkflow?: boolean;
}

const NOTES_AWARE_WORKFLOW = "on:\n  push:\n    branches: [stable]\njobs:\n  publish:\n    steps:\n      - run: cat .release-notes/$TAG.md\n";
const LEGACY_WORKFLOW = "on:\n  push:\n    tags: ['v*']\njobs:\n  publish:\n    steps:\n      - run: gh release create --generate-notes\n";

function makeGit(over: GitOverrides = {}) {
  const calls = {
    countCommitsAhead: vi.fn(async () => over.commitsAhead ?? 0),
    diffStatTwoDot: vi.fn(async () => ({ insertions: 1, deletions: 0, files: over.diffFiles ?? 1 })),
    cherryPick: vi.fn(async () => ({ success: true })),
    merge: vi.fn(async () => ({ success: true })),
    mergeOverride: vi.fn(async () => {}),
    createBranchFrom: vi.fn(async () => {}),
    commitPaths: vi.fn(async (_paths: string[], _message: string): Promise<string | null> => "deadbeefcafe"),
    forcePush: vi.fn(async () => ""),
    push: vi.fn(async () => ""),
    fetch: vi.fn(async () => {}),
    isClean: vi.fn(async () => over.isClean ?? true),
    listRemoteBranches: vi.fn(async () => over.remoteBranches ?? ["main", "stable"]),
    getDefaultBranch: vi.fn(async () => "main"),
    listTags: vi.fn(async () => [] as string[]),
    tipCommitMessage: vi.fn(async () => null),
    createAndPushTag: vi.fn(async () => {}),
    getHeadHash: vi.fn(async () => "abc123def456"),
    // Three different reads land here — version lookup, notes recovery, and the
    // workflow probe. A fake answering them alike could not fail on reading the
    // wrong one.
    showFileAtRef: vi.fn(async (_ref: string, file: string) => {
      if (file.startsWith(".release-notes/")) return over.remoteNotes ?? null;
      if (file.endsWith("release.yml")) return over.notesWorkflow === false ? LEGACY_WORKFLOW : NOTES_AWARE_WORKFLOW;
      return over.stableVersion ? JSON.stringify({ name: "x", version: over.stableVersion }) : null;
    }),
  };
  return { git: calls as unknown as GitManager, calls };
}

const githubAuth = { authenticated: true } as unknown as GitHubAuthManager;

let dir: string;

beforeEach(() => {
  agentCreatePrMock.mockReset();
  findBranchPullRequestMock.mockReset();
  findBranchPullRequestMock.mockResolvedValue(null);
  agentCreatePrMock.mockResolvedValue({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "Release v0.2.1",
    baseBranch: "stable",
    headBranch: "release/0.2.1",
    insertions: 1,
    deletions: 1,
    alreadyExisted: false,
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.2.0" }, null, 2));
  // A release without notes is refused (docs/309 req 6), so every other case
  // needs one present to reach the behaviour it is about.
  fs.writeFileSync(path.join(dir, "RELEASE_NOTES.draft.md"), "## Notes\n");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("prepareRelease — content-free guard (docs/214)", () => {
  it("refuses a bare bump-only prepare (no --pick/--from brings no commits)", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable" }),
    ).rejects.toThrow(/no changes/i);
    expect(calls.commitPaths).not.toHaveBeenCalled();
    expect(calls.forcePush).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
  });

  it("names the fix (--from / --allow-empty) in the error", async () => {
    const { git } = makeGit({ commitsAhead: 0 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable" }),
    ).rejects.toThrow(/--from <branch>.*--allow-empty/s);
  });

  it("--from overrides with the incoming tree (no merge, conflict-proof) and opens the PR", async () => {
    const { git, calls } = makeGit({ diffFiles: 4 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      from: "main",
    });
    expect(res.kind).toBe("pr-opened");
    expect(calls.mergeOverride).toHaveBeenCalledWith("origin/main");
    expect(calls.merge).not.toHaveBeenCalled();
    expect(calls.diffStatTwoDot).toHaveBeenCalledWith("origin/stable");
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });

  it("--from whose tree equals stable (no real changes) is refused as content-free", async () => {
    const { git, calls } = makeGit({ diffFiles: 0 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" }),
    ).rejects.toThrow(/no changes/i);
    expect(calls.commitPaths).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
  });

  it("--pick succeeds when it brings new commits", async () => {
    const { git, calls } = makeGit({ commitsAhead: 1 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      pick: ["abc123"],
    });
    expect(res.kind).toBe("pr-opened");
    expect(calls.cherryPick).toHaveBeenCalledWith(["abc123"]);
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });

  it("--allow-empty permits a deliberate bump-only release", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      allowEmpty: true,
    });
    expect(res.kind).toBe("pr-opened");
    expect(calls.commitPaths).toHaveBeenCalled();
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });

  it("--bootstrap is exempt from the guard (first release ships the new branch)", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0, remoteBranches: ["main"] });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      bootstrap: true,
    });
    expect(res.kind).toBe("pr-opened");
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });
});

describe("prepareRelease — only an OPEN release PR may be reported", () => {
  type DeadReason = "merged-not-progressed" | "closed-not-progressed";
  type NotProgressed = "base-not-contained" | "no-new-work" | "base-unknown" | "fetch-failed";

  const deadPr = (alreadyExistedReason?: DeadReason, notProgressedBecause?: NotProgressed) => ({
    number: 12,
    url: "https://github.com/o/r/pull/12",
    title: "Release v0.2.0",
    baseBranch: "stable",
    headBranch: "release/0.2.1",
    insertions: 1,
    deletions: 1,
    alreadyExisted: true,
    ...(alreadyExistedReason ? { alreadyExistedReason } : {}),
    ...(notProgressedBecause ? { notProgressedBecause } : {}),
  });

  const prepareAgainstOtherBase = () =>
    prepareRelease(makeGit({ diffFiles: 4, remoteBranches: ["main", "stable", "stable-2"] }).git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable-2",
      from: "main",
    });

  async function refusalMessage(): Promise<string> {
    try {
      await prepareAgainstOtherBase();
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected prepareRelease to refuse, but it resolved");
  }

  it("forwards an updated OPEN PR as alreadyExisted", async () => {
    agentCreatePrMock.mockResolvedValue({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      title: "Release v0.2.1",
      baseBranch: "stable",
      headBranch: "release/0.2.1",
      insertions: 1,
      deletions: 1,
      alreadyExisted: true,
      alreadyExistedReason: "open",
    });
    const { git } = makeGit({ diffFiles: 4 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      from: "main",
    });
    expect(res).toMatchObject({ kind: "pr-opened", prNumber: 7, alreadyExisted: true });
  });

  it("refuses a MERGED PR instead of reporting it as an updated release", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "base-not-contained"));
    await expect(prepareAgainstOtherBase()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("says merged, names the PR and its base, and cannot be reopened", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "base-not-contained"));
    await expect(prepareAgainstOtherBase()).rejects.toThrow(
      /merged pull request \(#12 into "stable"\), which GitHub cannot reopen/,
    );
  });

  it("says a CLOSED PR is one ShipIt won't reuse, not one GitHub can't reopen", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("closed-not-progressed", "base-not-contained"));
    const message = await refusalMessage();
    expect(message).toMatch(/closed pull request \(#12 into "stable"\), which ShipIt won't reuse/);
    expect(message).not.toMatch(/GitHub cannot reopen/);
  });

  it("base-not-contained points at the release branch the dead PR targeted", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "base-not-contained"));
    await expect(prepareAgainstOtherBase()).rejects.toThrow(/--release-branch stable/);
  });

  it("no-new-work asks for content rather than a re-run against the same base", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "no-new-work"));
    const message = await refusalMessage();
    expect(message).toMatch(/identical to "stable".*--from <branch>/s);
    expect(message).not.toMatch(/--release-branch/);
  });

  it("base-unknown says the base is gone rather than telling the user to re-run against it", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "base-unknown"));
    const message = await refusalMessage();
    expect(message).toMatch(/"stable" is no longer on the remote/);
    expect(message).not.toMatch(/--release-branch/);
  });

  it("fetch-failed blames the connection, not the release, and asks for a re-run", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "fetch-failed"));
    const message = await refusalMessage();
    expect(message).toMatch(/could not refresh "stable"/);
    expect(message).toMatch(/re-run the same version/);
    expect(message).not.toMatch(/Release a different version/);
    expect(message).not.toMatch(/--release-branch/);
  });

  it("refuses an existing PR whose reason is absent", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr());
    await expect(prepareAgainstOtherBase()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not claim an absent reason is 'merged' — it says only that it is not open", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr());
    const message = await refusalMessage();
    expect(message).toMatch(/a pull request \(#12 into "stable"\) that is not open/);
    expect(message).not.toMatch(/merged/);
  });
});

describe("prepareRelease — the release PR must target the requested release branch", () => {
  const openPrInto = (baseBranch: string) => ({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "Release v0.2.1",
    baseBranch,
    headBranch: "release/0.2.1",
    insertions: 1,
    deletions: 1,
    alreadyExisted: true,
    alreadyExistedReason: "open",
  });

  const prepareInto = (releaseBranch: string) => {
    const { git, calls } = makeGit({ diffFiles: 4, remoteBranches: ["main", "stable", "stable-2"] });
    const promise = prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch, from: "main" });
    return { promise, calls };
  };

  async function messageFrom(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected prepareRelease to refuse, but it resolved");
  }

  it("refuses before touching the branch when the open PR targets another base", async () => {
    findBranchPullRequestMock.mockResolvedValue({ number: 7, base: "stable", state: "open", merged: false });
    const { promise, calls } = prepareInto("stable-2");
    await expect(promise).rejects.toMatchObject({ statusCode: 409 });
    expect(calls.createBranchFrom).not.toHaveBeenCalled();
    expect(calls.commitPaths).not.toHaveBeenCalled();
    expect(calls.forcePush).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
  });

  it("does not claim the bump was pushed when it refused before pushing", async () => {
    findBranchPullRequestMock.mockResolvedValue({ number: 7, base: "stable", state: "open", merged: false });
    const message = await messageFrom(prepareInto("stable-2").promise);
    expect(message).toMatch(/open pull request \(#7\) into "stable", but this release targets "stable-2"/);
    expect(message).toMatch(/wrong maintenance branch/);
    expect(message).toMatch(/--release-branch stable\b/);
    expect(message).not.toMatch(/already pushed/);
  });

  it("still refuses when the base changes after the preflight, and says the bump landed", async () => {
    findBranchPullRequestMock.mockResolvedValue(null);
    agentCreatePrMock.mockResolvedValue(openPrInto("stable"));
    const { promise, calls } = prepareInto("stable-2");
    const message = await messageFrom(promise);
    expect(calls.forcePush).toHaveBeenCalled();
    expect(message).toMatch(/already pushed to "release\/0\.2\.1".*checks are stale/s);
  });

  it("does not paste a shell-unsafe branch name into the suggested command", async () => {
    findBranchPullRequestMock.mockResolvedValue({
      number: 7,
      base: "stable;$(touch /tmp/pwned)",
      state: "open",
      merged: false,
    });
    const message = await messageFrom(prepareInto("stable-2").promise);
    expect(message).toMatch(/--release-branch <branch>/);
    expect(message).not.toMatch(/--release-branch stable;/);
    expect(message).toContain('into "stable;$(touch /tmp/pwned)"');
  });

  it("accepts an OPEN PR that does target the requested release branch", async () => {
    findBranchPullRequestMock.mockResolvedValue({ number: 7, base: "stable", state: "open", merged: false });
    agentCreatePrMock.mockResolvedValue(openPrInto("stable"));
    await expect(prepareInto("stable").promise).resolves.toMatchObject({
      kind: "pr-opened",
      prNumber: 7,
      releaseBranch: "stable",
      alreadyExisted: true,
    });
  });

  it("lets a newly opened PR through", async () => {
    agentCreatePrMock.mockResolvedValue({
      number: 9,
      url: "https://github.com/o/r/pull/9",
      title: "Release v0.2.1",
      baseBranch: "stable",
      headBranch: "release/0.2.1",
      insertions: 1,
      deletions: 1,
      alreadyExisted: false,
    });
    await expect(prepareInto("stable").promise).resolves.toMatchObject({
      kind: "pr-opened",
      prNumber: 9,
      alreadyExisted: false,
    });
  });
});

describe("prepareRelease — prerelease path is unaffected by the guard (docs/214)", () => {
  it("proposes an rc without --confirm and never consults the guard", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      prerelease: true,
    });
    expect(res.kind).toBe("prerelease-proposed");
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
    expect(calls.createAndPushTag).not.toHaveBeenCalled();
  });

  it("cuts the rc tag with --confirm (still no guard)", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      prerelease: true,
      confirm: true,
    });
    expect(res.kind).toBe("prerelease-tagged");
    expect(calls.createAndPushTag).toHaveBeenCalled();
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
  });
});

describe("release-branch version anchor (docs/214 bugfix)", () => {
  it("planRelease bumps from the release branch version, not the lagging working tree", async () => {
    const { git, calls } = makeGit({ stableVersion: "0.2.2" });
    const plan = await planRelease(git, {
      dir,
      bump: "patch",
      mechanism: "release-branch",
      releaseBranch: "stable",
    });
    expect(plan.currentVersion).toBe("0.2.2");
    expect(plan.version).toBe("0.2.3");
    expect(plan.tag).toBe("v0.2.3");
    expect(calls.fetch).toHaveBeenCalled();
    expect(calls.showFileAtRef).toHaveBeenCalledWith("origin/stable", "package.json");
  });

  it("prepareRelease --from main writes the anchored next version into the bump", async () => {
    const { git } = makeGit({ stableVersion: "0.2.2", diffFiles: 4 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      mechanism: "release-branch",
      releaseBranch: "stable",
      from: "main",
    });
    expect(res.kind).toBe("pr-opened");
    if (res.kind !== "pr-opened") return;
    expect(res.version).toBe("0.2.3");
    expect(res.tag).toBe("v0.2.3");
    const written = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string };
    expect(written.version).toBe("0.2.3");
  });

  it("falls back to the working tree when the release branch has no version file yet (bootstrap)", async () => {
    const { git } = makeGit({ diffFiles: 4 });
    const plan = await planRelease(git, {
      dir,
      bump: "patch",
      mechanism: "release-branch",
      releaseBranch: "stable",
    });
    expect(plan.currentVersion).toBe("0.2.0");
    expect(plan.version).toBe("0.2.1");
  });

  it("does NOT anchor for a non-release-branch mechanism (main is the release source)", async () => {
    const { git, calls } = makeGit({ stableVersion: "0.2.2" });
    const plan = await planRelease(git, {
      dir,
      bump: "patch",
      mechanism: "tag-triggered",
      releaseBranch: "stable",
    });
    expect(plan.currentVersion).toBe("0.2.0");
    expect(plan.version).toBe("0.2.1");
    expect(calls.showFileAtRef).not.toHaveBeenCalled();
  });

  it("anchors the rc core to the release branch too (prerelease)", async () => {
    const { git } = makeGit({ stableVersion: "0.2.2" });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      mechanism: "release-branch",
      releaseBranch: "stable",
      prerelease: true,
    });
    expect(res.kind).toBe("prerelease-proposed");
    if (res.kind !== "prerelease-proposed") return;
    expect(res.version).toBe("0.2.3-rc.1");
    expect(res.tag).toBe("v0.2.3-rc.1");
  });
});

describe("planRelease — missing-notes warning (docs/309 req 10)", () => {
  function writeWorkflow(body: string): void {
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "workflows", "release.yml"), body);
  }

  it("warns when the repo publishes authored notes and the draft is missing", async () => {
    writeWorkflow(NOTES_AWARE_WORKFLOW);
    fs.rmSync(path.join(dir, "RELEASE_NOTES.draft.md"));
    const { git } = makeGit();
    const plan = await planRelease(git, { dir, bump: "patch" });
    expect(plan.warning).toMatch(/RELEASE_NOTES\.draft\.md/);
    expect(plan.warning).toMatch(/v0\.2\.1/);
  });

  it("treats a blank draft as missing, matching CI's content test", async () => {
    writeWorkflow(NOTES_AWARE_WORKFLOW);
    fs.writeFileSync(path.join(dir, "RELEASE_NOTES.draft.md"), "   \n\n");
    const { git } = makeGit();
    expect((await planRelease(git, { dir, bump: "patch" })).warning).toMatch(/no release notes yet/i);
  });

  it("stays silent once the draft is there", async () => {
    writeWorkflow(NOTES_AWARE_WORKFLOW);
    const { git } = makeGit();
    expect(await planRelease(git, { dir, bump: "patch" })).not.toHaveProperty("warning");
  });

  it("stays silent for a repo whose workflow ignores authored notes (req 9)", async () => {
    writeWorkflow(LEGACY_WORKFLOW);
    fs.rmSync(path.join(dir, "RELEASE_NOTES.draft.md"));
    const { git } = makeGit();
    expect(await planRelease(git, { dir, bump: "patch" })).not.toHaveProperty("warning");
  });

  it("stays silent for a prerelease, which cannot carry a notes file (req 6a)", async () => {
    writeWorkflow(NOTES_AWARE_WORKFLOW);
    fs.rmSync(path.join(dir, "RELEASE_NOTES.draft.md"));
    const { git } = makeGit();
    const plan = await planRelease(git, { dir, bump: "patch", prerelease: true });
    expect(plan.prerelease).toBe(true);
    expect(plan).not.toHaveProperty("warning");
  });
});

describe("prepareRelease — authored release notes (docs/309)", () => {
  const draft = () => path.join(dir, "RELEASE_NOTES.draft.md");
  const published = () => path.join(dir, ".release-notes", "v0.2.1.md");

  it("commits the user's draft as the tag's notes file and removes the draft", async () => {
    fs.writeFileSync(draft(), "## Highlights\n\nPreviews reconnect on their own.\n");
    const { git, calls } = makeGit({ diffFiles: 4 });

    await prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" });

    expect(fs.readFileSync(published(), "utf-8")).toBe("## Highlights\n\nPreviews reconnect on their own.\n");
    expect(calls.commitPaths.mock.calls[0]![0]).toContain(path.join(".release-notes", "v0.2.1.md"));
    expect(fs.existsSync(draft())).toBe(false);
  });

  it("refuses a release with no notes rather than publishing the generated list", async () => {
    fs.rmSync(draft());
    const { git, calls } = makeGit({ diffFiles: 4 });

    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(calls.commitPaths).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
  });

  it("refuses before rewriting the tree, so a fixable mistake costs no checkout", async () => {
    fs.rmSync(draft());
    const { git, calls } = makeGit({ diffFiles: 4 });
    const onTreeRewrite = vi.fn();

    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main", onTreeRewrite }),
    ).rejects.toThrow(/no notes/i);

    expect(calls.createBranchFrom).not.toHaveBeenCalled();
    expect(calls.mergeOverride).not.toHaveBeenCalled();
    expect(onTreeRewrite).not.toHaveBeenCalled();
  });

  it("names the draft file in the refusal, so the fix is one write away", async () => {
    fs.rmSync(draft());
    const { git } = makeGit({ diffFiles: 4 });

    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" }),
    ).rejects.toThrow(/RELEASE_NOTES\.draft\.md/);
  });

  it("treats a whitespace-only draft as no draft", async () => {
    fs.writeFileSync(draft(), "   \n\n");
    const { git, calls } = makeGit({ diffFiles: 4 });

    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(calls.commitPaths).not.toHaveBeenCalled();
  });

  it("keeps the draft when the commit does not land, so the user's text is not lost", async () => {
    fs.writeFileSync(draft(), "## Highlights\n");
    const { git, calls } = makeGit({ diffFiles: 4 });
    calls.commitPaths.mockResolvedValue(null);

    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" }),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(calls.commitPaths.mock.calls[0]![0]).toContain(path.join(".release-notes", "v0.2.1.md"));
    expect(fs.existsSync(draft())).toBe(true);
  });

  it("keeps the draft when the push fails, so a retry still has the text", async () => {
    fs.writeFileSync(draft(), "## Highlights\n");
    const { git, calls } = makeGit({ diffFiles: 4 });
    calls.forcePush.mockRejectedValue(new Error("network"));

    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" }),
    ).rejects.toThrow(/network/);

    expect(fs.existsSync(draft())).toBe(true);
  });

  it("recovers the notes already on the release branch when re-run without a draft", async () => {
    fs.rmSync(draft());
    const { git, calls } = makeGit({ diffFiles: 4, remoteNotes: "## Highlights\n\nFrom the first run.\n" });

    await prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" });

    expect(calls.showFileAtRef).toHaveBeenCalledWith("origin/release/0.2.1", path.join(".release-notes", "v0.2.1.md"));
    expect(fs.readFileSync(published(), "utf-8")).toBe("## Highlights\n\nFrom the first run.\n");
    expect(calls.commitPaths.mock.calls[0]![0]).toContain(path.join(".release-notes", "v0.2.1.md"));
  });

  it("does not gate a repo whose release workflow publishes generated notes", async () => {
    fs.rmSync(draft());
    const { git, calls } = makeGit({ diffFiles: 4, notesWorkflow: false });

    const res = await prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" });

    expect(res.kind).toBe("pr-opened");
    expect(calls.commitPaths.mock.calls[0]![0]).toEqual(["package.json", "package-lock.json"]);
  });

  it("warns when notes were written but the workflow the release ships ignores them", async () => {
    const { git } = makeGit({ diffFiles: 4, notesWorkflow: false });

    const res = await prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" });

    expect(res).toMatchObject({ kind: "pr-opened" });
    expect((res as { warning?: string }).warning).toMatch(/will NOT be published/i);
  });

  it("probes the workflow on the ref the release ships, not the maintenance branch", async () => {
    const { git, calls } = makeGit({ diffFiles: 4 });

    await prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" });

    expect(calls.showFileAtRef).toHaveBeenCalledWith("origin/main", ".github/workflows/release.yml");
  });

  it("probes the maintenance branch's workflow for a --pick hotfix, which keeps that tree", async () => {
    const { git, calls } = makeGit({ commitsAhead: 1 });

    await prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", pick: ["abc123"] });

    expect(calls.showFileAtRef).toHaveBeenCalledWith("origin/stable", ".github/workflows/release.yml");
  });

  it("prefers a fresh draft over the notes already on the release branch", async () => {
    fs.writeFileSync(draft(), "## Rewritten\n");
    const { git } = makeGit({ diffFiles: 4, remoteNotes: "## Stale\n" });

    await prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" });

    expect(fs.readFileSync(published(), "utf-8")).toBe("## Rewritten\n");
  });
});

describe("prepareRelease — ShipIt's plugin-skill copies across a skills root the release branch shapes differently", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-plugin-skills-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const COPY = "plugins--probe--probe-0123456789ab";
  const STAGING = `.${COPY}.staging-1a2b3c4d`;
  const SESSION_BRANCH = "shipit/abc123";

  function sh(cwd: string, cmd: string): string {
    return execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();
  }

  /**
   * `main` keeps the skills in `.agents/skills` and symlinks `.claude/skills` to it. In the
   * incident's shape `stable` is the reverse, and a commit on `main` moved the root.
   */
  function repo(stable: "reversed" | "same"): { workDir: string; moveCommit: string } {
    const bareDir = path.join(tmpDir, "bare.git");
    const workDir = path.join(tmpDir, "work");
    fs.mkdirSync(bareDir);
    fs.mkdirSync(workDir);
    sh(bareDir, "git init --bare -b main");
    sh(workDir, `git clone ${bareDir} .`);
    fs.writeFileSync(path.join(workDir, "VERSION"), "0.5.1\n");
    fs.mkdirSync(path.join(workDir, ".claude/skills/real"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".claude/skills/real/SKILL.md"), "# real\n");
    fs.mkdirSync(path.join(workDir, ".agents"));
    fs.symlinkSync("../.claude/skills", path.join(workDir, ".agents/skills"));
    sh(workDir, "git add -A && git commit -m 'Skills in .claude' && git push origin main");
    if (stable === "reversed") sh(workDir, "git push origin main:stable");

    sh(workDir, "git rm -q .agents/skills && mkdir -p .agents && git mv .claude/skills .agents/skills");
    fs.symlinkSync("../.agents/skills", path.join(workDir, ".claude/skills"));
    sh(workDir, "git add -A && git commit -m 'Move the skills root to .agents' && git push origin main");
    const moveCommit = sh(workDir, "git rev-parse HEAD");
    if (stable === "same") sh(workDir, "git push origin main:stable");

    fs.writeFileSync(path.join(workDir, "feature.txt"), "work\n");
    sh(workDir, "git add -A && git commit -m 'Work to release' && git push origin main");
    return { workDir, moveCommit };
  }

  function sessionOn(workDir: string, startPoint: string): GitManager {
    sh(workDir, `git fetch -q origin && git checkout -q -b ${SESSION_BRANCH} ${startPoint}`);
    return new GitManager(workDir);
  }

  function writeOwnedDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, PLUGIN_SKILL_MARKER),
      JSON.stringify({ marker: PLUGIN_SKILL_MARKER_ID, source: "/checkout/skills/probe", name: path.basename(dir) }),
    );
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# copy\n");
  }

  function writeCopies(workDir: string, root: string): void {
    writeOwnedDir(path.join(workDir, root, COPY));
    writeOwnedDir(path.join(workDir, root, STAGING));
  }

  // What preparePlugins leaves: the copies, a crashed pass's staging dir, and their exclude block.
  function materializeCopies(workDir: string, root: string): void {
    writeCopies(workDir, root);
    fs.appendFileSync(
      path.join(workDir, ".git/info/exclude"),
      `/${root}/.plugins--*.staging-*/\n/${root}/${COPY}/\n`,
    );
  }

  // What the route passes for the session's own workspace: the worker's prepare pass.
  function ownWorkspace() {
    const prepare = vi.fn(() => Promise.resolve());
    return { prepare, session: { restorePluginSkills: prepare } };
  }

  // Verbatim from git 2.39.5, the orchestrator image's git (node:24-slim, bookworm).
  const git239Refusal = (root: string) =>
    `error: Updating the following directories would lose untracked files in them:\n\t${root}\n\nAborting\n`;

  /**
   * Newer git deletes ignored files in a directory it replaces, so CI's git would never refuse.
   * This makes any git refuse the way the orchestrator's does: while the real `root` still
   * holds anything besides `tracked`.
   */
  function blockedLikeGit239(workDir: string, root: string, tracked: readonly string[] = ["real"]): boolean {
    const dir = path.join(workDir, root);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    return stat?.isDirectory() === true && fs.readdirSync(dir).some((name) => !tracked.includes(name));
  }

  function checkoutRefusesLikeGit239(git: GitManager, workDir: string, root: string): void {
    const createBranchFrom = git.createBranchFrom.bind(git);
    git.createBranchFrom = (branch: string, startPoint: string) =>
      blockedLikeGit239(workDir, root)
        ? Promise.reject(new Error(git239Refusal(root)))
        : createBranchFrom(branch, startPoint);
  }

  function expectReleasedFromMain(workDir: string): void {
    expect(sh(workDir, "git rev-parse --abbrev-ref HEAD")).toBe("release/0.5.2");
    expect(fs.lstatSync(path.join(workDir, ".claude/skills")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(workDir, ".agents/skills")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(workDir, ".agents/skills/real/SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(workDir, "VERSION"), "utf-8")).toBe("0.5.2\n");
    expect(sh(workDir, "git ls-remote --heads origin release/0.5.2")).not.toBe("");
  }

  const releaseFromMain = { bump: "patch", releaseBranch: "stable", mechanism: "release-branch", from: "main" };

  it("with this machine's own git, whichever way it treats the copies, opens the release PR and prepares them again", async () => {
    const { workDir } = repo("reversed");
    const git = sessionOn(workDir, "origin/main");
    materializeCopies(workDir, ".agents/skills");
    const { prepare, session } = ownWorkspace();

    const res = await prepareRelease(git, githubAuth, { dir: workDir, ...releaseFromMain, ...session });

    expect(res).toMatchObject({ kind: "pr-opened", version: "0.5.2" });
    expectReleasedFromMain(workDir);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("clears the copies git 2.39 refuses over, checks out the release branch, and prepares them again", async () => {
    const { workDir } = repo("reversed");
    const git = sessionOn(workDir, "origin/main");
    materializeCopies(workDir, ".agents/skills");
    checkoutRefusesLikeGit239(git, workDir, ".agents/skills");
    const { prepare, session } = ownWorkspace();
    const onTreeRewrite = vi.fn();

    const res = await prepareRelease(git, githubAuth, { dir: workDir, ...releaseFromMain, ...session, onTreeRewrite });

    expect(res).toMatchObject({ kind: "pr-opened", version: "0.5.2" });
    expectReleasedFromMain(workDir);
    expect(fs.existsSync(path.join(workDir, ".agents/skills", COPY))).toBe(false);
    expect(fs.existsSync(path.join(workDir, ".agents/skills", STAGING))).toBe(false);
    expect(onTreeRewrite).toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    // The copies go back into the tree the release ends on, not the one the checkout passes through.
    expect(prepare.mock.invocationCallOrder[0]).toBeGreaterThan(agentCreatePrMock.mock.invocationCallOrder[0]);
  });

  it("prepares the copies again when git deleted them itself, as git newer than 2.39 does", async () => {
    const { workDir } = repo("reversed");
    const git = sessionOn(workDir, "origin/main");
    materializeCopies(workDir, ".agents/skills");
    const createBranchFrom = git.createBranchFrom.bind(git);
    git.createBranchFrom = (branch: string, startPoint: string) => {
      for (const name of [COPY, STAGING]) fs.rmSync(path.join(workDir, ".agents/skills", name), { recursive: true });
      return createBranchFrom(branch, startPoint);
    };
    const { prepare, session } = ownWorkspace();

    const res = await prepareRelease(git, githubAuth, { dir: workDir, ...releaseFromMain, ...session });

    expect(res).toMatchObject({ kind: "pr-opened" });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("clears the copies for the bootstrap checkout too", async () => {
    const { workDir } = repo("reversed");
    // A session on the old layout, and a repository whose release branch does not exist yet.
    const git = sessionOn(workDir, "origin/stable");
    sh(workDir, "git push -q origin --delete stable && git fetch -q --prune origin");
    materializeCopies(workDir, ".claude/skills");
    checkoutRefusesLikeGit239(git, workDir, ".claude/skills");
    const { prepare, session } = ownWorkspace();

    const res = await prepareRelease(git, githubAuth, {
      dir: workDir, bump: "patch", releaseBranch: "stable", mechanism: "release-branch", bootstrap: true, ...session,
    });

    expect(res).toMatchObject({ kind: "pr-opened" });
    expect(sh(workDir, "git ls-remote --heads origin stable")).not.toBe("");
    expect(fs.lstatSync(path.join(workDir, ".claude/skills")).isSymbolicLink()).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  /**
   * A hotfix session on the release branch's layout, whose own commit ignores what is in the
   * skills root. The release checkout drops that `.gitignore`, so at the pick the files are
   * plainly untracked and every git version refuses for real, under `GitManager.cherryPick`
   * and its abort. The checkout itself keeps the root, so it keeps the copies.
   */
  function hotfixSession(workDir: string): GitManager {
    const git = sessionOn(workDir, "origin/stable");
    fs.writeFileSync(
      path.join(workDir, ".gitignore"),
      "/.claude/skills/plugins--*/\n/.claude/skills/.plugins--*/\n/.claude/skills/local-notes/\n",
    );
    sh(workDir, "git add .gitignore && git commit -q -m 'Ignore local skill files'");
    writeCopies(workDir, ".claude/skills");
    return git;
  }

  const pickFromMain = (picks: string[]) =>
    ({ bump: "patch", releaseBranch: "stable", mechanism: "release-branch", pick: picks });

  it("clears the copies for a --pick whose second commit changes the root's shape, and picks each commit once", async () => {
    const { workDir, moveCommit } = repo("reversed");
    const git = hotfixSession(workDir);
    const workCommit = sh(workDir, "git rev-parse origin/main");
    const { prepare, session } = ownWorkspace();

    const res = await prepareRelease(git, githubAuth, {
      dir: workDir, ...pickFromMain([workCommit, moveCommit]), ...session,
    });

    expect(res).toMatchObject({ kind: "pr-opened", version: "0.5.2" });
    expect(sh(workDir, "git rev-parse --abbrev-ref HEAD")).toBe("release/0.5.2");
    // Git committed the first pick before it refused the second; a retry on top of it would not apply.
    expect(sh(workDir, "git rev-list --count origin/stable..HEAD")).toBe("3");
    expect(fs.existsSync(path.join(workDir, "feature.txt"))).toBe(true);
    expect(fs.lstatSync(path.join(workDir, ".claude/skills")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(workDir, ".agents/skills", COPY))).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("a --pick that stays refused is undone: nothing picked, on the release branch, and the message says so", async () => {
    const { workDir, moveCommit } = repo("reversed");
    const git = hotfixSession(workDir);
    const notes = path.join(workDir, ".claude/skills/local-notes");
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, "todo.md"), "mine\n");
    const workCommit = sh(workDir, "git rev-parse origin/main");
    const { prepare, session } = ownWorkspace();

    const err = await prepareRelease(git, githubAuth, {
      dir: workDir, ...pickFromMain([workCommit, moveCommit]), ...session,
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ statusCode: 409 });
    const message = (err as Error).message;
    expect(message).toContain("`.claude/skills`");
    expect(message).toContain("Nothing was picked: the session is on `release/0.5.2`, level with `stable`.");
    expect(message).toContain("`release/0.5.2` was not pushed");
    expect(sh(workDir, "git rev-parse --abbrev-ref HEAD")).toBe("release/0.5.2");
    expect(sh(workDir, "git rev-parse HEAD")).toBe(sh(workDir, "git rev-parse origin/stable"));
    expect(fs.existsSync(path.join(workDir, "feature.txt"))).toBe(false);
    expect(fs.existsSync(path.join(workDir, ".git/sequencer"))).toBe(false);
    expect(sh(workDir, "git ls-remote --heads origin 'release/*'")).toBe("");
    expect(agentCreatePrMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(notes, "todo.md"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(workDir, ".claude/skills", COPY))).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not answer before the copies are back", async () => {
    const { workDir } = repo("reversed");
    const git = sessionOn(workDir, "origin/main");
    materializeCopies(workDir, ".agents/skills");
    checkoutRefusesLikeGit239(git, workDir, ".agents/skills");
    let finishPrepare: () => void = () => {};
    const prepare = vi.fn(() => new Promise<void>((resolve) => { finishPrepare = resolve; }));
    let answered = false;

    const release = (async () => {
      const res = await prepareRelease(git, githubAuth, { dir: workDir, ...releaseFromMain, restorePluginSkills: prepare });
      answered = true;
      return res;
    })();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));

    expect(answered).toBe(false);
    finishPrepare();
    await expect(release).resolves.toMatchObject({ kind: "pr-opened" });
  });

  it("clears nothing in a clone that is not the session's workspace, where no prepare pass puts copies back", async () => {
    const { workDir } = repo("reversed");
    const git = sessionOn(workDir, "origin/main");
    materializeCopies(workDir, ".agents/skills");
    checkoutRefusesLikeGit239(git, workDir, ".agents/skills");

    const err = await prepareRelease(git, githubAuth, { dir: workDir, ...releaseFromMain }).catch((e: unknown) => e);

    expect(err).toMatchObject({ statusCode: 409 });
    expect((err as Error).message).toContain("`.agents/skills`");
    expect((err as Error).message).not.toMatch(/plugin skill copies/);
    expect(fs.existsSync(path.join(workDir, ".agents/skills", COPY, "SKILL.md"))).toBe(true);
    expect(sh(workDir, "git rev-parse --abbrev-ref HEAD")).toBe(SESSION_BRANCH);
  });

  it("leaves the copies alone, and prepares nothing, on a release whose checkout keeps them", async () => {
    const { workDir } = repo("same");
    const git = sessionOn(workDir, "origin/main");
    materializeCopies(workDir, ".agents/skills");
    const { prepare, session } = ownWorkspace();

    const res = await prepareRelease(git, githubAuth, { dir: workDir, ...releaseFromMain, ...session });

    expect(res).toMatchObject({ kind: "pr-opened" });
    expect(fs.existsSync(path.join(workDir, ".agents/skills", COPY, "SKILL.md"))).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("a refusal its sweep cannot clear leaves the session on its own branch, restores the copies, and says what to do", async () => {
    const { workDir } = repo("reversed");
    const git = sessionOn(workDir, "origin/main");
    const notes = path.join(workDir, ".agents/skills/local-notes");
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, "todo.md"), "mine\n");
    fs.appendFileSync(path.join(workDir, ".git/info/exclude"), "/.agents/skills/local-notes/\n");
    materializeCopies(workDir, ".agents/skills");
    checkoutRefusesLikeGit239(git, workDir, ".agents/skills");
    const headBefore = sh(workDir, "git rev-parse HEAD");
    const { prepare, session } = ownWorkspace();
    const onTreeRewrite = vi.fn();

    const err = await prepareRelease(git, githubAuth, { dir: workDir, ...releaseFromMain, ...session, onTreeRewrite })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ statusCode: 409 });
    const message = (err as Error).message;
    expect(message).toContain("`.agents/skills`");
    expect(message).toContain(`still on \`${SESSION_BRANCH}\``);
    expect(message).toMatch(/git status --short --ignored/);
    expect(message).toMatch(/run the command again/);
    // Nothing between two branches: the same branch and commit, a clean tree, no release branch anywhere.
    expect(sh(workDir, "git rev-parse --abbrev-ref HEAD")).toBe(SESSION_BRANCH);
    expect(sh(workDir, "git rev-parse HEAD")).toBe(headBefore);
    expect(sh(workDir, "git status --porcelain")).toBe("");
    expect(sh(workDir, "git for-each-ref refs/heads/release")).toBe("");
    expect(sh(workDir, "git ls-remote --heads origin 'release/*'")).toBe("");
    expect(onTreeRewrite).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(notes, "todo.md"), "utf8")).toBe("mine\n");
    // What it cleared comes back even though the release was refused.
    expect(fs.existsSync(path.join(workDir, ".agents/skills", COPY))).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not report another git failure as an untracked-files refusal", async () => {
    const { workDir } = repo("reversed");
    const git = sessionOn(workDir, "origin/main");
    materializeCopies(workDir, ".agents/skills");
    git.createBranchFrom = () => Promise.reject(new Error("fatal: Unable to create '/w/.git/index.lock': File exists."));
    const { prepare, session } = ownWorkspace();

    await expect(prepareRelease(git, githubAuth, { dir: workDir, ...releaseFromMain, ...session }))
      .rejects.toThrow(/index\.lock/);

    expect(fs.existsSync(path.join(workDir, ".agents/skills", COPY, "SKILL.md"))).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });
});
