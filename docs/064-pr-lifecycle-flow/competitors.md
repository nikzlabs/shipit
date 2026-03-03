# 064 — Competitor Research: Code/PR Lifecycle Flows

Research on how other AI coding products handle the journey from idea to code to review to PR to merge. Conducted March 2026.

## Product Spectrum

Products fall on a spectrum from "skip review, just ship" to "structured gates at every step":

```
Lovable/Bolt ←→ ShipIt/Claude Code Web ←→ Codex ←→ Copilot Agent ←→ Devin
(deploy-first)   (chat-and-ship)          (task-first)  (issue-first)   (autonomous)
```

ShipIt sits in the middle — chat-first UX serving users who need real PRs. The opportunity is to borrow from both ends depending on context.

---

## GitHub Copilot (Workspace → Coding Agent)

**Model: Issue → Agent → Draft PR → Human Review**

### Copilot Workspace (sunset May 2025)

The most deliberate about giving users steering control at every stage:

```
Issue (natural language) → Spec → Plan → Implement → Validate → PR
```

Key insight: when users shape the spec and plan *before* code generation, the generated code is more likely correct, and the user goes into review with clear expectations of what should have changed. Everything was designed to be edited, regenerated, or undone at each step. Included integrated terminal and secure port forwarding for validation.

Sunset because the structured spec/plan steps added friction. The concepts were folded into the broader Copilot product.

### Copilot Coding Agent (GA September 2025)

Simplified the flow: assign issue → agent works asynchronously → draft PR appears.

**Lifecycle:**

1. Assign Copilot as issue assignee (or trigger from Chat, CLI, or MCP)
2. Agent adds eyes emoji reaction — you know it's working
3. Boots a GitHub Actions VM, clones repo, runs RAG-powered code search
4. Pushes commits to a **draft PR** in real-time — you can watch progress
5. Updates PR description as it works
6. Reasoning and validation steps visible in session logs
7. **Human approval required before CI/CD runs** — security by default

**Key UX decisions:**
- Always creates a draft PR — review gate is structural, not optional
- CI workflows require human approval before running
- Incremental PR reviews (Nov 2025) — only reviews new commits since last review, not the full PR
- Multiple entry points: Issues, Chat, CLI, MCP, IDEs

**Extensibility:** MCP servers, custom agents, hooks (shell commands at key points), skills (specialized instructions).

**Known UX issue (Jan 2026):** 90+ second cold boot for web agent. Stop-and-go nature pushes the web UX into "intolerable territory" per user feedback.

**Sources:**
- https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- https://githubnext.com/projects/copilot-workspace
- https://github.blog/ai-and-ml/github-copilot/from-idea-to-pr-a-guide-to-github-copilots-agentic-workflows/
- https://github.com/orgs/community/discussions/180828
- https://github.com/orgs/community/discussions/183877

---

## OpenAI Codex

**Model: Task → Cloud Sandbox → Diff Review → PR**

Built around parallelism — fire off multiple agents on different tasks simultaneously, each in an isolated sandbox.

**Architecture:**

The App Server keeps state server-side so work survives tab closes and network drops. Built on three core primitives:
- **Item** — atomic unit of input/output (user message, agent message, tool execution, approval request, diff)
- **Lifecycle events** — `started` → `delta` → `completed` for streaming
- **Threads** — each task is its own thread with full context

**Workflow:**

1. Describe task in the web app or assign via GitHub issue
2. Codex boots a cloud sandbox (isolated copy via git worktree)
3. Agent works autonomously — exploring, planning, implementing
4. Results appear as a **diff view** — review before committing
5. Accept/reject changes, open in editor for manual tweaks
6. Create PR from accepted changes

**Key UX decisions:**
- **Multi-threaded workspace** — switch between parallel tasks without losing context
- **Diff-first review** — no auto-push. You see changes before they go anywhere
- **Parallel agents** — multiple specialized agents working simultaneously (experimental)
- **Agent roles** — configurable per-project in `.codex/config.toml`, each role gets specific instructions and tool access
- **Automations** — Codex picks up work unprompted (issue triage, CI monitoring, alert response)

**Multi-agent orchestration (Agents SDK):**
- Project Manager agent enforces gating logic between specialists (Designer, Frontend, Backend, Tester)
- Mirrors enterprise workflows: JIRA orchestration, QA sign-offs
- Sub-agents inherit sandbox policy, run with non-interactive approvals

**Sources:**
- https://openai.com/index/introducing-codex/
- https://developers.openai.com/codex/workflows/
- https://developers.openai.com/codex/multi-agent/
- https://openai.com/index/unlocking-the-codex-harness/

---

## Devin

**Model: Task → Plan (with confidence) → Execute → Test → Self-Review → PR → Human Review**

The most autonomous of the products, and has invested the most in rethinking code review UX.

**Lifecycle:**

1. Receive task via web chat, Jira, or PR comment
2. Analyze code, produce a plan with **confidence rating** (low/medium/high). If not high, digs deeper or asks clarifying questions
3. Execute: edit code, run terminal commands, use built-in browser for docs
4. Run tests / CI to confirm
5. Self-review the PR before humans see it
6. Deliver as PR or direct commit

**Devin Review (February 2026 — Devin 2.2):**

The headline innovation. Turns GitHub's default diff view (alphabetical files, raw hunks) into an intelligently organized walkthrough:

- **Logical diff grouping** — groups related changes together, orders hunks for top-to-bottom reading, explains each group. "Like a smart colleague walking you through the PR."
- **Copy/move detection** — when code moves between files, GitHub shows full delete + full add. Devin collapses these into a single "moved" annotation.
- **Severity-tagged AI bug detection** — red (probable bugs), yellow (warnings), gray (FYI). Dismissible, actionable.
- **Interactive inline chat** — ask questions about any diff hunk with full codebase context, without leaving the review.
- **Self-reviewing PRs** — automated quality pass on every Devin-generated PR before humans see it. Catches logic errors, missing edge cases, style violations.
- **Auto-review** — configurable in settings, runs on all PRs automatically.

**Access:** `devinreview.com` (replace `github.com` in any PR URL), CLI (`npx devin-review {pr-url}`), or the Devin web app. Free for public repos.

**Performance (2025 annual review):**
- 4x faster at problem solving vs. 2024
- 2x more efficient in resource consumption
- 67% of PRs merged (vs 34% in 2024)
- Hundreds of thousands of PRs merged across thousands of companies

**Limitations:**
- Handles clear upfront scoping well, not mid-task requirement changes
- Can't tackle ambiguous projects end-to-end like a senior engineer
- Net time savings: ~15-30 min per well-scoped task after accounting for prompt crafting and review overhead

**Sources:**
- https://cognition.ai/blog/devin-review
- https://cognition.ai/blog/devin-annual-performance-review-2025
- https://docs.devin.ai/work-with-devin/devin-review
- https://www.digitalapplied.com/blog/devin-2-desktop-code-review-ai-engineer-guide

---

## Cursor / Windsurf

**Model: IDE-native — Edit → Agent generates → Review in editor → Commit → External PR flow**

Stays closest to the traditional IDE model. Code review happens in the editor, not a separate UI.

**Key features:**
- **Plan mode with clarifying questions** — before implementing, Cursor asks questions to improve plan quality
- **Custom modes** — configure Cursor as a "senior reviewer" with a multi-point checklist
- **`@Git` context** — reference commit history and diffs directly in chat
- **Workflows (Windsurf)** — reusable markdown-defined sequences: PR checkout → review comments → apply fixes → commit
- PR creation and review handled via CLI/GitHub integration, not built into the IDE

**Relevance to ShipIt:** The "clarifying questions before coding" pattern is worth noting. Cursor's plan mode is the lightweight version of Copilot Workspace's spec/plan steps.

**Sources:**
- https://cursor.com/for/code-review
- https://docs.windsurf.com/windsurf/cascade/workflows

---

## Claude Code (CLI + Web)

**Model: Terminal-native — Prompt → Code → /commit → /pr**

The closest sibling to ShipIt. Relevant patterns:

- `/commit` — commits with AI-generated message
- One-step PR creation via `gh pr create`
- **Claude Code Action** for CI — reviews PRs with 5 parallel specialist agents, scores findings on a confidence scale, posts only high-confidence comments
- **Code Review plugin** — 5 independent reviewers: CLAUDE.md compliance, bug detection, git history, previous comments, code comments
- **Auto review-fix loop** — after posting review comments, the agent detects feedback and automatically addresses comments with new commits, repeating up to 5x before notifying the human
- **Claude Code Web** — browser version with live preview, one-click deploy, managed sandboxes. Architecture (managed sandboxes, push-to-GitHub) is essentially what ShipIt does.

**Sources:**
- https://code.claude.com/docs/en/common-workflows
- https://github.com/anthropics/claude-code-action
- https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md
- https://code.claude.com/docs/en/claude-code-on-the-web

---

## Vibe Coding Platforms (Bolt.new, Lovable, Replit)

**Model: Describe → AI builds → Live preview → Deploy → (optional GitHub sync)**

These platforms largely skip the PR lifecycle:

- **Lovable** — GitHub two-way sync, but primary flow is prompt → preview → deploy
- **Bolt.new** — Vercel integration for preview URLs on PRs, but primarily deploy-focused
- **Replit** — own hosting, testing, deployment. Git is secondary

**Relevance to ShipIt:** For solo vibe-coding, the PR lifecycle is overhead. These tools succeed by optimizing for "see it working" over "review the diff." ShipIt needs to make the review flow available but not mandatory.

---

## Key Patterns Across Products

### 1. Draft PR as default
GitHub Copilot always creates draft PRs. Sets the right expectation: AI output needs review before it's production-ready.

### 2. Diff-first review (no auto-push)
Codex and Devin both show changes as diffs before anything is pushed. The user explicitly accepts before code leaves the sandbox. Contrast with ShipIt's current auto-push.

### 3. Confidence signals
Devin shows plan confidence (low/medium/high). Copilot Workspace let users steer at spec/plan stages. The theme: give users information to calibrate trust before review.

### 4. Intelligent diff organization
Devin Review's logical grouping + explanations is the biggest UX innovation in code review. GitHub's alphabetical file ordering is terrible for comprehension.

### 5. Self-review before human review
Both Devin and Claude Code Action run automated review passes on AI-generated PRs before humans see them. Catches 30%+ more issues.

### 6. CI failure as input
Claude Code's auto review-fix loop (detect failure → fix → re-commit, up to 5x) closes the feedback loop automatically.

### 7. Parallel task execution
Codex's multi-threaded workspace lets users fire off multiple tasks and switch between them. Each gets its own isolated sandbox.

### 8. Incremental review
Copilot's incremental PR reviews (only new commits since last review) prevent re-reviewing the same code.

---

## What ShipIt Already Does Better

- **Live preview** during coding (Codex and Devin don't have this)
- **Inline diff comments** that feed back to Claude (unique to ShipIt)
- **File-level accept/reject** on turn diffs (more granular than competitors)
- **Conversation continuity** — chat and code in the same view (vs. Devin/Codex where review is a separate app/context)
- **One-click deploy** alongside the PR flow (both ship paths available)
- **Instant start** — no 90-second cold boot (vs. Copilot web agent)
