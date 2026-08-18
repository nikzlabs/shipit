/**
 * Upload Git LFS objects on the ORCHESTRATOR's push paths.
 *
 * ## The bug this closes
 *
 * The git-lfs `pre-push` hook is the ONLY thing that uploads LFS objects during
 * an ordinary `git push`. Orchestrator-side git runs with
 * `-c core.hooksPath=/dev/null` on every argv (`git-hooks-guard.ts`,
 * planning#384), because a session workspace is writable by untrusted plugin
 * containers and the orchestrator is root. That guard is correct and must stay —
 * but it takes the LFS upload with it.
 *
 * So `GitManager.push()` sent the *pointers* while their *objects* stayed in the
 * local `.git/lfs/objects`. GitHub rejects that:
 *
 * ```
 * remote: error: GH008: Your push referenced at least 8 unknown Git LFS objects
 *  ! [remote rejected] <branch> -> <branch> (pre-receive hook declined)
 * error: failed to push some refs to '…'
 * ```
 *
 * Observed on 2026-08-18 against `nicolasalt/reward-tag`: two turns' commits
 * stayed local while a manual `git push` from the session container — whose git
 * DOES run hooks — succeeded as a plain fast-forward, uploading 8 objects /
 * 18 MB on its way. The orchestrator and the container share one `.git`, so the
 * objects were there the whole time; nothing had sent them.
 *
 * ## Why an explicit `git lfs push` rather than re-enabling the hook
 *
 * `git lfs push <remote> <branch>` performs exactly the transfer the `pre-push`
 * hook would, and it does it as a first-class subcommand — so hooks stay
 * disabled and planning#384's control is untouched. It is a no-op transfer when
 * the remote already has every object, which is the common case for a repo that
 * tracks nothing new.
 *
 * ## Best-effort, never fatal
 *
 * `CLAUDE.md` post-turn invariant 2 and docs/266 req 6 both say the post-turn
 * push may not gain a new way to fail. A failed upload therefore does NOT
 * abort the ref push: the ref push runs anyway and either succeeds (the objects
 * were already on the remote) or fails with the server's own GH008, which
 * `classifyPushFailure` reports as an LFS failure rather than as a divergence.
 * Losing the upload is a degraded push; throwing here would be a lost commit.
 *
 * ## Why detection lives here too
 *
 * `orchestrator/git-lfs.ts` greps the committed `.gitattributes` for
 * `filter=lfs` to decide whether a repo uses LFS at all, and this module needs
 * the identical question answered — one `git grep` per push, so a non-LFS repo
 * pays a ref-scoped grep and no `git lfs` invocation. The argv is defined ONCE
 * here ({@link lfsDeclarationGrepArgs}) and imported by that module, because two
 * copies of "how do we know this is an LFS repo" would drift into two different
 * answers. It lives in `shared/` rather than in `orchestrator/` only because
 * `shared/git.ts` is the module that has to push, and `shared/` may not import
 * from `orchestrator/`.
 */

import type { SimpleGit } from "simple-git";

/**
 * The `git grep` that decides whether a repo tracks anything with Git LFS.
 *
 * Greps the **committed** `.gitattributes` files rather than asking
 * `git lfs ls-files`: it works without the `git-lfs` binary, it is a single
 * ref-scoped grep instead of a walk of the whole tree, and the same call works
 * against a bare cache and a checked-out workspace alike. The `*.gitattributes`
 * pathspec catches nested declarations too — git pathspec globs match across
 * `/` and `*` matches the empty string.
 *
 * Exit codes are the contract: 0 = matched, 1 = no match, anything else
 * (128: unborn HEAD, bad object) is "can't tell", which every caller answers as
 * "no" so a non-repo degrades to today's behaviour instead of firing spuriously.
 */
export function lfsDeclarationGrepArgs(ref = "HEAD"): string[] {
  return [
    "grep", "--ignore-case", "--fixed-strings", "-l", "-e", "filter=lfs",
    ref, "--", "*.gitattributes",
  ];
}

/** What {@link pushLfsObjects} did, for the caller's log line. */
export type LfsPushOutcome =
  /** The repo declares no LFS filters — nothing was run. */
  | { status: "not-an-lfs-repo" }
  /** `git lfs push` exited 0; every object this branch references is on the remote. */
  | { status: "pushed" }
  /** `git lfs push` failed. The ref push still runs — see the module docstring. */
  | { status: "failed"; detail: string };

/**
 * Upload the LFS objects `branch` references to `remote`, if this repo uses LFS.
 *
 * @param git - the instance the REF push will use. Passing the same one is
 *   load-bearing: on the docs/266 dropped-uid path that instance carries the
 *   per-remote credential (`credentialledGit`), and the LFS endpoint
 *   authenticates separately from the ref push — a plain `this.git` here would
 *   reach the LFS API with no credential at all.
 *
 * Never throws.
 */
export async function pushLfsObjects(
  git: SimpleGit,
  remote: string,
  branch: string,
): Promise<LfsPushOutcome> {
  let declaresLfs: boolean;
  try {
    // `raw` throws on exit 1 ("no match"), which is a normal answer here.
    declaresLfs = (await git.raw(lfsDeclarationGrepArgs())).trim().length > 0;
  } catch {
    return { status: "not-an-lfs-repo" };
  }
  if (!declaresLfs) return { status: "not-an-lfs-repo" };

  try {
    await git.raw(["lfs", "push", remote, branch]);
    return { status: "pushed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", detail: message.trim().split("\n").slice(-3).join(" ").slice(0, 300) };
  }
}
