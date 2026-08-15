---
issue: planning#355
title: Plugin repositories — the real-instance end-to-end
description: The one verification that needs a real Docker deployment, as an ordered checklist with pass criteria and failure modes.
---

# Plugin repositories — the real-instance end-to-end

Everything else in `checklist.md` is verified by tests or by the dogfood inner
instance. This one cannot be: **local mode has no plugin containers at all**, so
the install container, the companion-CLI invocation container, the plugin
service, every mount they carry and every egress rule around them exist only on
a real Docker deployment. `plan.md` §5 names it as the once-per-milestone check.

Run this against a **real ShipIt deployment** — not a session container, not the
`dev` Compose service. A human or an agent can execute it.

## Why these steps and not others

Four things fail *only* in production, and each step below exists to reach one
of them:

1. **volume+Subpath mounts.** The per-session tree lives in a named volume in
   production, so a plain bind of an orchestrator path silently yields an empty,
   root-owned directory. Dev and dogfood have real paths and look perfect.
2. **The plugin service container actually starting.** The integration tests fake
   Docker and the Compose CLI, so nothing in the suite proves a container comes
   up.
3. **Egress containment.** The tiers are iptables, dnsmasq and an SNI proxy in a
   real namespace. Unit tests assert the composition and ordering around the
   launchers, never their behaviour.
4. **The agent-facing verbs through the shim.** The dogfood image ships the `gh`
   shim and deliberately not the `shipit` one (planning#305), so `shipit plugin
   refresh` and a generated wrapper can only be driven over HTTP there.

## Setup

Use this repository's own `test-plugin/` fixture. Every export is a probe: it
reports what it finds rather than asserting, so a contract regression shows up
as a changed field.

Two fixtures, because self-use deliberately has no checkout, generation or
refresh (req 27):

| Fixture | Declaration | What it exercises |
|---|---|---|
| **self** | this repo's own `shipit.yaml`, `repo: self`, name `shipit-dev` | the live working-tree path |
| **consumer** | a separate project declaring `nikzlabs/shipit` by `owner/name` | checkout, generation, pin, refresh, install |

For the consumer fixture, add to that project's `shipit.yaml`:

```yaml
plugins:
  repos:
    - repo: nikzlabs/shipit
      name: shipit-dev
      branch: main
  use:
    - plugin: probe
      from: shipit-dev
```

The probe's report is available three ways: `probe` (the companion CLI, prints
JSON), `GET /report.json` on the service, and the service's HTML page.

---

## 1. Activation and identity

Open a session on the **consumer** project.

- **Do:** open the Plugins tab.
- **PASS:** the card reads `active`, names `nikzlabs/shipit`, the ref, and an
  exact commit. `PROBE_TOKEN` shows as a credential the project has not set.
  `example.com` shows either as allowed or as not-yet-allowed with **Allow for
  session** / **Allow for ShipIt** buttons — which of the two depends on whether
  the session is Contained.
- **Failure modes:** `degraded` with a fetch error means the App installation or
  PAT does not reach the repository (req 6/10). A card with no host row on a
  Contained session means requirement 24's visibility half is not resolving —
  check `pluginHostAllowance`. A ref and commit that do not correspond is the
  defect #2265 closed; both must come from the same generation record.

## 2. The install container, and the dependency store

- **Do:** watch the card while the first activation runs, then push a commit to
  the plugin repository that leaves `test-plugin/install.mjs` unchanged, and run
  `shipit plugin refresh shipit-dev` in the session.
- **PASS:** the first activation runs the install. The refresh moves to the new
  commit and **runs no install container at all** — the dependency store's
  content key did not change, so the base is adopted (req 28).
- **Then:** change `install.mjs` and refresh again. **PASS:** an install runs
  once, and a *second* session on the same project moving to that commit runs
  none.
- **Failure modes:** an install on every commit means the store is not being
  adopted — check the scope key, which must be `plugin:<destinationKey(source)>`
  and never the declaration name. An install that fails and *still* publishes is
  a req 15 violation: the previous commit must stay live and whole.

## 3. The companion CLI — the wrapper, the mounts, the shared state

- **Do:** in the session's terminal or via the agent, run `probe`.
- **PASS:** it prints a JSON report with `mode: consumer-generation`, a non-null
  `SHIPIT_PLUGIN_COMMIT` equal to the card's commit, and
  `install.matchesActiveCommit: true`.
- **This is the step that catches the production-only mount bug.** In the report,
  `/project`, the state directory and the settings file must all be **present**.
  An empty or missing one is the volume+Subpath defect: a bind was used where a
  volume subpath was required, which looks correct in dev and yields an empty
  root-owned directory here.
- **Do:** run `probe --bump`, then open the service page (step 4) and read the
  counter; then press **Increment** on the page and run `probe` again.
- **PASS:** the counter is the same number on both surfaces and moves in both
  directions. That is the shared state directory working across the CLI and the
  service (req 18).
- **Failure modes:** `501 … no container runtime` is the wiring defect #2263
  fixed — the route hook is not forwarded. A wrapper that is not on `PATH` at all
  means the container prepare pass did not run or a command collision withheld
  it; the card names a collision when that is the cause.

## 4. The plugin service, and the preview

- **Do:** open the preview for the `probe` service.
- **PASS:** the page renders, shows the `greeting` setting's value, and the
  report on it agrees with the CLI's. The published port is stable — note it, and
  confirm at step 7 that it does not move.
- **PASS:** the page's own report shows the service received `PROBE_TOKEN` once
  the project sets it (step 6), not merely that the card calls it satisfied.
- **Failure modes:** a container that never starts is usually the fragment
  failing validation — the card carries the collector's own message. A service
  that starts with an empty `/app` is the mount defect again. A preview that 404s
  with the service running is the origin/published-port mapping.

## 5. Egress containment — the declared host and an undeclared one

Do this on a **Contained** session; on an Open session there is nothing to
enforce and the card correctly shows no host rows.

- **Do:** with `example.com` **not** allowed, run `probe --host-check`.
- **PASS:** the call fails the way the agent's own call to a non-allowlisted host
  fails, and the failure names the host.
- **Do:** press **Allow for session** on the card, then run `probe --host-check`
  again.
- **PASS:** it now succeeds. This is the claim that enforcement and the card
  cannot disagree — they read the same seam.
- **Do:** from inside the plugin service, try a host the plugin never declared.
- **PASS:** it is refused. A plugin's declaration is informational; it grants
  nothing (req 24).
- **Failure modes:** a host-check that succeeds while unallowed means the CLI
  container is not contained — check that `preparePluginNetns` built a holder
  rather than joining the plain plugin network. A success *after* the grant that
  needs a session restart is the stated instance-scope limit, not a failure:
  confirm which scope you pressed.

## 6. Credentials

- **Do:** set `PROBE_TOKEN` in the **consuming project's** secrets.
- **PASS:** the card flips to satisfied, and both the CLI report and the service
  report show the value arrived. Restart is not required for the CLI; an `auto`
  service is re-upped, a `manual` one keeps what it started with (a stated
  limit).
- **Failure modes:** the card satisfied while the service receives nothing is the
  exact defect #2264 closed — check the generated override, not the card.

## 7. Skills, and the agent

- **Do:** ask the agent what skills it has, or check its skill roots.
- **PASS:** the probe skill is present, namespaced `plugins--<alias>--probe`, in
  **every** harness root (`.claude/` and `.codex/`) — requirement 22's backend
  independence. `git status` in the workspace is clean: the copies are excluded
  from this clone's git, not added to it.
- **Do:** remove the `use:` entry and reopen the session.
- **PASS:** the skill, the wrapper and the service are all gone.

## 8. `window.shipit` — the browser-to-agent hop

- **Do:** on the service page, read the *Agent Interface SDK* line, then press the
  button that sends the counter to the agent.
- **PASS:** the page reports the SDK as ready and embedded, and a message from
  the page arrives in the session's chat carrying the counter value.
- **Failure modes:** an SDK line that never resolves means the page is not being
  served through the preview proxy — check the origin, not the page.

## 9. Refresh, degradation, and identity

- **Do:** point the declaration at a ref that does not exist, and refresh.
- **PASS:** `shipit plugin refresh` exits **non-zero** and names the commit still
  live. The card reads `degraded`, the previous version keeps serving — the
  service stays up, the CLI still runs, the skill is still there — and the reason
  is the named one (`… is not a branch, tag or commit in …`), not `git
  rev-parse`'s argument-syntax advice.
- **Do:** re-point the declaration at a **different repository** under the same
  local name.
- **PASS:** nothing from the previous repository survives — no `/plugins/<name>`
  link to its files, no skill, no command. This is the identity guard; a
  generation records the repository it was built from.

## 10. The self fixture

Open a session on **this** repository.

- **PASS:** the card reads `self` with no ref/commit chip. `probe` reports
  `mode: self-or-unprovided` and **no** `SHIPIT_PLUGIN_COMMIT` — a live working
  tree corresponds to no exact commit. The skill is materialized. There is
  deliberately **no** `/plugins/shipit-dev` link: the agent already has the tree.
- **PASS:** `shipit plugin refresh shipit-dev` is **refused** — there is no
  version to move to.
- **PASS:** editing the plugin's source in the working tree changes what the CLI
  and the service do, with no refresh. What ShipIt *copies* rather than reads
  live — the skill, the wrapper — is re-applied on the next activation round, not
  on the edit.

---

## Recording the result

A pass is not "it worked". Record, per step, what the report actually said —
the commit, the mode, the counter, the mount presence. The probe exists so that
a regression is a **changed field**, not a judgement call, and a run that only
says "fine" cannot be compared with the next one.

Anything that fails belongs in `checklist.md` with the same treatment every
other finding in this feature got: what the defect is, why it was reachable, and
what the fix does or does not close.
