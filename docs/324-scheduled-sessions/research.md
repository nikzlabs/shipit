---
issue: planning#640
title: Scheduled sessions — prior art
description: How other agent products run scheduled tasks (researched 2026-10-07), and which of their lessons apply to ShipIt.
---

# Scheduled sessions — prior art

Researched 2026-10-07 from official docs: Claude Code routines and Desktop
scheduled tasks, Codex automations, Cursor Automations, GitHub Agentic Workflows
and Copilot app automations, Jules scheduled tasks, Devin automations, Factory
automations, and the non-AI references Kubernetes CronJob, Temporal schedules,
GitHub Actions `schedule` and Vercel cron. Items marked *unverified* were not
confirmed on an official page.

Requirements: [requirements.md](./requirements.md). UI sketch:
[mockup.html](./mockup.html).

## What every product agrees on

- **A task is a saved prompt + scope + trigger.** Scope is the repositories,
  model, environment and tools. In most products a schedule is one trigger type
  of a general "automation" (Claude routines, Cursor, Devin, Factory, Codex,
  Copilot app). Jules is the exception: schedules only.
- **Each run is a fresh, full session** that the user can open and continue.
  The usual output is a PR, a comment or a message.
- **Time is presets plus an escape hatch**: hourly / daily / weekdays / weekly,
  then cron, RRULE or plain words.
- **Common controls**: a list of past runs, **Run now**, pause/resume that keeps
  the configuration.
- **Unattended means no approval prompts.** The safety boundary moves to
  configuration time: which repositories, network and tools the task gets.

## Where they disagree

| Choice | Options seen |
|---|---|
| Run model | Fresh session per run (most) vs. return to one thread (Codex chat-scoped tasks, Devin "message session") |
| Where the definition lives | In the account, edited in a UI or by chat (most) vs. a file in the repository, reviewed in PRs (GitHub Agentic Workflows) |
| What the agent may write | Full autonomy with the user's credentials (Claude) vs. tool toggles (Cursor) vs. a read-only agent plus separate, declared write jobs (GitHub Agentic Workflows, which has an experimental `merge-pull-request`) |
| Overlap | Skip (Claude Desktop, Temporal default) vs. queue (GitHub Agentic Workflows, Devin optional) vs. allow (Kubernetes, Vercel default) |
| Run the agent at all? | A deterministic pre-check can skip the run (Devin pre-run script, gh-aw `skip-if-match`) vs. the agent always runs and finds out |

## Easy to miss in a first version

Each item names the product that taught it, then what it means for ShipIt.

1. **Overlap, with skips recorded.** Claude Desktop skips a run whose
   predecessor is still going and keeps the skip in history with a reason.
   *ShipIt:* a run is a session with a container; overlapping daily runs would
   double the work. Skip and record is the cheap default.
2. **Missed runs.** Claude Desktop runs one catch-up for the most recent missed
   slot (within 7 days) and warns it can run hours late. Factory pauses after 10
   days of misses. *ShipIt:* a self-hosted server restarts for updates, so a run
   due during a restart is a normal case, not an edge case.
3. **Auto-pause after repeated failure; expired credentials.** Factory pauses
   after 5 failed runs in a row. Claude routines skip runs while the GitHub
   connection is broken, then turn off after 72 hours. *ShipIt:* a run can fail
   to start for want of a credential, quota, or a removed repository; the user
   must see that on the schedule, not discover it weeks later.
4. **"Started" is not "succeeded".** Claude's docs say a green run means only
   that there was no infrastructure error. *ShipIt:* the run's own session —
   its status card, "needs you" — already carries the task outcome; the
   schedule only has to record whether the run started.
5. **Not re-reporting the same thing every run.** Devin gives a pre-run script a
   state file; gh-aw has repo memory and a cache; Cursor writes `MEMORIES.md`;
   Factory a `memory/` folder. *ShipIt:* tasks that read live state ("open
   security PRs") need no memory. Tasks that report findings do.
6. **Quiet runs.** Codex's Scheduled inbox shows only runs with findings; gh-aw
   has a `noop` output. *ShipIt:* a daily schedule makes about 250 sessions a
   year. Without a rule for runs that needed nothing, the sidebar fills.
7. **Untrusted input, including memory.** Claude marks text passed in by API
   or Run now as untrusted; Cursor warns that untrusted input can write
   misleading memories. *ShipIt:* the stored prompt is the user's own and is
   trusted; what the run reads (PR bodies, issues) is untrusted as in every
   session. Any memory a run writes is untrusted input to the next run.
8. **Identity and who pays.** Claude routines act "as you"; Cursor and Factory
   offer a service account. *ShipIt:* runs act as the user with the user's
   accounts and credentials, as any session does.
9. **On-the-hour load.** Claude suggests 9:07 instead of 9:00; gh-aw and Claude
   Desktop add a per-task offset. *ShipIt:* five schedules at 09:00 start five
   containers at once on one host.
10. **Time zone and daylight saving.** Factory converts to fixed UTC and does
    not follow daylight saving. *ShipIt:* store the IANA zone name, so "09:00
    Europe/Berlin" stays 09:00 all year.
11. **Rate floor.** Minimum intervals: Claude cloud 1 hour, gh-aw 5 minutes,
    GitHub Actions 5 minutes. *ShipIt:* each run is a container start.
12. **Cost caps.** gh-aw caps credits and turns per run; Devin has a per-session
    limit, off by default. *ShipIt:* runs draw on the user's subscription; quota
    exhaustion is already handled per session.
13. **Test before trusting.** Devin's Test mode and gh-aw's staged mode run
    without side effects; Claude Desktop recommends Run now first, because a
    task that asks for permission stalls. *ShipIt:* a run whose permission mode
    or network allowlist makes it ask the user will stall the same way.
14. **Editing.** Jules cannot edit a task; most others apply an edit from the
    next run. Only file-defined tasks (gh-aw) get version history. *ShipIt:* a
    run's first message is the prompt it ran with, so each run records the
    version it used.
15. **Workspace isolation.** Codex warns that worktrees pile up on frequent
    schedules. *ShipIt:* each run's session has its own container and branch,
    so isolation comes with the session; the pile-up is item 6.

## ShipIt facts that shape the design

- **The composer is already one component.** `MessageInput` renders the
  new-session composer, the in-session chat input and the Quick Capture overlay.
  A schedule mode in it inherits every control those have.
- **But the composer's choices are not one object.** The new-session view claims
  a warm draft session and applies each pick to it as it happens (`set_agent`,
  `set_model`, `set_reasoning`, `set_role` over the WebSocket; network mode by
  HTTP). The permission mode lives only in the browser and rides each message.
  A schedule must store every pick as data and apply it later, with no browser.
  Req 5 therefore needs one serializable "session start" description that the
  composer, Quick Capture and schedules all produce; today the composer and
  `POST /api/sessions/headless` already accept different sets.
- **The headless start exists, but only for repositories.**
  `createHeadlessSession` (docs/145-quick-capture-overlay) starts a session with
  a prompt and no viewer attached. It requires a repository, takes no
  permission mode, and its route drops `title`. Sandboxes are created by a
  separate path (`createSandboxSession`) that takes no prompt, model or role.
- **The composer has no sandbox target today.** A sandbox's grants are chosen in
  `SandboxDialog` before the composer opens; SSH destinations and the network
  override are set afterwards in Session settings. A run has no "afterwards", so
  a schedule stores all of them.
- **Nothing records where a session came from.** There is no "created by"
  field, so grouping runs under their schedule needs one.
- **Things that stop an unattended run and wait for a person:** the `guarded`
  permission mode, a question card, an egress prompt for a new host, an agent
  re-login, and a repository the user has not marked as trusted (dispatch is
  refused). The first four show as "needs you"; the last must show on the
  schedule.
- **Timers are plain intervals; there is no cron parser.** The pattern to copy
  for "is a run due" is `runUpdateCheckIfDue`, which keeps the last time on disk
  so a restart does not cause an extra run.
- **The example task ("merge the security PRs") fits a sandbox, not a
  repository session.** In a repository session `gh pr merge` merges only the
  PR that ShipIt opened for that session (`agentMergeOwnership`,
  `pr-target.ts`). A sandbox with GitHub access and "Allow merging PRs" may merge
  any PR whose checks all pass (`mergeDisposition`, `pr-target.ts`).
- **"Needs you" already reaches the user.** The sidebar's attention list and
  voice notes cover a run that stops on a question, so a schedule needs no
  notification channel of its own.

## Sources

- Claude Code: <https://code.claude.com/docs/en/routines>,
  <https://code.claude.com/docs/en/desktop-scheduled-tasks>,
  <https://code.claude.com/docs/en/scheduled-tasks>
- Codex: <https://learn.chatgpt.com/docs/automations?surface=app>
- Cursor: <https://cursor.com/docs/cloud-agent/automations>
- GitHub Agentic Workflows: <https://github.github.com/gh-aw/reference/triggers>,
  <https://github.github.com/gh-aw/reference/safe-outputs/>; Copilot app:
  <https://docs.github.com/en/copilot/how-tos/github-copilot-app/using-automations>
- Jules: <https://jules.google/docs/scheduled-tasks/>
- Devin: <https://docs.devin.ai/product-guides/automations>
- Factory: <https://docs.factory.com/software-factory/automations.md>
- Kubernetes: <https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/>;
  Temporal: <https://docs.temporal.io/schedule>; Vercel:
  <https://vercel.com/docs/cron-jobs/manage-cron-jobs>

*Unverified:* overlap and daylight-saving behavior of Claude cloud routines;
the exact rules of gh-aw `merge-pull-request`; Cursor and Codex retry policies.
