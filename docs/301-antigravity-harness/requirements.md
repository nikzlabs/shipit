---
title: Antigravity CLI harness — requirements
description: Google's Antigravity CLI (`agy`, binary `antigravity`) as a ShipIt harness with Google account sign-in and metered GEMINI_API_KEY, integrated per the docs/266 recipe.
issue: planning#543
---

# Antigravity CLI harness — requirements

Requirements for integrating Google's Antigravity CLI (`agy`, binary
`antigravity`, assessed on release 1.2.2) as a ShipIt harness, alongside
Claude Code, Codex, OpenCode and Grok Build. The integration follows
[docs/266-harness-integration-recipe/plan.md](../266-harness-integration-recipe/plan.md)
and its
[integration-checklist.md](../266-harness-integration-recipe/integration-checklist.md);
the candidate assessment with the probe evidence is the Antigravity section of
[candidates.md](../266-harness-integration-recipe/candidates.md). This doc
holds what the feature must do. There is no `plan.md` yet: the open questions
below block design and code.

Source of the decisions below: the user's messages in the assessing session
(2026-09-13) and the follow-up action the user approved from that session.
Anything the user did not say is under "Open questions".

## Requirements

1. **Fifth harness.** Antigravity CLI is available as a harness wherever a
   harness can be selected — session creation, model picking, roles — on
   installs that include it in `SHIPIT_HARNESSES`.
2. **Google account sign-in.** A user can authenticate Antigravity with their
   Google account from inside ShipIt. Sessions on this harness then run on the
   stored account credential without a second sign-in, including sessions that
   start in a fresh container. (Basis: the credential is a plain token file in
   the CLI's config home, and a fresh process authenticates from a byte-copy of
   that home; probed on 1.2.2, see candidates.md.)
3. **Metered key.** A user can instead supply a Gemini API key
   (`GEMINI_API_KEY`) in Settings → Model providers, and Antigravity sessions
   run on it. A connected account ranks above the key, as for every other
   harness.
4. **Google's refusal text reaches the user verbatim.** When Google refuses an
   account after sign-in (observed 2026-09-13: *"Eligibility check failed: Your
   current account is not eligible for Antigravity. To use Antigravity you must
   be 18 years old or older. If you think you are receiving this message in
   error, please ensure you have verified your age and try to log in again."*),
   ShipIt shows Google's own sentence to the user. The generic per-harness
   message in `src/server/orchestrator/services/agent-auth-gate.ts` must not
   replace it, because that generic copy hides the sentence that names the fix.
5. **Pinned install.** The binary is installed at one exact version and the
   image's installed-set report names the harness, so ShipIt treats it as
   installed. Runtime version stability holds: the CLI's own auto-updater
   never replaces the pinned binary. (Basis: on 1.2.2 the updater skips itself
   when the install directory is not writable — log line
   `auto_updater.go: Directory … is not fully accessible (readable: true,
   writable: false), skipping update`; probed once, 2026-09-13.)
6. **Recipe discipline.** Every step of the docs/266 recipe is worked,
   including the silent-sites list, and every declared capability flag is
   honest — confirmed against observed CLI behaviour, not documentation. The
   Phase 0 items candidates.md leaves unknown (`/compact` on a resumed
   session, plugin-based prompt/MCP/skills loading, skills disclosure) are
   measured before the flags are set.
7. **Catalogue before harness.** Gemini's wire format and Google's vendor row
   exist in the model catalogue before this harness declares them
   (docs/302-gemini-catalogue-vendor, a separate feature).

## Open questions

- **Install path.** The CLI is a ~213 MB Go binary shipped as a per-version
  GitHub release tarball, not an npm package, so the `docker/agent-cli`
  pipeline cannot install it. docs/266 says a non-npm CLI is a design decision
  to surface, not to improvise. Which path: a non-npm branch in
  `install-agent-clis.sh` that downloads the pinned tarball into a root-owned,
  read-only directory and writes the id into `installed.json` (the read-only
  directory is also what disables the updater, req 5); or wait for an npm
  package from Google; or leave the harness out of the image and let the
  operator install it?
- **Guarded mode.** In print mode the CLI soft-denies a tool that needs
  approval and continues; there is no permission-prompt MCP tool. The
  documented `PreToolUse` hook returns allow/deny/ask synchronously and is the
  candidate for ShipIt's guarded permission mode, unprobed. Ship full-auto only
  at launch, or make guarded mode via the hook part of this feature?
- **Sign-in flow.** The CLI runs the Google sign-in itself in print mode: it
  prints the URL on stderr, and the user pastes the authorization code from
  Google's callback page back into the CLI's stdin within 60 seconds. ShipIt's
  existing login integrations are device-code shaped (ShipIt shows a URL and a
  code; the user enters the code on the vendor's page). Which shape: a new
  login integration that shows the URL and offers a code field inside ShipIt
  with the 60-second window visible; or key-only at launch, account sign-in
  later; or the user signs in elsewhere and uploads the token file?
- **MCP tool labels.** MCP tools do not appear in the CLI's `init.tools`; the
  agent calls them through one `call_mcp_tool` wrapper. How the wrapper's
  arguments map to ShipIt's tool-activity labels is unprobed. This one is
  answerable by a probe at design time, not by a decision.

## Resolved questions

- 2026-09-13 — Do the Antigravity Additional Terms of Service §6 ("using third
  party software, tools, or services to access the Service, e.g. using
  OpenClaw with Antigravity OAuth") block ShipIt? The user's reading: no. The
  example is a third-party client using the OAuth token directly; ShipIt
  spawns Google's own CLI as the only client, the shape of ShipIt's Claude
  Code subscription use. Recorded as the user's reading; the section grants
  nothing expressly.
- 2026-09-13 — Google refused the user's own account once (age verification).
  The user: "we need to make sure to expose this text to the user". Recorded
  as requirement 4.
- 2026-09-13 — Does account auth work from the token file in a container with
  no keyring (upstream issue #479 says the file is write-only)? Resolved
  empirically on 1.2.2, not by a human: a fresh process on a byte-copied home
  answered from the file alone. Basis of requirement 2.
- 2026-09-13 — Can the auto-updater be stopped? Resolved empirically on 1.2.2,
  not by a human: a read-only install directory makes the updater skip itself.
  Basis of requirement 5's runtime half.
