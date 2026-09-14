# Deploying

Getting the work in front of real users. This is the shortest page in the wiki
for a reason: **ShipIt does not deploy.** The hosting platform does, and ShipIt's
part is two things — it pushes the branch, and it reads the platform's result
back and renders it.

Say that plainly when the user asks. There is no deploy button, no deploy
command, no ShipIt-side build, and no way for either of you to start, cancel,
promote or roll back a deployment from here. What there is, is a loop that
happens on its own.

## The loop

1. The user connects the repository to a hosting platform, once. Their act —
   see below.
2. ShipIt commits and pushes the session's branch after **every turn**.
3. The platform sees the push and runs its own build and deploy.
4. The platform records a GitHub Deployment against the commit.
5. ShipIt polls GitHub, finds it, and shows it on the pull request.

Step 2 is the trigger. There is no other one. "Deploy now" means "push", and a
push happens when a turn ends with something to commit — so the way to redeploy
is to make a change, or to use the platform's own redeploy control on its
dashboard.

## Targets, and what each one needs

**Any platform that records a GitHub Deployment works.** ShipIt does not filter
by who created it, so a repository whose own GitHub Actions workflow records a
deployment renders exactly like a hosted platform's. What ShipIt ships is
three shortcuts, not three integrations — the **Deployments** tab links to the
import pages for **Vercel**, **Cloudflare Pages** and **Netlify**, and that is
the whole of ShipIt's knowledge of them.

That tab is in **Project Settings**, on a repository group's overflow menu in
the sidebar — so it exists per repository, and a sandbox session, which has no
repository, has no such menu. (The same tab carries the per-repository **Agent
permissions** toggle governing whether an agent may merge on its own; that
belongs to `/shipit-docs/github.md`, not here.)

Before a deploy can happen at all:

| Needs | Whose | Why |
|---|---|---|
| The repository imported on the platform, using the platform's own Git integration | **The user's.** ShipIt holds no platform credential and stores nothing for it. This is one of the few things that genuinely happens in another tab — the platform owns its own account and billing pages | Without it nothing is watching the push |
| GitHub connected in ShipIt — Settings → Integrations | **The user's** | With no GitHub auth ShipIt still commits after every turn but does **not** push, so the branch never reaches GitHub and nothing can deploy |
| The platform configured to build this branch | **The user's**, on the platform | Session branches are not the default branch. A platform set to build only production will produce nothing for a session |
| Build command, output directory, framework, environment variables | **The user's**, on the platform | These are platform settings. They are not in `shipit.yaml`, and ShipIt's own secrets (`/shipit-docs/secrets.md`) go to the session's Compose services, never to the platform's build |
| A pull request for the session | **Yours** — you open it | The status row attaches to a pull request. A branch with no PR still pushes and still deploys; ShipIt just has nowhere to show it |

## Where deploy status appears

Two places, both fed by the same poll of GitHub:

- **The pull request card in the conversation**, while the PR is open. One row
  per deployment, under the checks.
- **The PR tab's Status section**, which shows the same rows without the "via"
  attribution. That tab exists once the session has a pull request.

Each row is: the environment name the platform chose, a state icon, and a link
to the deployed URL (the user's own app — opening it is not a link-out to
GitHub). ShipIt shows the **three most recent** deployments of the pull
request's head commit.

| The row shows | GitHub's state | Means |
|---|---|---|
| Amber spinner | queued, pending, in_progress | The platform has it and is working |
| Green globe | success, active | Live at the URL on the row |
| Red cross | failure, error | The build or the deploy failed |
| Grey globe | inactive, destroyed, abandoned | Superseded by a later deployment |

**Freshness.** For five minutes after each push ShipIt polls every 15 seconds —
which is the window a deploy normally starts in. A quiet pull request falls back
to roughly every two minutes, so a build that takes longer than five minutes can
show its result a couple of minutes late. Nothing is wrong; it has not been
missed.

**Two honest gaps**, worth stating rather than working around:

- **Merging ends ShipIt's view.** Once the pull request merges, ShipIt stops
  following it, and the card's open phase — with it, the deployment rows — is
  replaced. The production deploy that the merge triggers is not shown anywhere
  in ShipIt. The platform's dashboard is the only place it exists.
- **A deployment never gates a merge, on ShipIt's side.** Auto-merge and the
  CI auto-fix read the pull request's *checks* and never its deployments, so a
  red deployment row blocks nothing by itself. Many platforms publish a check
  alongside the deployment; where they do, that check is what CI shows and what
  auto-merge waits for.

## When a deploy fails

ShipIt has the state and the URL and nothing else — GitHub's deployment record
carries no build log, so there is none to render. Do not send the user hunting;
do the work instead.

1. **Reproduce it in the session.** The failing build is the project's own
   build. Run it here — the same command the platform runs, from the project's
   config — and read the error yourself. This is the fastest path and it is
   entirely yours.
2. **Check what differs between here and there.** A build that passes in the
   session and fails on the platform is usually an environment variable set only
   on the platform, a dependency present in the container but not in a clean
   install, or a build command configured differently there. Say which of the
   three it looks like.
3. **Fix and end the turn.** The push redeploys. There is nothing else to press.
4. **Only then, the build log.** If the failure cannot be reproduced here, the
   log is on the platform's dashboard and only the user can open it. Ask for the
   error text; do not ask them to debug it.

**No row at all** is a different problem from a failed row. In order of
likelihood: the session has no pull request yet; GitHub is not connected, so
nothing was pushed; the platform is not configured to build this branch; or the
platform does not record GitHub Deployments at all — in which case no row will
ever appear, and that is not a ShipIt fault to chase.

## Who does what

| The user does | You do |
|---|---|
| Imports the repository on the platform, once | Explain what the platform needs and why; never claim ShipIt can do it |
| Sets build settings and environment variables on the platform | Reproduce the build in the session and fix what is broken in the code |
| Opens the build log when a failure cannot be reproduced here | Ask for the error text, then fix it |
| Merges, which is what triggers a production deploy | Open and maintain the pull request; say plainly that ShipIt does not show the post-merge deploy |
