# Deployment

**ShipIt does not deploy. The hosting platform, or the repository's own CI,
does.** There is no ShipIt-side build step, no deploy CLI, and no stored
platform API token: the user connects their GitHub repo to a platform once, and
from then on ShipIt's auto-push is what triggers each deploy.

This file is your operating manual — what you can do about a deploy from inside
a session. When the **user** asks what ShipIt can do about deploys, answer from
[`wiki/deploying.md`](wiki/deploying.md), which covers the panels, the status
row and its states, and who does what.

## How it is set up

The user opens a repo's **Project Settings → Deployments** tab — on a repository
group's overflow menu in the sidebar, so a sandbox session has no such menu —
which links out to Vercel, Cloudflare Pages and Netlify's own repo-import pages.
Auth is the platform's own Git integration; ShipIt holds no credential for it
and stores nothing. This is a §3 external tab — the platform owns its account
and billing pages.

A repository that deploys itself from a **GitHub Actions workflow** needs none
of that: the workflow is a file in the repo, so writing and fixing it is your
work, and its deployments render the same way.

## The loop

1. The user imports the GitHub repo on the platform (or the repo carries its own
   deploy workflow).
2. ShipIt auto-pushes the session branch after a turn that left something to
   commit. `services/auto-commit-gate.ts` excludes **ops** and **sandbox**
   sessions from the auto-commit sweep, and `ws-handlers/post-turn.ts` refuses
   the push for work stacked on an already-merged branch.
3. The platform builds and deploys on its own, from that push.
4. ShipIt reads the resulting deployment back from GitHub (`pr-status-parser.ts`
   takes `deployments(last: 3)` on the PR's head commit) and renders it on the
   PR lifecycle card (`PrLifecycleCard/indicators/DeploymentStatusRow.tsx`) and
   in the PR tab (`pr-detail/PrStatusSection.tsx`).

So build command, output directory and framework detection are all the
platform's settings, configured there — not in ShipIt.

## What you can actually do

The deployment row itself carries no build log, so there is nothing to read
there. What you have depends on who ran the build.

- **GitHub Actions.** `gh run list --branch <branch>` and
  `gh run view <id> --log-failed` give you the real failure, on **any** branch —
  including the base branch, which is how you investigate the deploy a merge
  triggered. `gh run rerun [<id>] [--failed]` re-runs a workflow with no code
  change, but only a run on the branch you are on, at the commit you are on,
  that a push or a `pull_request` triggered; anything else is refused
  (`services/github.ts` `rerunRefusal`). `gh workflow run` and `gh run cancel`
  are not available at all.
- **A hosted platform's build.** Nothing in ShipIt reaches it. Reproduce the
  build in the session instead — it is the project's own build — and ask the
  user for the error text only when it cannot be reproduced here.

## Notes

- Deploy status is otherwise read-only: ShipIt reports it, and never starts,
  cancels, or promotes a deployment. The Actions re-run above is the one
  exception, and it is deliberately scoped to your own branch and commit
  precisely so it cannot re-execute someone else's deploy.
- A branch that has no pull request still pushes, so a platform configured to
  build every branch will still produce preview deployments; the status row only
  appears where ShipIt has a PR to attach it to. Merging **or closing** that PR
  replaces its status with a terminal summary carrying no deployments, so the
  rows clear either way.
- Polling is not continuous. It runs every 15s for five minutes after a push —
  also while checks are pending, a CI auto-fix is running, or ShipIt-managed
  auto-merge is armed — and otherwise falls back to roughly two-minute
  intervals. It stops entirely once no viewer is attached **anywhere in the
  installation** and no background work needs it (`polling-global-gate.ts`
  `isOpen`, which scans the whole runner registry). A row that looks frozen
  after the user has been away is not a lost deploy.
