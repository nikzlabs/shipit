# 097 — Explicit Session-Agent Permissions — Checklist

- [x] Decide between Option A (baked-in image), B (host mount), or C (`--settings` CLI flag). **Option A**, reusing the existing baked `managed-settings.json` (already passed via `--settings`).
- [x] Land the policy — `permissions.allow`/`permissions.deny` added to `docker/agent-hooks/managed-settings.json` (no new file needed).
- [x] Wire it into the chosen path — already wired: `--settings /etc/shipit/managed-settings.json` is passed on every Claude spawn; the Dockerfiles already `COPY` the file.
- [x] Add a test asserting the policy holds — `src/server/session/agent-shim/managed-settings.test.ts` (file-contract test; the integration harness can't run the real CLI, so this is the schema-drift guard).
- [x] Verify existing session-worker / run-params tests still pass.
- [x] Lint, typecheck, `test:dev`.
- [x] Document write-protected paths in agent-facing `shipit-docs/environment.md`.

## Resolved discussion items

- **`Bash(*)` stays broad.** Git auto-commit makes destructive edits recoverable; deny rules here govern the file-edit tools, not arbitrary shell. Bash-level containment is the `docs/172-agent-containment` egress/isolation work.
- **`~/.claude` is default-deny for the agent** (`/root/.claude/**` in the deny list), as proposed.
- **Did not symlink the dev-loop `.claude/settings.json` (096) to this file.** They govern different agents with potentially different policies; easier to evolve independently.

## Deferred (out of scope — owned elsewhere)

- [ ] Bash-level enforcement (`cat`/`rm` of sensitive paths) — needs egress + credential isolation, tracked under `docs/172-agent-containment`.
- [ ] Per-session permission overrides ("strict mode") — defer until requested.
- [ ] Codex agent permissions — `codex-adapter.ts` exposes no equivalent knob.
