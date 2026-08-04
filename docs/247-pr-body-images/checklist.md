# 247 — Images in pull request bodies: checklist

- [x] Establish whether any token-authenticated route can produce an image URL that renders in a PR (it cannot — see `plan.md`)
- [x] Decide with the human whether to ship a public-repo-only mechanism or document the gap (chose: document)
- [x] Decide where the warning lives (chose: on-demand docs only — the always-on prompt isn't worth polluting for a task shape that has come up once)
- [x] Record the constraint and the alternatives in the agent-facing `gh` docs
- [x] Cross-reference from the `present` tool's before/after guidance
- [x] Close nikzlabs/shipit#1912 with the finding
