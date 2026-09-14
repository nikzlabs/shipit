# ShipIt Platform Docs

Reference documentation for the ShipIt runtime environment. Consult these when
configuring projects, troubleshooting previews, or answering questions about
platform capabilities.

**When the user asks what ShipIt can do, read [wiki/](wiki/README.md) instead.**
The files below are your operating manual — how to drive the surface you
control. The wiki describes ShipIt as a product: the panels the user works in,
what they can ask for, and what happens when they do. Most of that is surface
you never touch, so it is the only place you can learn it. Start at
[wiki/README.md](wiki/README.md), which maps the user's own wording to a page.

| File | Covers |
|------|--------|
| [wiki/](wiki/README.md) | **What ShipIt can do, for when the user asks** — the product, its features, and how to install and run it |
| [environment.md](environment.md) | Container layout, paths, auto-git, hot reload |
| [android.md](android.md) | Android — build/lint/test the baked toolchain, snapshot tests for visual checks, emulator-as-Compose-service for a live device |
| [shipit-yaml.md](shipit-yaml.md) | Full `shipit.yaml` config reference |
| [preview.md](preview.md) | Preview system — port detection, HMR, browser tools |
| [compose.md](compose.md) | Writing `docker-compose.yml` for ShipIt, and controlling the services in it — `shipit service list/start/stop/restart/logs` |
| [secrets.md](secrets.md) | Per-service env var declaration via `x-shipit-secrets` |
| [deployment.md](deployment.md) | Deploy targets, and what you can do about a failed deploy — Actions run logs and the one re-run you are allowed |
| [github.md](github.md) | Branches, PRs, auto-push, CI |
| [ssh.md](ssh.md) | SSH destinations granted to this session — `~/.ssh/config` is the list, `ssh <alias> '<cmd>'` is the use, and why the key is unreadable |
| [sessions.md](sessions.md) | Agent-spawned sibling sessions — `shipit session create`, when to use it |
| [sandbox-session.md](sandbox-session.md) | Sandbox session — empty `/workspace`, the git/docker/network capabilities, how to clone & open PRs per-repo, persistence |
| [agent.md](agent.md) | One-shot sub-agents — `shipit agent run --role NAME`, relaying an override the user asked for, and the two reads that say what exists here (`shipit agent roles` / `shipit agent params`) |
| [issues.md](issues.md) | Tracker-neutral issue access — `shipit issue view/list/comment/edit/status/assign` (GitHub + Linear), do-then-surface writes with Undo |
| [settings.md](settings.md) | Reading ShipIt's own settings — `shipit settings list/get`, what a projection shows, and why saved is not the same as in effect |
| [skills.md](skills.md) | Skill directory layout — hand-written vs ShipIt-installed, install markers, auto-commit |
| [plugins.md](plugins.md) | **Using** a plugin repository — declaring another repo's tools, the read-only `/plugins/<name>` checkout, plugin env and install, `shipit plugin refresh/status` |
| [plugin-authoring.md](plugin-authoring.md) | **Writing** a plugin repository — testing exports with `repo: self`, and what a consuming project does differently (read-only tree, ports, install, failure messages) |
| [design-docs.md](design-docs.md) | Feature docs — frontmatter format, status values, structure |
| [present.md](present.md) | `present` tool — show throwaway, non-git artifacts (HTML/SVG/markdown/images) in the Present tab without committing them to the workspace |
| [chat-links.md](chat-links.md) | Clickable pointers in chat — `shipit-preview://<service>/<path>` and `shipit-present:<file>#<fragment>` open a specific place in the user's app or a presented artifact |
| [bug-filing.md](bug-filing.md) | `report_shipit_bug` tool — file a redacted, consent-gated bug against ShipIt itself under the user's own GitHub identity |
