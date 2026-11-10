# Code Mode setting per harness — checklist

- [x] Check every pinned harness for a Code Mode (plan.md table)
- [x] Three `advanced.codeMode.*` declarations, defaults per req 4
- [x] `AgentRunParams.codeMode` from `buildAgentRunParams`
- [x] OpenCode 2: `execute` and per-server `codemode` follow the setting
- [x] Codex: `-c features.code_mode=true`; resident retired on a change
- [x] OpenCode 1: `OPENCODE_EXPERIMENTAL_CODE_MODE=1`
- [x] Transcript: Code label and first line, `code` head kept, Code Mode errors, `state.error`, Codex object arguments
- [x] Probe each harness on and off through the real adapter and binary
- [x] Wiki: settings-and-accounts.md
- [x] Settings dialog checked in the dogfood instance (section, defaults, a toggle saves)
