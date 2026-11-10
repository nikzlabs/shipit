# OpenCode 2 on a Claude subscription — checklist

- [x] Catalogue: OpenCode 2's account target carries `anthropic-messages`
- [x] Routing: `AnthropicAccountRouting` for OpenCode on Anthropic `sub`
- [x] Credentials: Claude's layout for turns, turn end, 401 re-push, `shipit agent run` and background work
- [x] Adapter: `claude-agent` provider on OpenCode 2; OpenCode 1 unchanged (req 2)
- [x] Installer: Claude Code required with OpenCode 2
- [x] Pins: `@opencode/cli` 2.2.5; audit clean
- [x] Tests: catalogue, routing, shaping, OpenCode 2 adapter, env preparation, installer
- [x] Real-binary turns through the OpenCode 2 adapter
- [x] Agent docs (`environment.md`) and wiki (`settings-and-accounts.md`)
