/**
 * docs/214 Phase 3 — scaffold a release workflow into any repo.
 *
 * When a repo has no release workflow, the agent offers to scaffold one and
 * opens a PR (CI still does the publish). These render functions produce the
 * three files written into the workspace:
 *
 *   .github/workflows/release.yml          — renderReleaseWorkflow(opts)
 *   .github/release.yml                    — renderReleaseNotesConfig()
 *   .github/scripts/shipit-read-version.mjs  — renderReleaseVersionHelper()
 *   .github/scripts/shipit-write-version.mjs — renderReleaseVersionWriter()
 *
 * Unlike `templates.ts`, these are NOT registered in the `TEMPLATES` array —
 * scaffolding a release workflow is a chat-driven file write + the existing
 * auto-PR flow, not the new-project template grid (docs/214 "Any repo").
 *
 * Shape (docs/214 "Mechanism"): ONE workflow, TWO triggers, self-publishing.
 * It gates, tags, and publishes in the same run so it never relies on a
 * workflow-pushed tag re-triggering another workflow (the default GITHUB_TOKEN
 * recursion foot-gun) and needs no PAT.
 *
 *   - branch path (push to the release branch): derive `tag = v<version>` from
 *     the version source, gate, create the annotated tag on the merged commit,
 *     publish the Release.
 *   - tag path (push `v*`, prerelease/rc + manual tags): tag already exists,
 *     just gate + publish (prereleases flagged). Only rendered when
 *     `prerelease` is enabled.
 *
 * The version is read by `shipit-read-version.mjs`, which mirrors
 * `release-version.ts` EXACTLY — so the version CI tags can never disagree with
 * the version the release command bumped. Because that helper is Node, the
 * scaffolded workflow runs `setup-node` to read the version even in non-Node
 * repos (the read step is ShipIt's, independent of the repo's own toolchain).
 */

import { loadPrompt } from "./load-prompt.js";
import type { VersionSourceType } from "./release-version.js";

// ---------------------------------------------------------------------------
// Scaffold file paths (where each artifact lands in the target repo)
// ---------------------------------------------------------------------------

export const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
export const RELEASE_NOTES_CONFIG_PATH = ".github/release.yml";
export const RELEASE_VERSION_HELPER_PATH = ".github/scripts/shipit-read-version.mjs";
export const RELEASE_VERSION_WRITER_PATH = ".github/scripts/shipit-write-version.mjs";

/**
 * Version sources a `release-branch` workflow can derive a tag from. The branch
 * path reads the version from a file on the merged commit, so the tag-only
 * scheme is excluded — a branch push has no version file to read (docs/214
 * "release-branch requires an authoritative version source").
 */
export type ReleaseWorkflowVersionSource = Exclude<VersionSourceType, "tag">;

export interface RenderReleaseWorkflowOptions {
  /** Authoritative version source the branch path reads the tag from. */
  versionSource: ReleaseWorkflowVersionSource;
  /** Long-lived maintenance branch a release is cut by merging into (e.g. `stable`). */
  branch: string;
  /**
   * Optional gate command run before tag + publish (e.g. `"npm test"`). When
   * omitted no gate job is emitted — the publish proceeds on the trigger alone.
   */
  gate?: string;
  /**
   * Whether to also accept the tag path (`push: tags: ['v*']`) for release
   * candidates / manual tags, publishing `-rc.N` tags as GitHub prereleases.
   * Default false — finals-only via the release branch.
   */
  prerelease?: boolean;
}

// ---------------------------------------------------------------------------
// The version-read helper (real file, loaded once — see load-prompt rationale)
// ---------------------------------------------------------------------------

// Loaded at module init from a real `.mjs` sibling (NOT inlined as a string)
// so its regexes mirror release-version.ts without template-literal escaping,
// and stay lintable + unit-testable. A missing file fails loudly at boot.
const VERSION_HELPER = loadPrompt(import.meta.url, "./templates-release-files/shipit-read-version.mjs");

// The write-side counterpart, used by the `sync-default-branch` job to forward-port
// the released version onto the default branch. Mirrors `writeVersionToSource`.
const VERSION_WRITER = loadPrompt(import.meta.url, "./templates-release-files/shipit-write-version.mjs");

/** The Node version-read helper script, scaffolded to `RELEASE_VERSION_HELPER_PATH`. */
export function renderReleaseVersionHelper(): string {
  return VERSION_HELPER;
}

/** The Node version-write helper script, scaffolded to `RELEASE_VERSION_WRITER_PATH`. */
export function renderReleaseVersionWriter(): string {
  return VERSION_WRITER;
}

// ---------------------------------------------------------------------------
// Release notes config (.github/release.yml)
// ---------------------------------------------------------------------------

/**
 * Generalized `.github/release.yml` — configures the categorized notes that
 * `gh release create --generate-notes` produces. Categorization is by PR label;
 * the final `"*"` catch-all guarantees nothing is silently dropped.
 */
export function renderReleaseNotesConfig(): string {
  return `# Configures the auto-generated release notes that \`gh release create
# --generate-notes\` produces in .github/workflows/release.yml. GitHub reads
# this file at release time and groups the merged PRs (since the previous tag)
# into the titled sections below — the result is the changelog shown on the
# GitHub Releases page (and surfaced inline in ShipIt's update panel).
#
# Categorization is by PR label. The final "*" category is a catch-all so a PR
# with no matching label still appears under "Other Changes" — nothing is ever
# silently dropped.

changelog:
  exclude:
    # Keep release-plumbing noise out of user-facing notes.
    labels:
      - ignore-for-release
  categories:
    - title: 🚀 Features
      labels:
        - feature
        - enhancement
    - title: 🐛 Fixes
      labels:
        - bug
        - fix
    - title: 📝 Documentation
      labels:
        - documentation
        - docs
    - title: ⬆️ Dependencies
      labels:
        - dependencies
    - title: 🧰 Maintenance
      labels:
        - chore
        - refactor
        - ci
        - test
    # Catch-all — must stay last. Any PR not matched above lands here so every
    # merged change is represented in the notes.
    - title: Other Changes
      labels:
        - "*"
`;
}

// ---------------------------------------------------------------------------
// The release workflow (.github/workflows/release.yml)
// ---------------------------------------------------------------------------

/**
 * Render the generalized auto-publish release workflow (docs/214 "Mechanism").
 * Parameterized by version source, release branch, optional gate command, and
 * whether to also accept the rc/manual tag path.
 */
export function renderReleaseWorkflow(opts: RenderReleaseWorkflowOptions): string {
  const { versionSource, branch, gate, prerelease = false } = opts;
  const gateCmd = typeof gate === "string" ? gate.trim() : "";
  const hasGate = gateCmd.length > 0;
  const helper = RELEASE_VERSION_HELPER_PATH;

  // `on:` triggers — always the release branch; the tag path only when rc's are enabled.
  const triggers = prerelease
    ? `on:
  push:
    branches: ['${branch}']
    tags: ['v*']`
    : `on:
  push:
    branches: ['${branch}']`;

  // The resolve job: classify the trigger, derive the tag, decide whether to
  // proceed (skip when the Release already exists; repair when the tag exists
  // but its Release is missing).
  const resolveJob = renderResolveJob(versionSource, helper, prerelease, branch);
  const gateJob = hasGate ? renderGateJob(gateCmd) : "";
  const versionGuardJob = prerelease ? renderVersionGuardJob(versionSource, helper) : "";
  const publishNeeds = [
    "resolve",
    ...(hasGate ? ["gate"] : []),
    ...(prerelease ? ["version-guard"] : []),
  ];
  const publishJob = renderPublishJob(publishNeeds);
  const syncJob = renderSyncDefaultBranchJob(versionSource, helper, RELEASE_VERSION_WRITER_PATH, branch);

  const jobs = [resolveJob, gateJob, versionGuardJob, publishJob, syncJob].filter(Boolean).join("\n");

  return `name: Release

# AUTO-PUBLISH release workflow scaffolded by ShipIt (docs/214). ONE workflow,
# ${prerelease ? "two triggers" : "one trigger"}, self-publishing: it gates, tags, and publishes the GitHub
# Release in the SAME run, so it never relies on a workflow-pushed tag
# re-triggering another workflow and needs no PAT.
#
# A release is cut by MERGING a version-bump PR into \`${branch}\` (the long-lived
# maintenance branch). CI reads HEAD's version from ${versionSource}, tags that
# commit, and publishes — it never MOVES \`${branch}\`. The version is read by
# .github/scripts/shipit-read-version.mjs (the same logic ShipIt uses to bump
# it), so the tag and the version source can never silently drift.

${triggers}

permissions:
  contents: write

jobs:
${jobs}`;
}

// ---------------------------------------------------------------------------
// Individual jobs
// ---------------------------------------------------------------------------

function renderResolveJob(
  versionSource: ReleaseWorkflowVersionSource,
  helper: string,
  prerelease: boolean,
  branch: string,
): string {
  // Tag-path branch of the resolve script (only reachable when the tag trigger exists).
  const tagPath = prerelease
    ? `          if [[ "$GITHUB_REF" == refs/tags/* ]]; then
            # Tag path (rc / manual tag): the tag already exists, don't create one.
            TAG="$GITHUB_REF_NAME"
            VERSION="\${TAG#v}"
            echo "is_branch=false" >> "$GITHUB_OUTPUT"
            if [[ "$TAG" == *-* ]]; then PRE=true; else PRE=false; fi
            echo "prerelease=$PRE" >> "$GITHUB_OUTPUT"
            echo "tag=$TAG" >> "$GITHUB_OUTPUT"
            echo "version=$VERSION" >> "$GITHUB_OUTPUT"
            if gh release view "$TAG" >/dev/null 2>&1; then
              echo "Release $TAG already published — nothing to do."
              echo "proceed=false" >> "$GITHUB_OUTPUT"
            else
              echo "proceed=true" >> "$GITHUB_OUTPUT"
            fi
            exit 0
          fi
`
    : "";

  return `  # Classify the trigger and derive the release tag. The version is read with
  # the SAME logic ShipIt uses to bump it (shipit-read-version.mjs), so the tag
  # can never disagree with the version source.
  resolve:
    name: Resolve release tag
    runs-on: ubuntu-latest
    outputs:
      proceed: \${{ steps.resolve.outputs.proceed }}
      tag: \${{ steps.resolve.outputs.tag }}
      version: \${{ steps.resolve.outputs.version }}
      prerelease: \${{ steps.resolve.outputs.prerelease }}
      is_branch: \${{ steps.resolve.outputs.is_branch }}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - name: Resolve tag
        id: resolve
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
${tagPath}          # Branch path: derive the tag from the version source on the merged commit.
          VERSION="$(node ${helper} '${versionSource}')"
          TAG="v$VERSION"
          echo "is_branch=true" >> "$GITHUB_OUTPUT"
          echo "prerelease=false" >> "$GITHUB_OUTPUT"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          # \`${branch}\` is for FINAL releases — reject a prerelease version here
          # (rc's are cut via the tag path).
          if [[ "$VERSION" == *-* ]]; then
            echo "::error::Branch carries a prerelease version ($VERSION). The release branch is for final releases; cut rc's via a vX.Y.Z-rc.N tag."
            exit 1
          fi
          if gh release view "$TAG" >/dev/null 2>&1; then
            echo "Release $TAG already published — nothing to do."
            echo "proceed=false" >> "$GITHUB_OUTPUT"
          else
            # New release, or the tag exists but its Release is missing (a prior
            # run tagged but failed to publish) — proceed to publish/repair.
            echo "proceed=true" >> "$GITHUB_OUTPUT"
          fi
`;
}

function renderGateJob(gate: string): string {
  // The gate command is the repo's own (e.g. `npm test`). It runs verbatim —
  // adjust the checkout/setup steps below for your toolchain if the command
  // needs a runtime or installed dependencies.
  return `  # Gate the release on the repo's own checks before tag + publish.
  gate:
    name: Gate
    needs: resolve
    if: \${{ needs.resolve.outputs.proceed == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      # NOTE: add any runtime/dependency setup your gate command needs here
      # (e.g. actions/setup-node + a dependency install).
      - run: ${gate}
`;
}

function renderVersionGuardJob(versionSource: ReleaseWorkflowVersionSource, helper: string): string {
  // Tag path only: a pushed vX.Y.Z tag must match the version source. On the
  // branch path the tag is DERIVED from the source, so they can't drift and
  // this guard is skipped (docs/214).
  return `  # Tag path only: the pushed tag must match the version source. Skipped on the
  # branch path, where the tag is derived from the source and can't drift.
  version-guard:
    name: Tag matches version source
    needs: resolve
    if: \${{ needs.resolve.outputs.is_branch == 'false' && needs.resolve.outputs.proceed == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - name: Verify the version source equals the tag
        run: |
          set -euo pipefail
          VERSION="$(node ${helper} '${versionSource}')"
          TAG="\${{ needs.resolve.outputs.tag }}"
          if [ "v$VERSION" != "$TAG" ]; then
            echo "::error::version source (v$VERSION) does not match tag ($TAG)."
            exit 1
          fi
          echo "OK: version source v$VERSION matches tag $TAG"
`;
}

function renderPublishJob(needs: string[]): string {
  const needsList = `[${needs.join(", ")}]`;
  // Use !cancelled() && !failure() so publish still runs when an OPTIONAL
  // needed job (gate / version-guard) was SKIPPED by its `if` — a skipped need
  // would otherwise skip the dependent. proceed=='true' is the real gate.
  return `  # On green, create the annotated tag on the merged commit (branch path only,
  # and only if absent), then publish the GitHub Release. Checking Release
  # existence (not just tag existence) makes this repair-safe: a prior run that
  # tagged but failed to publish republishes on the next push.
  publish:
    name: Publish GitHub Release
    needs: ${needsList}
    if: \${{ !cancelled() && !failure() && needs.resolve.outputs.proceed == 'true' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
    # Serialize per resolved tag so a branch push and a manual tag push for the
    # same version can't both create the tag.
    concurrency:
      group: release-\${{ needs.resolve.outputs.tag }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v5
        with:
          # Full history so --generate-notes can diff against the previous tag.
          fetch-depth: 0
      - name: Tag (branch path) and publish the Release
        env:
          GH_TOKEN: \${{ github.token }}
          TAG: \${{ needs.resolve.outputs.tag }}
          IS_BRANCH: \${{ needs.resolve.outputs.is_branch }}
          PRERELEASE: \${{ needs.resolve.outputs.prerelease }}
        run: |
          set -euo pipefail
          if [ "$IS_BRANCH" = "true" ]; then
            # Create the annotated tag on the merged commit, only if absent.
            if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
              git config user.name "github-actions[bot]"
              git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
              git tag -a "$TAG" -m "Release $TAG" "$GITHUB_SHA"
              git push origin "$TAG"
            fi
            git fetch --tags --force
          fi
          # Repair-safe: publish only if the Release is missing.
          if gh release view "$TAG" >/dev/null 2>&1; then
            echo "Release $TAG already exists — nothing to publish."
            exit 0
          fi
          PRERELEASE_FLAG=""
          if [ "$PRERELEASE" = "true" ]; then PRERELEASE_FLAG="--prerelease"; fi
          gh release create "$TAG" --title "$TAG" --generate-notes --verify-tag $PRERELEASE_FLAG
`;
}

function renderSyncDefaultBranchJob(
  versionSource: ReleaseWorkflowVersionSource,
  readHelper: string,
  writeHelper: string,
  branch: string,
): string {
  // Forward-port the released version onto the repo's DEFAULT (development)
  // branch. A release bump lands only on the maintenance branch (`branch`), which
  // is never merged back — so the default branch's version source drifts behind
  // every release. After a green publish on the branch path, open (or leave) a
  // chore PR bumping the default branch to the released version. A PR (not a
  // direct push) respects branch protection; idempotent (no-op when already in
  // sync or the sync branch exists). rc's (tag path) never reach here — the job
  // is gated to the branch path. The default branch is resolved at runtime
  // (`gh repo view`) so this needs no extra config and works for main/master;
  // when it equals the maintenance branch the merge already advanced it, so skip.
  return `  # Forward-port the released version onto the repo's default branch (the release
  # bump lands only on \`${branch}\`, so the default branch would otherwise drift
  # behind every release). Opens a chore PR; the default branch is resolved at
  # runtime. Idempotent; skipped when the default branch IS the release branch.
  sync-default-branch:
    name: Sync version to the default branch
    needs: [resolve, publish]
    if: \${{ !cancelled() && !failure() && needs.resolve.outputs.is_branch == 'true' && needs.resolve.outputs.proceed == 'true' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - name: Open a version-sync PR if the default branch is behind
        env:
          GH_TOKEN: \${{ github.token }}
          TAG: \${{ needs.resolve.outputs.tag }}
          VERSION: \${{ needs.resolve.outputs.version }}
          RELEASE_BRANCH: '${branch}'
        run: |
          set -euo pipefail
          DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"
          if [ "$DEFAULT_BRANCH" = "$RELEASE_BRANCH" ]; then
            echo "Default branch ($DEFAULT_BRANCH) is the release branch — the merge already advanced it, nothing to sync."
            exit 0
          fi

          git checkout -B "$DEFAULT_BRANCH" "origin/$DEFAULT_BRANCH"
          CURRENT="$(node ${readHelper} '${versionSource}')"
          if [ "$CURRENT" = "$VERSION" ]; then
            echo "$DEFAULT_BRANCH already at $VERSION — nothing to sync."
            exit 0
          fi

          SYNC_BRANCH="release-sync/$TAG"
          if git ls-remote --exit-code --heads origin "$SYNC_BRANCH" >/dev/null 2>&1; then
            echo "Sync branch $SYNC_BRANCH already exists — leaving the existing PR."
            exit 0
          fi

          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout -b "$SYNC_BRANCH"

          # Write the released version with the SAME logic ShipIt used to bump it.
          node ${writeHelper} '${versionSource}' "$VERSION"
          git commit -am "Sync version to $TAG on $DEFAULT_BRANCH"
          git push origin "$SYNC_BRANCH"

          # Build the body with printf so no indentation leaks in as a markdown code block.
          BODY="$(printf '%s\\n' \\
            "Forward-ports the released version \\\`$VERSION\\\` (\\\`$TAG\\\`) onto \\\`$DEFAULT_BRANCH\\\`." \\
            "" \\
            "The release version bump lands only on \\\`$RELEASE_BRANCH\\\`, so \\\`$DEFAULT_BRANCH\\\`'s version source would otherwise stay behind every release. Merging this keeps it in sync with the latest published release." \\
            "" \\
            "Safe to merge as-is — it only touches the version source.")"

          # Create the PR, then best-effort add the exclusion label so this
          # version-bump PR stays out of the NEXT release's notes (the label may
          # not exist in a freshly scaffolded repo — don't fail the job over it).
          PR_URL="$(gh pr create --base "$DEFAULT_BRANCH" --head "$SYNC_BRANCH" --title "Sync version to $TAG on $DEFAULT_BRANCH" --body "$BODY")"
          gh pr edit "$PR_URL" --add-label ignore-for-release >/dev/null 2>&1 || \\
            echo "note: could not add the 'ignore-for-release' label (it may not exist) — the PR will appear in the next release's notes."
`;
}

// ---------------------------------------------------------------------------
// Convenience: the full scaffold as a path → content map
// ---------------------------------------------------------------------------

/**
 * Render the complete release-workflow scaffold for the agent flow to write
 * into the workspace: the workflow, the notes config, and the version read +
 * write helpers. Returns a map of repo-relative path → file content.
 */
export function renderReleaseScaffold(opts: RenderReleaseWorkflowOptions): Record<string, string> {
  return {
    [RELEASE_WORKFLOW_PATH]: renderReleaseWorkflow(opts),
    [RELEASE_NOTES_CONFIG_PATH]: renderReleaseNotesConfig(),
    [RELEASE_VERSION_HELPER_PATH]: renderReleaseVersionHelper(),
    [RELEASE_VERSION_WRITER_PATH]: renderReleaseVersionWriter(),
  };
}
