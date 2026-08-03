# 247 — Images in pull request bodies: checklist

- [x] Establish whether any token-authenticated route can produce an image URL that renders in a PR (it cannot — see `plan.md`)
- [x] Decide with the human whether to ship a public-repo-only mechanism or document the gap (chose: document)
- [x] State the gap in the always-on PR instructions so the agent learns it up front
- [x] Record the reasoning and the alternatives in the agent-facing `gh` docs
- [x] Cross-reference from the `present` tool's before/after guidance
- [x] Close nikzlabs/shipit#1912 with the finding
