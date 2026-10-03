---
issue: planning#627
title: Credential for a declared Git LFS host
description: A project names its non-GitHub Git LFS host in shipit.yaml and a ShipIt-held secret for it; ShipIt presents that secret to that host only.
---

# 320 — Credential for a declared Git LFS host that is not GitHub

Approved by the requester on 2026-09-30. Each requirement says where it came
from: **[request]** paraphrases the original request, **[answer]** comes from
the 2026-09-30 answers, **[added]** was supplied by the agent and approved with
the rest.

1. A project can declare, in its `shipit.yaml`, the host of its Git LFS server
   when that host is not GitHub. **[request]**
2. The project gives that host a credential that ShipIt holds, the way it holds
   plugin credentials: a per-repository secret set in Project Settings →
   Secrets, which `shipit.yaml` names. **[request]**
3. The secret's value is one line in git's credential-store format,
   `https://<username>:<password>@<host>`. **[answer]**
4. ShipIt presents the secret only while the host inside the secret and the host
   `shipit.yaml` declares are the same, so only someone who edits the secret can
   change where it goes. **[answer]**
5. When the two hosts differ, ShipIt presents nothing and says so where the user
   and the agent will see it. **[added]**
6. The credential is a username and password (HTTP Basic), handed out through
   git's credential helper. **[answer]**
7. The secret is never written into the repository or into the workspace's git
   configuration. **[request]**
8. ShipIt presents the secret to that one host only, after it clears every
   inherited credential helper. **[request]**
9. ShipIt presents it on every Git LFS transfer it runs itself for that
   repository: the upload before a push; the pull when it creates a workspace,
   forks a session, and after a sync, rebase, reset or merge; the background
   fill of the host's shared LFS store; and the diff viewer resolving an LFS
   image. **[request + answer]**
10. The session's credential helper answers for that host with the secret, and
    for no other host except GitHub. **[request]**
11. A declared host is one exact host name. A wildcard host is refused.
    **[request]**
12. ShipIt's existing checks on credential origins (`SAFE_ORIGIN`) and on the
    inherited git environment (`sanitizeGitEnv`) keep applying. **[request]**
13. An edit to `shipit.yaml` never widens what the session can reach. The docs
    tell the user to allow the LFS host, and the storage host its server
    redirects to, in the existing egress settings. **[answer]**
14. `/shipit-docs/environment.md` § Git LFS and the `shipit.yaml` reference
    describe the declaration and the secret's format. **[request]**

A consequence to know: requirement 10 lets the agent read the secret with
`git credential fill`, exactly as it can read the GitHub token today
(docs/172-agent-containment Gap 2-R).

## Open questions

None.

## Resolved questions

- 2026-09-30 — Where is the host bound to the secret, given that any commit can
  edit `shipit.yaml`? **Inside the secret:** its value is a credential-store line
  (`https://user:token@host`); `shipit.yaml` names the secret and the host, and
  ShipIt refuses when the two hosts differ. Constraint: no new storage or UI.
  (reqs 3, 4)
- 2026-09-30 — Which credential form? **Username and password (HTTP Basic)**
  through git's credential helper; no bearer header. (req 6)
- 2026-09-30 — Egress for the agent's own `git lfs`? **Existing egress
  controls:** declaring the host opens nothing, and the docs tell the user what
  to allow. (req 13)
- 2026-09-30 — Also cover the shared LFS store's background fill and the diff
  viewer? **Yes, every ShipIt-side LFS transfer.** (req 9)
