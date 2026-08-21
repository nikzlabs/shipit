---
issue: nikzlabs/shipit#2411
title: A live plugin version can be re-installed
description: Activation installs what the current declaration selects, and a forced re-install is never blocked by the plugin's own service.
---

# Requirements

From nikzlabs/shipit#2411, filed from a session whose plugin repository was
swapped from `repo: self` to a real GitHub repository mid-session. The
activation published the new commit and never ran its `install`; the plugin's
CLI and its service were both broken for the rest of the session, and the
documented recovery (`shipit plugin refresh <name> --force`) was refused every
time by the very service it would have fixed.

Numbered statements are what the feature must do, in the reporter's terms.

1. When the declaration changes so that a plugin repository is selected for an
   export whose `install` has not run for the version that is live, ShipIt runs
   that install — without being asked, on the same round that reads the changed
   declaration. Not moving the commit is not a reason to skip it.

2. `shipit plugin refresh <name> --force` re-runs the install for the version
   already live **while that plugin's own service and companion CLI are using
   it**. It is the documented recovery from "a version is live but unusable",
   and the thing that makes a version unusable is characteristically the thing
   holding it.

3. Neither of the above requires the user to stop a service, edit `autostart`,
   wait, or retry. The reporter tried all four for twenty minutes.

4. A re-install that cannot complete leaves the plugin exactly as it found it.
   A refused or failed recovery must never move a repository from `active,
   usable` to `degraded, NOT USABLE`.

5. The version that is live keeps serving until a re-install has succeeded, and
   is then replaced coherently — never half-replaced under a running container
   (docs/262 req 15, restated here because a re-install is the case it was
   never applied to).

6. Every one of these is reachable from inside the session. Ending the session
   and starting a new one is not a recovery path.

## Open questions

None. Everything the reporter asked for is stated above; the choices the report
does not speak to (how a rebuild is named on disk, what happens to generations
published before this change) are design, and live in `plan.md`.

## Resolved questions

_None yet._
