---
status: planned
priority: low
description: Wire ShipIt agents to a personal external agent (Hermes) over MCP so the agent can deliver a voice-ready summary at the end of every turn. No ShipIt code changes — configuration only.
---

# Hermes MCP integration

## Summary

Connect ShipIt agents to a personal external assistant ("Hermes") so that at the end of every turn the agent calls a Hermes-exposed MCP tool with a short, voice-ready summary of what just happened. Hermes then decides how to deliver the summary to the user (voice message, push, Slack — Hermes's call).

This is **configuration only** on the ShipIt side. No code lands in the ShipIt repo. The work splits cleanly:

- **ShipIt side:** add a custom-instructions block telling the agent to always call the tool at end of turn, and add an HTTP MCP server entry pointing at Hermes. Both are existing Settings surfaces. See [[shipit-side]].
- **Hermes side:** implement an MCP server exposing `notify_turn_end` (and optionally `ask_user_question`), verify the bearer token, route notifications. See [[hermes-side]].

This doc is for the user's personal use — not a feature ShipIt is shipping. It exists so the configuration is reproducible and the contract between the two sides is written down.

## Why MCP, not a webhook

A server-side post-turn webhook was the first thing considered. It would fire deterministically on every turn end, including failure modes (crashed agent, hit Stop, ran out of context) where an MCP-driven tool call cannot. That sounds attractive, but the value of a notification is entirely in the model-written summary that gets read aloud — a deterministic "the turn ended" with no useful summary is no better than the passive UI notification ShipIt already shows. MCP requires the model to cooperate, but that's the cooperation we need anyway. The webhook would deliver low-quality notifications exactly in the cases where it has a structural advantage over MCP, and identical-quality notifications in every other case. MCP also composes better: the same server can expose query tools (`ask_hermes`, look-ups) alongside the notify tool, one config surface instead of two.

## Architecture

```
┌──────────────────────────────────────────┐
│ ShipIt session container                 │
│                                          │
│  Claude Code CLI ───MCP───┐              │
│     ▲                     │              │
│     │ system prompt:      │              │
│     │ "call notify_turn_  │              │
│     │  end at end of turn"│              │
└─────│─────────────────────│──────────────┘
      │                     │
      │ Tailscale           │ HTTPS, Bearer auth
      │                     ▼
   ┌──┴─────────────────────────────────┐
   │ Hermes (other server)              │
   │                                    │
   │  MCP server                        │
   │   ├── tool: notify_turn_end        │
   │   └── (optional) ask_user_question │
   │                                    │
   │  Notification dispatcher           │
   │   ├── voice                        │
   │   ├── push                         │
   │   └── …                            │
   └────────────────────────────────────┘
```

The agent decides when to call the tool. ShipIt's job is just to make sure the agent knows the tool exists and knows it should call it.

## ShipIt-side configuration {#shipit-side}

All of this is done in the existing **Settings** UI. No code changes, no fork, no PR.

### Step 1 — add Hermes as an HTTP MCP server

Settings → MCP Servers → **"+ Add MCP Server"**:

| Field | Value |
|---|---|
| Name | `hermes` (lowercase alphanumeric, starts with a letter) |
| Type | `http (remote endpoint)` |
| URL | `https://hermes.<your-tailnet>.ts.net/mcp` (or whatever path Hermes exposes — see [[hermes-side]]) |
| Headers (click "+ Add header") | Key: `Authorization` &nbsp; Value: `Bearer <token>` |

Click **Save**. ShipIt stores the bearer token under `mcp__hermes__Authorization` in the credentials volume; the raw value is never echoed back to the UI. The server is account-level — available in every session and every repo.

### Step 2 — instruct the agent to always call it

Settings → Instructions → **"Your Instructions"** textarea. Append the block below (or paste it as the entire content if you don't already use this field for anything else).

```text
## Personal notification: end-of-turn summary

You have access to an MCP tool called `hermes__notify_turn_end`. Call it
exactly once at the end of every turn, immediately before you stop producing
output.

This is how the user gets notified that you've finished. If you don't call it,
they don't know. Don't skip it.

### When to call it

- At the natural end of every turn, after the work for that turn is done and
  any auto-commit has happened.
- BEFORE you stop producing output. Once you stop, you cannot call it.
- If you are asking the user a question and waiting for an answer, call it
  with `needsAttention: true` so they know you're blocked.
- If you hit an error and have to give up, call it with `needsAttention: true`
  and a summary that explains what went wrong.

### What to pass

- `voiceSummary` (required): a one or two sentence description of what just
  happened, written for SPOKEN delivery — natural English, no markdown, no
  code fences, no file paths, no commit hashes, no PR numbers. The user is
  going to hear this read aloud while they're doing something else. Examples:
    GOOD: "Finished wiring the post-turn webhook into both agent paths and
           pushed the change."
    GOOD: "Hit a type error in the settings panel I can't resolve — need you
           to take a look."
    GOOD: "Couldn't find the file you mentioned, asked a clarifying question
           and waiting for your reply."
    BAD: "Updated `agent-execution.ts:451` and ran `npm run typecheck`. ✓"
    BAD: "Created PR #142 with commit abc1234."

- `needsAttention` (required, boolean): true if you are blocked on the user
  (asked a question, errored, need a decision). False if you finished the
  requested work and they can read the diff at their leisure.

- `context` (optional object): include `repo`, `branch`, and `prUrl` if you
  know them. These are not spoken; Hermes uses them to decide routing /
  include a deep link.

### Examples

After finishing a feature implementation:
  hermes__notify_turn_end({
    voiceSummary: "Done — added the post-turn webhook and opened a pull request.",
    needsAttention: false,
    context: { repo: "shipit", branch: "shipit/abc123", prUrl: "https://…" }
  })

After hitting a blocker:
  hermes__notify_turn_end({
    voiceSummary: "Stuck — the migration needs a column I don't know how to name. Mind taking a look?",
    needsAttention: true,
    context: { repo: "shipit", branch: "shipit/abc123" }
  })

After answering a question (no code changes):
  hermes__notify_turn_end({
    voiceSummary: "Answered your question about the session lifecycle, no code changes.",
    needsAttention: false
  })

If the `hermes__notify_turn_end` tool is unavailable for any reason
(connection error, server down), do not retry indefinitely. Try once, mention
it in your final reply if it fails, and move on. The user will see your reply
in chat regardless.
```

The exact tool name (`hermes__notify_turn_end`) is the convention Claude Code uses for MCP tools: `<server-name>__<tool-name>`. Server name is whatever you typed in Step 1.

### Step 3 — verify reachability

Tailscale to a `*.ts.net` hostname Just Works from inside a ShipIt session container — containers inherit the host's network stack, including Tailscale's MagicDNS. No ShipIt-side networking config required. If `curl https://hermes.<your-tailnet>.ts.net/health` works from the host, it works from the container.

### Step 4 — try it

Start a session, give the agent any small task ("rename this variable" works). When it finishes, you should:

1. See the tool call in the chat transcript (Claude Code shows MCP tool calls inline).
2. Receive the notification from Hermes on your delivery channel.

If the tool call is missing, the instructions block isn't being applied — check Settings → Instructions is saved, and the **"ShipIt Agent Instructions"** toggle (which controls whether built-in + user instructions are sent) is on.

If the tool call happens but no notification arrives, the issue is on the Hermes side.

## Hermes-side implementation {#hermes-side}

Hermes hosts an HTTP MCP server. The contract is:

### Endpoint

`POST /mcp` (path is Hermes's choice; the URL is whatever you paste into ShipIt's MCP config). Speaks Streamable HTTP transport per the MCP spec.

### Auth

`Authorization: Bearer <token>` on every request. Verify with a constant-time compare; reject with 401 on mismatch. Token is shared secret — generate one (e.g. `openssl rand -hex 32`), give the same value to ShipIt (Step 1 above) and to Hermes's secret store.

### Tools exposed

**`notify_turn_end`** (required):

```json
{
  "name": "notify_turn_end",
  "description": "Notify the user that a ShipIt agent turn has ended. Must be called exactly once at the end of every turn, before the agent stops producing output. The voiceSummary will be read aloud to the user.",
  "inputSchema": {
    "type": "object",
    "required": ["voiceSummary", "needsAttention"],
    "properties": {
      "voiceSummary": {
        "type": "string",
        "description": "One or two sentences for spoken delivery. Natural English. No markdown, code, file paths, or commit hashes."
      },
      "needsAttention": {
        "type": "boolean",
        "description": "True if the agent is blocked on the user (question, error, decision needed). False if the user can read the diff at their leisure."
      },
      "context": {
        "type": "object",
        "properties": {
          "repo": { "type": "string" },
          "branch": { "type": "string" },
          "prUrl": { "type": "string" }
        }
      }
    }
  }
}
```

**`ask_user_question`** (optional, future): could let the agent push a question to the user out-of-band (voice) and wait for a reply. Out of scope for v1.

### What `notify_turn_end` does on the Hermes side

1. Validate the bearer token.
2. Validate the input shape against the schema above; reject with a tool error if invalid (the agent will see the error in its transcript and can retry).
3. Pick a delivery channel based on policy:
   - `needsAttention === true` → most attention-grabbing channel (voice call, push with sound, whatever you've set up for "I need to look now").
   - `needsAttention === false` → low-friction channel (silent push, text-to-speech queued for next time you're not busy, etc.).
4. Deliver the `voiceSummary` verbatim. Do not paraphrase or summarise — the agent already shaped it for voice.
5. If `context.prUrl` is present, include it as a deep link in the notification (text channels) or skip it (voice).
6. Return an MCP success response with a short confirmation the agent can log (e.g. `"Sent via voice channel."` — the agent doesn't act on this but it shows up in the chat transcript so the user can see delivery worked).

### Persistence (optional)

Recommended but not required: log every notification (timestamp, summary, needsAttention, channel used, success/failure) to a small SQLite db or file so you can audit later "why didn't I get notified about X."

### Prompt to bootstrap Hermes

Paste this into your Hermes agent to implement the above:

```text
Build an MCP server that ShipIt agents will call at the end of every turn to
notify me. This is for personal use — no need for multi-tenancy, fancy auth
flows, or production hardening beyond what's listed.

## Transport and endpoint

HTTP MCP server, Streamable HTTP transport per the MCP spec. Pick the path
yourself — I'll paste the full URL into ShipIt. Reachable over my Tailscale
network (you're already on the tailnet). Listen on a non-privileged port.

## Auth

`Authorization: Bearer <token>` required on every request. Verify with a
constant-time string compare. Reject with HTTP 401 on mismatch. Store the
expected token in your existing secret store — do not hardcode it. Generate
a 32-byte hex token (`openssl rand -hex 32`) the first time you start up if
one isn't already configured, and print it to your logs so I can copy it into
ShipIt.

## Tool: notify_turn_end

Expose a single MCP tool with this schema:

  name: notify_turn_end
  description: "Notify the user that a ShipIt agent turn has ended. Must be
                called exactly once at the end of every turn, before the agent
                stops producing output. The voiceSummary will be read aloud."
  inputSchema:
    type: object
    required: [voiceSummary, needsAttention]
    properties:
      voiceSummary: { type: string }
      needsAttention: { type: boolean }
      context:
        type: object
        properties:
          repo: { type: string }
          branch: { type: string }
          prUrl: { type: string }

## What the tool does

1. Validate the bearer token (already done at transport layer, but double-check
   inside the handler too).
2. Validate the input shape. If invalid, return an MCP tool error — the agent
   will see it in its transcript and can correct itself.
3. Pick a delivery channel based on policy:
     - needsAttention=true → use the most attention-grabbing channel I've set
       up with you (voice call, push with sound — your call based on time of
       day and my recent activity).
     - needsAttention=false → use a low-friction channel (silent push, queued
       voice for later, whatever feels right).
4. Deliver the voiceSummary VERBATIM via your text-to-speech / notification
   pipeline. Do not paraphrase, summarise, or rewrite it — the ShipIt agent
   already shaped it for spoken delivery.
5. If context.prUrl is present, include it as a clickable link in text
   channels. Skip it for voice channels (URLs are awful spoken).
6. Return an MCP success response with a short string telling the agent which
   channel was used (e.g. "Sent via voice." or "Queued for silent push."). The
   agent doesn't act on it, but it shows up in its transcript and is useful
   for debugging.

## Logging

Log every call: timestamp, voiceSummary, needsAttention, context, chosen
channel, delivery outcome. Append-only file or SQLite — your choice. I'll
want to look at this when something didn't notify me the way I expected.

## What to deliver back to me

Confirm in chat:
1. The exact URL I should paste into ShipIt's MCP config (scheme, host, port,
   path).
2. The bearer token (or that you generated one and it's in your logs).
3. A description of which delivery channels you'll use for needsAttention=true
   vs false, given my current setup.
4. A test plan: how do I trigger a sample notification end-to-end before I
   wire it to ShipIt?

After confirmation, I'll add ShipIt-side config and we'll do a real
end-to-end test with a small agent task.
```

## Open questions

- Should `voiceSummary` have a hard length cap? Probably soft — "one or two sentences" in the instruction is enough nudge. If the agent over-shoots, Hermes can truncate.
- Does Hermes need a `tools/list_changed` notification to inform the agent of new tools? No for v1 — only one tool, defined statically.
- Two-way: the agent currently can't *receive* a reply from Hermes asynchronously (e.g. "user said: rebase onto main"). That's the future `ask_user_question` shape. Out of scope.

## Status of this doc

This is not a ShipIt feature. The doc lives in `docs/` so the configuration is reproducible and the contract is written down, but no ShipIt code changes follow from it. If/when ShipIt grows generic support for personal-assistant integrations as a first-class feature, this design becomes the reference for what the integration should look like from the user's side.
