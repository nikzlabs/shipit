---
issue: planning#719
title: Code Mode setting per harness — design
description: Three Advanced settings turn Code Mode on or off for OpenCode 2, Codex and OpenCode 1; each turn reads its harness's value.
---

# Code Mode setting per harness — design

Implements [requirements.md](./requirements.md). OpenCode 2's own notes are in
[docs/269-opencode-v2/plan.md](../269-opencode-v2/plan.md).

## Which harnesses have a Code Mode (checked 2026-11-10 on the pinned CLIs)

| Harness | Code Mode | Setting |
|---|---|---|
| OpenCode 2 2.2.5 | `execute` tool, on by default; per MCP server `codemode` | yes, default on |
| Codex 0.162.1 | `features.code_mode`, "under development", default off; adds a freeform `exec` tool and `wait` | yes, default off |
| OpenCode 1 1.19.5 | `OPENCODE_EXPERIMENTAL_CODE_MODE=1`; adds `execute` and moves MCP tools into it | yes, default off |
| Claude Code 2.1.321 | `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, but the CLI's own text: "for now it only works in the interactive terminal". ShipIt runs it headless; with the variable set the `-p` turn's tools did not change | no (req 2) |
| Grok 1.0.74 | none found in the binary | no |
| Antigravity 1.1.27 | none found in the binary | no |

## Settings (reqs 2, 4)

`advanced.codeMode.opencode2`, `advanced.codeMode.codex` and
`advanced.codeMode.opencode` are ordinary `bool` declarations in
`shared/settings-catalogue/global-settings.ts`, in an Advanced section named
"Code Mode", stored in the credential store. The dialog draws them from the
catalogue, and `shipit settings` reads and proposes them, with no other
registration.

## From the setting to the CLI (req 6)

- `orchestrator/code-mode.ts` maps a harness to its setting (`codeModeFor`).
  A harness with no setting gets `undefined`.
- `buildAgentRunParams` puts the value on `AgentRunParams.codeMode` for every
  spawning turn. `undefined` means "leave the CLI's default".
- **OpenCode 2** (`opencode2/adapter.ts`): off adds `execute: false` to the
  turn's tools and `codemode: false` to every MCP server; on leaves both out.
- **Codex** (`codex/adapter.ts`): `-c features.code_mode=true` or `=false`,
  so the setting wins over a `code_mode` line in Codex's own config.
- **OpenCode 1** (`opencode/adapter.ts`): on sets
  `OPENCODE_EXPERIMENTAL_CODE_MODE=1`; off removes an inherited one.
- A tools-off run never turns Code Mode on.
- **Next turn, running sessions included.** OpenCode 1 and 2 spawn per turn,
  so the next turn reads the new value. Codex keeps a resident process across
  turns. `withCodeMode` adds `|codemode` to the spawn identity when the value
  is on, and the three places that compare a resident's identity with the
  session's (`ws-handlers/agent-execution.ts`, `dispatched-turn.ts` through
  the `codeModeFor` dep, and the spawn in `turn-executor.ts`) all apply it. So
  a changed value retires the resident at the next turn, as a model change
  does. The mark is added only when on, so a process spawned before this
  setting existed is not retired on deploy.

## The transcript (req 3)

- **OpenCode 2** reports `execute` as one tool event: `input.code` is the
  program, `output` its result, and `state.metadata.content` holds the text
  and every image the inner tools returned, as `file` parts with `data:`
  URIs. `opencode2ToolResultImages` (PR #3334) maps that field for every
  tool, so the Code card shows those images with no Code Mode code. A throw or an unknown tool inside the code
  reports `status: "completed"` with `state.metadata.metadata.error: true`;
  `isOpencode2ToolError` marks that result as an error.
- **OpenCode 1** reports the same `execute` event, but a failure is
  `status: "error"` with the message in `state.error`, and the stream carries
  no image for any tool (the image reaches the model only). Both adapters now
  show `state.error` when `output` is absent; before, a failed tool showed an
  empty result.
- The client labels `execute` as **Code** and draws the program's first line
  (`message-tools.tsx`). The transcript policy keeps an 80-character head of
  `execute`'s `code`, as it does for `command`, so the line survives a reload
  (`transcript-input-policy.ts`).
- **Codex** sends no item for the `exec` call itself, only one `mcpToolCall`
  per inner call, so each inner call is its own card. 0.162.1 sends their
  `arguments` as an object, which the handler used to show as `{raw: …}`; it
  now takes the object as the input.
- `OPENCODE2_TOOL_NAMES` lists `execute`, since it is on by default; its
  transcript name is `execute` itself and its `code` input is not renamed.
  OpenCode 1's list leaves it out, since its Code Mode is off by default.

## Verified (2026-11-10)

Through ShipIt's real adapters, the pinned binaries and fake model servers
(an OpenAI-compatible chat server for OpenCode, a Responses server for Codex)
with a stdio MCP server that returns text and a PNG:

- OpenCode 2 on: the first request carries `execute` and the MCP tool in its
  catalog; `execute` on step one returns the tool's text, and the image in
  `state.metadata.content` (from two concurrent calls too). After the rebase
  onto PR #3334, the adapter's `agent_tool_result` for `execute` carries the
  text and the PNG as an `image` block. Off: no
  `execute`, and the MCP tool is a direct tool on the first request, as
  before.
- OpenCode 1 on: `execute` on step one calls the MCP tool; off: `execute` is
  unknown and the MCP tools are direct.
- Codex on: `exec` on step one calls the MCP tool and returns text and image
  to the model; off: a plain turn.
- The Settings dialog of the dogfood instance shows the Code Mode section
  with the three defaults, and a toggle saves.

Known limit (req 3): OpenCode 1's stream carries no image for any tool, so
its Code card shows the program and the text result only.

Not verified: a real model choosing Code Mode, and a Codex resident retired
by a toggle in a live session (covered by
`integration_tests/restart-idle-resident.test.ts`).
