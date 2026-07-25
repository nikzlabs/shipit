# Projects — implementation checklist

## Phase 1 — core scoping

- [ ] `projects` table + `ProjectRegistry` + Default-project boot migration
- [ ] `project_id` on `sessions`; `repos` PK rebuild to `(project_id, url)`; `secrets` rebuild to `(project_id, repo_url, key)`; migration test over a populated fixture DB
- [ ] Request→Project resolution helper (sessionId-first precedence) wired through routes/services
- [ ] `sseBroadcast` scope argument + per-client project registration + scoped bootstrap snapshot
- [ ] `/api/projects` CRUD routes
- [ ] Client: `useProjectStore`, sidebar switcher, blind switch (store reset + SSE reconnect)
- [ ] Linear binding per project (tracker registry binds from project credentials)
- [ ] GitHub identity + git author per project

## Phase 2 — config surfaces

- [ ] Settings + system prompt per project (host-resource knobs stay global)
- [ ] MCP servers + OAuth per project
- [ ] Egress `project:<id>` scope tier

## Phase 3 — agent credentials

- [ ] Claude/Codex auth, `agentEnv`, provider accounts per project (credential blob split + `.bak` migration)
- [ ] Token sync + limits pills resolve via the session's project

## Phase 4 — reporting & lifecycle

- [ ] `usage_turns.project_id` + per-project usage reporting
- [ ] Per-project reset (rows + credential dir); deployment `clearAll()` unchanged
- [ ] Repo-memory scoping `repo-memory/<projectId>/<repoHash>/`
- [ ] localStorage namespacing for per-project UI state
