# Deployment

**ShipIt does not deploy. The hosting platform does.** There is no ShipIt-side
build or deploy step, no deploy CLI, and no stored platform API token — the
user connects their GitHub repo to a platform once, and from then on ShipIt's
auto-push after every turn is what triggers each deploy.

## How it is set up

The user opens a repo's **Project Settings → Deployments** tab, which links out
to Vercel, Cloudflare Pages and Netlify's own repo-import pages. Auth is the
platform's own Git integration; ShipIt holds no credential for it and stores
nothing. This is a §3 external tab — the platform owns its account and billing
pages.

## The loop

1. The user imports the GitHub repo on the platform.
2. ShipIt auto-pushes the session branch after every turn.
3. The platform builds and deploys on its own, from that push.
4. ShipIt reads the resulting deployment back from GitHub's `deployments`
   API (`pr-status-parser.ts`) and renders it inline on the PR lifecycle card
   (`PrLifecycleCard/indicators/DeploymentStatusRow.tsx`).

So build command, output directory and framework detection are all the
platform's settings, configured there — not in ShipIt.

## Notes

- Deploy status is read-only here: ShipIt reports it, and never starts,
  cancels, or promotes a deployment.
- A branch that has no pull request still pushes, so a platform configured to
  build every branch will still produce preview deployments; the status row
  only appears where ShipIt has a PR to attach it to.
