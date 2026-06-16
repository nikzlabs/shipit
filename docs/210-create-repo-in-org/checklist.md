# Checklist — Create a repository in an organization

- [x] `createRepo` switches to `POST /orgs/{owner}/repos` when an owner is given
- [x] `listOrgs(token)` + `GitHubAuthManager.listOrgs()` + re-export
- [x] `listGitHubOrgs` service + `GET /api/github/orgs` route
- [x] `createRepoWithTemplate` threads a trimmed `owner` (omits empty)
- [x] `POST /api/repos` accepts and forwards `owner`
- [x] `NewRepoDialog` owner dropdown (personal + orgs), `onSubmit` owner arg
- [x] `App.tsx` fetches orgs on dialog open and sends `owner`
- [x] Unit tests: createRepo routing, listOrgs
- [x] Service test: owner threading
- [x] Integration tests: orgs route + full create-repo route owner threading
- [x] Component tests: owner picker render + submit
- [x] Typecheck + lint clean
