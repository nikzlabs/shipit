# ShipIt Platform Docs

Reference documentation for the ShipIt runtime environment. Consult these when
configuring projects, troubleshooting previews, or answering questions about
platform capabilities.

| File | Covers |
|------|--------|
| [environment.md](environment.md) | Container layout, paths, auto-git, hot reload |
| [shipit-yaml.md](shipit-yaml.md) | Full `shipit.yaml` config reference |
| [preview.md](preview.md) | Preview system — port detection, HMR, browser tools |
| [secrets.md](secrets.md) | Per-service env var declaration via `x-shipit-secrets` |
| [deployment.md](deployment.md) | Deploy targets (Vercel, Cloudflare) |
| [github.md](github.md) | Branches, PRs, auto-push, CI |
| [sessions.md](sessions.md) | Agent-spawned sibling sessions — `shipit session create`, when to use it |
| [skills.md](skills.md) | Skill directory layout — hand-written vs ShipIt-installed, install markers, auto-commit |
| [design-docs.md](design-docs.md) | Feature docs — frontmatter format, status values, structure |
| [present.md](present.md) | `present` tool — show ephemeral artifacts (HTML/SVG/markdown/images) in the Present tab without writing to the workspace |
| [bug-filing.md](bug-filing.md) | `report_shipit_bug` tool — file a redacted, consent-gated bug against ShipIt itself under the user's own GitHub identity |
