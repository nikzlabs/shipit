---
issue: https://linear.app/shipit-ai/issue/SHI-162
title: Create a repository in an organization
description: Let users create a new GitHub repo under an organization they belong to, not just their personal account.
---

# Create a repository in an organization

## What this is

The "Create New Repository" flow (`NewRepoDialog`) historically created repos
only under the authenticated user's personal account (`POST /user/repos`). This
feature adds an **owner picker** so a user who belongs to one or more GitHub
organizations can scaffold the new repo *inside* an org instead
(`POST /orgs/{org}/repos`).

Everything downstream of repo creation is owner-agnostic — the scaffold push,
the bare cache seed, and the warm session all work off the returned clone URL —
so the change is deliberately narrow: thread an `owner` through and switch the
one API endpoint.

## Inline, not link-out

Per product principle §2/§3: the user never visits `github.com/organizations/new`
to do this. They pick the owner from a dropdown inside the dialog. (Creating a
*new* org still lives on GitHub — that's a legitimate §3 account/settings page —
but creating a repo *into* an existing org is fully inline.)

## Flow

```
NewRepoDialog (owner dropdown) ──onSubmit(name,desc,priv,tmpl,owner)──▶
   POST /api/repos { repoName, description, isPrivate, templateId, owner? }
                                  │
                                  ▼
              createRepoWithTemplate(..., owner?)   (services/templates.ts)
                                  │
                                  ▼
        githubAuthManager.createRepo(name, { description, isPrivate, owner? })
                                  │
              owner ? POST /orgs/{owner}/repos : POST /user/repos
```

The owner dropdown is populated from `GET /api/github/orgs`, fetched lazily when
the dialog opens (alongside the templates fetch in `App.tsx`).

## Org-permission handling

We list **every** org the user is a member of (`GET /user/orgs`) without
pre-checking repo-creation rights. If the user picks an org where org policy
restricts repo creation to admins, GitHub answers `403` and the message is
surfaced verbatim in a toast. Rationale: pre-filtering would cost an N+1 of
per-org membership/settings calls on every dialog open, and org membership
usually implies create rights — so the rare 403 is cheaper to explain than to
prevent. (Settled tradeoff; see the original request thread.)

The personal account is the default selection and sends **no** `owner`, so it
keeps hitting `POST /user/repos`. The client sends `owner` only for a real org,
and the server defensively drops an empty/whitespace owner — a username must
never reach `POST /orgs/{owner}/repos` (it would 404/422).

## Key files

- `src/server/orchestrator/github-auth-repos.ts` — `createRepo` endpoint switch
  on `options.owner`; new `listOrgs(token)` → `GET /user/orgs`.
- `src/server/orchestrator/github-auth.ts` — `createRepo` wrapper `owner` option;
  new `listOrgs()` method; re-export.
- `src/server/orchestrator/services/github.ts` — `listGitHubOrgs(mgr)` service.
- `src/server/orchestrator/api-routes-github.ts` — `GET /api/github/orgs` route.
- `src/server/orchestrator/services/templates.ts` — `createRepoWithTemplate`
  `owner?` param, trimmed and forwarded to `createRepo`.
- `src/server/orchestrator/api-routes-session.ts` — `POST /api/repos` body `owner?`.
- `src/client/components/NewRepoDialog.tsx` — owner `<select>` (personal + orgs),
  shown only when the user has ≥1 org; `onSubmit` gains the `owner` arg.
- `src/client/App.tsx` — fetch `/api/github/orgs` on dialog open, pass `orgs`,
  thread `owner` into the `POST /api/repos` body.

## Tests

- `github-auth.test.ts` — `createRepo` URL routing (personal vs org); `listOrgs`
  mapping, unauthenticated `[]`, non-OK `[]`.
- `services/templates.test.ts` — owner trimmed + forwarded; empty owner omitted.
- `integration_tests/repos.test.ts` — `GET /api/github/orgs` (unauth + authed).
- `integration_tests/home-screen.test.ts` — full `POST /api/repos` route threads
  `owner` to `createRepo` and namespaces the repo URL under the org.
- `NewRepoDialog.test.tsx` — picker hidden with no orgs; rendered with orgs;
  selected org passed as `owner`, personal account passes `undefined`.
