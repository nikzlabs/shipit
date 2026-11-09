# OpenCode on a Claude subscription — checklist

- [x] Catalogue: OpenCode account target carries `anthropic-messages`
- [x] Routing: `AnthropicAccountRouting` for OpenCode on Anthropic `sub`
- [x] Credentials: Claude's layout for turns, turn end, 401 re-push, `shipit agent run` and background work
- [x] Adapters: `claude-agent` provider (OpenCode 2), plugin `claude-code` provider (OpenCode 1)
- [x] Installer: Claude Code required with OpenCode; SDK platform CLI pruned; plugin pruned without OpenCode 1
- [x] Pins: `@opencode/cli` 2.2.5, `@openchamber/opencode-claude` 0.14.0, transitive overrides; audit clean
- [x] Tests: catalogue, routing, shaping, both adapters, env preparation, installer
- [x] Real-binary turns through both adapters
- [x] Agent docs (`environment.md`) and wiki (`settings-and-accounts.md`)
