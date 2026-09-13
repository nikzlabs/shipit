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
holds what the feature must do; [plan.md](./plan.md) implements it and
[checklist.md](./checklist.md) tracks the branch work.

Source of the decisions below: the user's messages in the assessing session
(2026-09-13) and the follow-up action the user approved from that session.
Anything the user did not say is under "Open questions".

## Requirements

1. **Fifth harness.** Antigravity CLI is available as a harness wherever a
   harness can be selected — session creation, model picking, roles — on
   installs that include it in `SHIPIT_HARNESSES`.
2. **Google account sign-in.** A user can authenticate Antigravity with their
   Google account from inside ShipIt, the same way as for Claude Code: ShipIt
   shows the sign-in link the CLI prints, the user signs in with Google, pastes
   the authorization code into ShipIt, and ShipIt hands it to the CLI. Sessions
   on this harness then run on the stored account credential without a second
   sign-in, including sessions that start in a fresh container. (Basis: the credential is a plain token file in
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
5. **Pinned install, same script as the other harnesses.** The binary is
   installed by the same install script that installs the other harnesses,
   at one exact version, and the image's installed-set report names the
   harness, so ShipIt treats it as installed. Runtime version stability holds: the CLI's own auto-updater
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
8. **Full-auto only at launch.** Sessions on this harness run with the CLI's
   skip-permissions flag; the permission-mode selector offers only full-auto
   for it. A guarded mode (the CLI's documented `PreToolUse` hook is the
   candidate) is a separate follow-up feature, not part of this one.

## Open questions

None.

## Resolved questions

- 2026-09-13 — How does a `call_mcp_tool` call map to ShipIt's tool-activity
  labels? Resolved empirically on 1.2.2, not by a human (key mode,
  `gemini-3.8-flash-low`; capture `probes/global-mcp.ndjson`): the wrapper's
  `tool` step carries `tool_info.parameters.{ServerName, ToolName, Arguments}`
  and, on the `DONE` step, `tool_info.output` — everything a label needs.
  The `init.tools` list does name `call_mcp_tool` (57 built-in tools). Design
  in plan.md.
- 2026-09-13 — The Phase 0 items requirement 6 names as unknown, resolved
  empirically on 1.2.2, not by a human (all captures under `probes/`):
  `/compact` on a resumed headless conversation reaches the model as plain
  user text — no summary step, transcript unchanged (`compact-b.ndjson`), so
  `supportsCompaction` is `false` (probed); a plugin in the config home loads
  rules, MCP servers and skills **only after `antigravity plugin install
  <path>`** (a bare directory is treated as uninstalled), after which all
  three were observed live (`plugin-rules`, `plugin-mcp`, `plugin-skill`);
  a workspace `AGENTS.md`/`CLAUDE.md` and workspace `.claude/skills`,
  `.agents/skills`, `.gemini/skills` were **not** disclosed in a headless
  turn (`skills.ndjson`) — plugin skills were. Basis of plan.md's plugin
  design.
- 2026-09-13 — The metered key the user saved is a Google free-tier key:
  Google answers 429 with `limit: 0` for `gemini-3.1-pro` and 5 requests per
  minute / 20 per day for each flash model, per model. The probes ran on the
  flash models. A ShipIt session on this harness needs a paid-tier key or an
  account; the 429 text is Google's own and reaches the user through the
  turn's error row (plan.md).

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
- 2026-09-13 — Install path for a ~213 MB Go binary shipped as a per-version
  GitHub release tarball, not an npm package (the agent offered: a non-npm
  branch in the image's install script; wait for an npm package; operator
  installs)? The user: "same as other harnesses: installed on the host via the
  same script". Requirement 5 reworded; how the script fetches a non-npm
  artefact is design (plan.md).
- 2026-09-13 — Guarded mode via the `PreToolUse` hook, or full-auto only? The
  user: full-auto only at launch. Requirement 8 added.
- 2026-09-13 — Sign-in flow: the CLI prints the Google URL and reads the
  authorization code from stdin within 60 seconds. The user: "same as we do
  for claude". Claude Code's login in ShipIt is that same code-paste shape
  (ShipIt shows the URL, the user pastes the code into ShipIt, ShipIt writes
  it to the CLI). Requirement 2 reworded to name it. The agent's question had
  described ShipIt's logins as device-code shaped; that is Grok's, not
  Claude's.
