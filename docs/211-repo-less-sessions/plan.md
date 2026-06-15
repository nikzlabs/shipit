---
issue: https://linear.app/shipit-ai/issue/SHI-161/repo-less-sessions-support-for-multi-repo-multi-pr-agent-work
title: Repo-Less Sessions
description: Session identity can exist independently from a primary repository, with explicit repo and PR attachments.
---

# Repo-Less Sessions

## Problem

ShipIt historically treated `sessions.remote_url` as both the session's primary
workspace repo and the session's product identity. That breaks cross-repo work:
an agent may need to inspect one repo, patch another, and coordinate several PRs
without making any single repo the owner of the conversation, logs, artifacts,
or status.

## Model

`sessions.remote_url` remains the compatibility field for repo-bound sessions.
Repo-less and multi-repo sessions use `session_repo_attachments` to record every
repository or pull request explicitly associated with a session.

Each attachment has:

- `kind`: `repo` or `pull_request`
- `repo_url`: the Git remote URL
- `pr_number`: present for PR attachments
- `permission`: `read` or `write`
- `trust`: `trusted` or `untrusted`

Session reads hydrate `SessionInfo.repoAttachments`. Existing repo-bound
sessions automatically expose their `remoteUrl` as a synthetic trusted/write
repo attachment, so old flows do not need to write duplicate rows.

## API

- `POST /api/sessions` creates a repo-less, git-initialized session with no
  primary remote.
- `POST /api/sessions/:id/repo-attachments` attaches repo/PR metadata.
- `DELETE /api/sessions/:id/repo-attachments` detaches repo/PR metadata.

Attach/detach broadcasts `session_list` so all clients reconcile sidebar state.

## UI

The sidebar labels sessions with no primary remote as `Repo-less sessions`.
Rows show compact chips for secondary attached repos and PRs, for example
`api` or `web#42`.

## Deferred Work

This change establishes the product/data contract. Actual multi-checkout mounts,
agent-facing attached-repo tooling, and per-attachment trust prompts are still
separate work.
