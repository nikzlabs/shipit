---
issue: nikzlabs/shipit#1912
title: Images in pull request bodies
description: Why an agent cannot attach an image to a pull request, and what it does instead.
---

# 247 — Images in pull request bodies: requirements

Source: [nikzlabs/shipit#1912](https://github.com/nikzlabs/shipit/issues/1912) — "let the agent attach images to a PR body via the gh shim".

The design that implements these requirements is in [`plan.md`](./plan.md).

The issue asked for a way to publish an image so it renders in a pull request. Research established that GitHub offers no such mechanism to a token-authenticated client (see [`plan.md`](./plan.md) for the evidence). The human chose to document the gap rather than build a partial mechanism, so what follows is the requirements for the documentation, and the original ask is recorded below it as not delivered.

## Requirements

1. An agent asked to put screenshots in a pull request learns that this is not possible from the pull-request documentation it reads when doing pull-request work — at the latest when it goes looking for an attach verb, rather than after trying and failing. It does not learn this from the always-on instructions: see the resolved question below for why that was rejected.

2. The agent is told **why** it is not possible, in enough detail that it does not go looking for a workaround, try `gh api`, or conclude it used the tool wrong.

3. The agent is told what to do instead, so a request to "show me the before and after" still gets a useful answer.

4. A pull request never ships a broken image, and the agent is told not to commit throwaway screenshots into the project to work around the gap.

## Asked for but not delivered

The issue's actual request — publishing an image so it renders inline in a pull request body or comment — is not delivered, and cannot be with the credentials ShipIt holds:

- The only image URL that renders inline in a pull request regardless of repository visibility is `github.com/user-attachments/assets/…`, produced only by the browser's drag-and-drop upload. That endpoint authenticates with a `user_session` cookie and rejects personal access tokens and OAuth tokens; there is no REST or GraphQL equivalent.
- A URL pointing at a blob in the repository renders only for a **public** repository. GitHub fetches images through an unauthenticated proxy, so on a private repository it renders broken for every reviewer.
- ShipIt hosting the image itself does not work either: deployments sit behind Cloudflare Zero Trust by default and self-hosted ones are not publicly reachable, so GitHub's proxy cannot fetch them.

If GitHub ever ships an attachment API, the shape to build is in the resolved questions below.

## Resolved questions

- 2026-08-03 — Should the "you can't attach an image" warning go in the always-on pull-request instructions, so an agent knows before it starts a visual task, or only in the on-demand documentation? **Chosen: documentation only** — "it happened only once when an agent wanted to attach an image, so not worth polluting the prompt". The always-on instructions are paid for by every turn of every session; this task shape is rare enough that it doesn't earn a permanent line there. Requirement 1 was weakened to match: the agent finds out when it reads the pull-request docs, which is later than "before it starts" but still before it ships a broken image.

- 2026-08-03 — Given that publishing works only for public repositories, should ShipIt ship it for public repositories with a clear refusal on private ones, or document the gap and build nothing? **Chosen: document the gap and build nothing**, and close the issue. Requirements 1–5 of the original draft (publish an image; the same for comments; no token handling; no repository pollution; the URL outlives the session) were dropped and are recorded under "Asked for but not delivered" above; the surviving requirements are the documentation ones, renumbered 1–4.
- 2026-08-03 — Where would the image bytes live (a side branch in the project repository, or a separate per-user assets repository)? **Moot** — nothing is being published. Recorded so a future attempt starts from the same two options rather than re-deriving them.
- 2026-08-03 — What would the agent call (`shipit upload <path>` printing a URL, `--attach` on the `gh pr` commands, or both)? **Moot** — nothing is being published. If this is revisited, the single upload verb was the recommendation: it composes with every markdown surface the agent writes and needs no placeholder-rewriting.
