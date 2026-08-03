---
issue: nikzlabs/shipit#1912
title: Images in pull request bodies
description: Why an agent cannot attach an image to a pull request, and what it does instead.
---

# 247 — Images in pull request bodies

Implements [`requirements.md`](./requirements.md).

This feature is documentation. Nothing was built, because nothing can be: there is no path from a token-authenticated client to an image that renders in a GitHub pull request. This document records the evidence for that, so the question does not have to be re-derived the next time an agent is asked for before/after screenshots.

## The constraint

Four routes exist in principle. All four are closed.

**1. GitHub's own attachment upload.** The URLs that render inline in a pull request regardless of repository visibility are `github.com/user-attachments/assets/<uuid>`. They are produced by one endpoint, `github.com/upload/policies/assets`, which the web UI calls on drag-and-drop. It authenticates with a logged-in `user_session` cookie and returns 422 for a PAT or OAuth token. There is no documented REST or GraphQL equivalent, and the community request for one is open and unanswered by GitHub ([community#29993](https://github.com/orgs/community/discussions/29993), [cli/cli#13256](https://github.com/cli/cli/issues/13256)). This is why the issue's premise — that `gh api` would have unlocked it — does not hold: unblocking `gh api` would change nothing.

**2. A blob in the repository, referenced by raw URL.** Works for a **public** repository: GitHub renders markdown images through an unauthenticated proxy, which can fetch `raw.githubusercontent.com` for public content. For a **private** repository the proxy cannot authenticate, so the image renders broken for every reviewer. Since ShipIt sessions run against private repositories routinely, a mechanism that works on public repositories only would fail silently in the common case — and "silently" is the problem: the agent would have no way to know, and the pull request would ship a broken image.

**3. ShipIt hosting the image.** ShipIt would have to serve the file at a URL GitHub's proxy can fetch anonymously. It cannot: `deployment/vps/cloudflare.sh` puts deployments behind Cloudflare Zero Trust by default and refuses to leave the tunnel publicly routed if Zero Trust setup does not complete, and self-hosted or localhost instances are not reachable from the internet at all. The URL would also stop working when the instance goes away, long before reviewers stop reading the pull request.

**4. Committing screenshots into the branch.** This is what the issue explicitly asked to avoid, and it does not even work: on a private repository the images still do not render, and on any repository they land in the diff and the project's permanent history.

## What was built

Documentation in two on-demand docs, and **deliberately nothing in the always-on prompt**:

- **`src/server/shipit-docs/github.md`** — a short "Images in a PR (not possible)" section placed directly after the supported-subcommands table, where an agent looking for an attach verb will land. Says all routes are closed and why in one paragraph, so an agent that has started hunting stops rather than reaching for `gh api` (requirement 2), then the alternatives (requirement 3) and the explicit "don't commit throwaway screenshots" (requirement 4). The `gh api` entry under "intentionally unavailable" cross-references it, since that is the bullet the issue's author reasoned from.
- **`src/server/shipit-docs/present.md`** — a one-line cross-reference from the `present` tool's before/after guidance, because an agent that has just produced a before/after pair is exactly the one about to try to attach it.

An earlier revision also put a two-sentence warning in `prompts/pull-requests.md`, the always-on PR instructions, so an agent would know *before* starting a visual task. That was removed: the always-on prompt is paid for by every turn of every session, and this has come up once. The cost of finding out late is one turn of rework, not a broken pull request. `prompts/pull-requests.md` is unchanged by this feature.

## What to do instead

The substitute is not a consolation prize when the person asking is the ShipIt user: `present` puts the images in front of them in the session, which is where they already are. What is genuinely lost is the *GitHub reviewer's* view of a visual change, and there the only remedy is a precise prose description in the pull request body.

## If GitHub ships an attachment API

The design questions were worked through before the decision to document instead of build, and are recorded in [`requirements.md`](./requirements.md) under "Resolved questions" so a future attempt starts there. In short: a single `shipit upload <path>` that prints a URL was preferred over `--attach` flags on the `gh pr` subcommands, because it composes with every markdown surface the agent writes and needs no placeholder-rewriting.

Note for whoever picks that up: there is currently **no container → orchestrator file-upload path at all**. Every `/agent-ops/*` route is JSON-only, and `/uploads` is mounted read-only into the container. The nearest precedent is the `present` flow, which sends a path and lets the orchestrator pull the bytes back from the worker (`ContainerSessionRunner.proxyPresentRaw`) rather than pushing them from the container.

## Key files

| File | Role |
|---|---|
| `src/server/shipit-docs/github.md` | Agent-facing `gh` reference; the constraint and the alternatives |
| `src/server/shipit-docs/present.md` | Cross-reference from the before/after guidance |

`src/server/orchestrator/prompts/pull-requests.md` is intentionally **not** in this list — see "What was built".
