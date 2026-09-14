# Deploying

Getting the work in front of real users. This is the shortest page in the wiki
for a reason: **ShipIt does not deploy.** The hosting platform does, and ShipIt's
part is two things — it pushes the branch, and it reads the platform's result
back and renders it.

Say that plainly when the user asks. There is no deploy button, no ShipIt deploy
command, and no ShipIt-side build; nothing here cancels, promotes or rolls back
a deployment. What there is, is a loop that happens on its own — plus one
re-run you can perform yourself, below.

## The loop

1. The user connects the repository to a hosting platform, once. Their act —
   see below.
2. ShipIt commits and pushes the session's branch after **every turn that left
   something to commit** — in an ordinary repository session. Ops and sandbox
   sessions are excluded from that sweep, and a sandbox can hold a clone, so it
   is worth checking before promising a deploy there.
3. The platform sees the push and runs its own build and deploy.
4. The platform records a GitHub Deployment against the commit.
5. ShipIt polls GitHub, finds it, and shows it on the pull request.

Step 2 is the trigger. "Deploy now" means "push", so the ordinary way to
redeploy is to make a change and let the turn end.

There is **one** exception, and it is yours to use. Where the deploy is a
**GitHub Actions workflow in this repository**, `gh run rerun` re-runs it
without any code change — but only a run on the branch you are on, at the commit
you are on, that a push or a pull request triggered. A run on another branch is
refused by design, precisely because re-running it could re-execute a deploy.
`gh workflow run` and `gh run cancel` are not available at all. For a hosted
platform's own build there is no ShipIt control: the redeploy button on their
dashboard is the user's.

## Targets, and what each one needs

**Any platform that records a GitHub Deployment works.** ShipIt does not filter
by who created it, so a repository whose own GitHub Actions workflow records a
deployment renders exactly like a hosted platform's. What ShipIt ships is
three shortcuts, not three integrations — the **Deployments** tab links to the
import pages for **Vercel**, **Cloudflare Pages** and **Netlify**, and that is
the whole of ShipIt's knowledge of them.

That tab is in **Project Settings**, on a repository group's overflow menu in
the sidebar — so it exists per repository, and a sandbox session, which has no
repository, has no such menu. (The same tab opens with an **Agent permissions**
section, whose one toggle — *Allow agents to merge their own pull requests* —
belongs to `/shipit-docs/github.md`, not here.)

What has to be true. The first four are what makes a deploy happen at all, and
they are all settings on the platform or in the user's account; the last is only
what lets ShipIt show you the result.

| Needs | Whose | Why |
|---|---|---|
| The repository imported on the platform, using the platform's own Git integration | **The user's.** ShipIt holds no platform credential and stores nothing for it. This is one of the few things that genuinely happens in another tab — the platform owns its own account and billing pages | Without it nothing is watching the push |
| GitHub connected in ShipIt — Settings → Integrations | **The user's** | With no GitHub auth ShipIt still commits but does **not** push, so the branch never reaches GitHub and nothing can deploy |
| The platform configured to build this branch | **The user's**, on the platform | Session branches are not the default branch. A platform set to build only production will produce nothing for a session |
| Build command, output directory, framework, environment variables | **The user's**, on the platform | These are platform settings. They are not in `shipit.yaml`, and ShipIt's own secrets (`/shipit-docs/secrets.md`) go to the session's Compose services, never to the platform's build |
| A pull request for the session | **Yours** — you open it | The status row attaches to a pull request. A branch with no PR still pushes and still deploys; ShipIt just has nowhere to show it |

That whole table describes a **hosted platform**. A repository that deploys
itself from a GitHub Actions workflow needs no import and no platform account —
the workflow is a file in the repository, so writing it, fixing it and reading
its logs are all your work rather than the user's. Rows appear for it just the
same.

## Where deploy status appears

Two places, both fed by the same poll of GitHub:

- **The pull request card in the conversation**, while the PR is open. One row
  per deployment, under the checks.
- **The PR tab's Status section**, which shows the same rows without the "via"
  attribution. That tab appears in an ordinary repository session once its pull
  request exists — open, merged or closed — and never in an Ops or sandbox
  session.

Each row is: the environment name the platform chose, a state icon, and — when
the platform supplied one — a link to the deployed URL. That link is the user's
own app, not a bounce to GitHub. ShipIt shows the **three most recent**
deployments of the pull request's head commit.

| The row shows | GitHub's state | Means |
|---|---|---|
| Amber spinner | queued, waiting, pending, in_progress | The platform has it and is working. Anything ShipIt cannot recognise reads as pending too |
| Green globe | success, active | GitHub reports it live, at the URL on the row |
| Red cross | failure, error | The build or the deploy failed |
| Grey globe | inactive, destroyed, abandoned | No longer serving. Usually superseded by a later deployment, but the state does not say why |

**Freshness.** A push opens a five-minute window in which ShipIt polls every 15
seconds — the window a deploy normally starts in. Pending checks, a running CI
auto-fix and ShipIt-managed auto-merge hold that fast rate too. Otherwise a
quiet repository falls back to roughly every two minutes, so a build longer than
five minutes can report a couple of minutes late.

Polling also **stops entirely** shortly after the last viewer leaves — and that
is installation-wide, not per session: it pauses when nobody has *ShipIt* open
anywhere and no background work needs it, so closing this one session does not
by itself freeze its rows. A row that looks stale after the user has been away
is not a lost deploy; coming back starts the poll again and it catches up.

**Two honest gaps**, worth stating rather than working around:

- **Merging or closing the pull request ends ShipIt's view.** Either one drops
  the session out of polling and replaces its status with a terminal summary
  carrying no deployments, so the rows clear in both places. Nothing in ShipIt
  *renders* the production deploy that a merge triggers. That is a rendering gap, not a blindness: where production deploys
  from a GitHub Actions workflow, `gh run list --branch <base>` and
  `gh run view <id> --log-failed` still let you look, on any branch. Only a
  hosted platform's build is genuinely out of reach.
- **A deployment never gates a merge, on ShipIt's side.** Auto-merge and the
  CI auto-fix read the pull request's *checks* and never its deployments, so a
  red deployment row blocks nothing by itself. Many platforms publish a check
  alongside the deployment; where they do, that check is what CI shows and what
  auto-merge waits for.

## When a deploy fails

The row itself carries no reason — GitHub's deployment record has no build log
in it, so there is none to render. Do not send the user hunting; do the work
instead.

1. **If it is a GitHub Actions deploy, read the log.** `gh run list --branch
   <branch>` then `gh run view <id> --log-failed` gives you the actual failure,
   on any branch, without leaving the session. Start here whenever the
   deployment came from a workflow in this repository.
2. **Otherwise, reproduce it in the session.** A hosted platform's build is the
   project's own build. Run it here — the same command the platform runs, from
   the project's config — and read the error yourself.
3. **Check what differs between here and there.** A build that passes in the
   session and fails on the platform is usually an environment variable set only
   on the platform, a dependency present in the container but not in a clean
   install, or a build command configured differently there. Say which of the
   three it looks like.
4. **Fix and end the turn.** The push redeploys. There is nothing else to press.
5. **Only then, the platform's own log.** If a hosted build cannot be reproduced
   here, that log lives on the platform's dashboard and only the user can open
   it. Ask for the error text; do not ask them to debug it.

**No row at all** is a different problem from a failed row. In order of
likelihood: the session has no pull request yet, or its pull request has already
merged or closed, which clears the rows; nothing was pushed — check that
the commit actually reached GitHub before blaming anyone's configuration, since
a push is skipped when GitHub is not connected and refused for work stacked on
an already-merged branch; the platform is not configured to build this branch;
or nothing records GitHub Deployments here at all — in which case no row will
ever appear, and that is not a ShipIt fault to chase.

## Who does what

| The user does | You do |
|---|---|
| Imports the repository on the platform, once | Explain what the platform needs and why; never claim ShipIt can do it |
| Sets build settings and environment variables on the platform | Reproduce the build in the session and fix what is broken in the code |
| Opens a **hosted** build's log, which only they can reach | Read an **Actions** run's log yourself, and ask for the error text only in the hosted case |
| Merges — from the card, from armed auto-merge, or by granting an agent the toggle in Project Settings → Deployments. The merge button has conditions of its own; [pull-requests.md](pull-requests.md) has them | Open and maintain the pull request; say plainly that ShipIt renders nothing about the deploy a merge triggers |
