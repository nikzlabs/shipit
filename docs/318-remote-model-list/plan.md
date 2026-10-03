---
issue: planning#622
title: Remote model list — design
description: The catalogue's model rows are exported to a committed JSON file; the orchestrator reads that file from main every 30 minutes, validates it, keeps the last good copy, and pushes it to browsers and session containers.
---

# 318 — Remote model list: design

Implements [`requirements.md`](./requirements.md).

## Shape

**The TypeScript catalogue stays the source; the JSON file is its export.**
`services.ts`, `model-identity.ts` and `model-vision.ts` keep their types,
shared price constants and provenance comments. `npm run catalogue:export`
writes their model rows to
[`src/server/shared/catalogue/models.json`](../../src/server/shared/catalogue/models.json),
and `model-list.test.ts` fails when the committed file differs from the export.
So a release embeds exactly what `main` published at the time it was cut
(req 3), and merging a catalogue change to `main` publishes it (reqs 1, 2).

Rejected: making the JSON the only source. It drops every provenance comment
and the compile-time checks (`MODEL_VISION` exhaustiveness, `ServiceId`
literals) for no gain the export does not already give.

### Document

```ts
interface ModelListDoc {
  schema: 1;
  services: Record<serviceId, Partial<Record<"sub" | "key", { models: ModelDef[]; retired: RetiredModel[] }>>>;
  vision: Record<canonicalModelKey, "yes" | "no" | "unverified">;
}
```

The document has no place for endpoints, credentials or new services, and
the parser reads nothing else (req 4). A document whose `schema` is not the
one this build knows is refused whole, so an incompatible format change on
`main` leaves older installs on what they have.

### Validation — `model-list.ts`, shared by server and client

`parseModelList(raw)` keeps a row only when this build can run it:

- the service and billing mode exist in this build (req 4);
- every style is a known style **and** the mode has an endpoint for it —
  otherwise the spawn would have no URL;
- `family` is a known family; `harnesses` is narrowed to known harness ids;
- a retirement names, for each retired style, a successor present in the same
  block's models with that style (the catalogue's own invariant);
- some harness this build has can run the row: it speaks one of the row's
  styles and the row does not exclude it;
- prices are zero or more and context windows are positive — the catalogue's
  negative "unknown" sentinels never ship.

A row's styles choose among the endpoints the release gives its own mode.
That choice is part of adding a model, so it cannot be refused; what req 4
guarantees is that the set of URLs a credential can reach is the release's.

A block with no valid model keeps the embedded block, so a broken edit cannot
empty a mode. Dropped rows are reported for the log.

### Live catalogue

`applyModelList(doc | undefined)` rebuilds the live services from the
embedded ones, replacing `models`/`retired` per block and merging `vision`.
`undefined` restores the embedded list. Every catalogue function reads the
live list, so no caller changes. Values that used to be computed once at
module load now read the live list: the context-window table (the
`MODEL_CONTEXT_WINDOWS` constant became `modelContextWindows()`), the harness
model lists (`capabilities.models` in `agent-registry.ts` and in the Claude
Code and Codex adapters), and the browser's display names
(`format-model.ts`, rebuilt when the list in effect changes).

## Orchestrator — `services/published-model-list.ts`

- **Source:** `https://raw.githubusercontent.com/nikzlabs/shipit/main/src/server/shared/catalogue/models.json`.
  A test pins the URL's path to the committed file, so moving the file fails
  CI instead of silently stranding every install.
- **When:** at startup and every 30 minutes after, from `startup-monitors.ts`
  beside the update check; never in test mode. Half the hour req 5 allows,
  because the CDN in front of `raw.githubusercontent.com` serves a merged file
  up to five minutes late.
- **Cache:** the last valid document is written to
  `<stateDir>/.shipit-model-list.json` and applied at startup before the
  first fetch, so a failed read leaves the install on the last list it read,
  across restarts (req 6). Every successful read rewrites a missing or stale
  cache, so one failed write heals on the next read. A failed fetch or an
  invalid document changes nothing. With no cache, the embedded list stands
  (req 3).
- **On change:** re-derive every harness's eligible models
  (`agentRegistry.refreshAuth`) and broadcast `agent_list`.

## Browser

`agent_list` and the `/api/bootstrap` response carry `modelList` while a published
list is active. The client applies it before it stores the agent list, and
storing the agent list is what re-renders the picker — so a new model shows
without a reload (req 5).

## Session containers

A worker's catalogue is the embedded one of its image, and it uses the model
list at spawn: Claude Code's `[1m]` suffix comes from the context window, and
OpenCode's image modalities from the vision verdict. So `/agent/start` and
`/agent/spawn` carry `modelList` while a published list is active, and the
worker applies it before it starts the agent. Local mode runs the adapters
in-process and already sees the live list.

## Limits

- A new model that needs new harness code (an id translation, a CLI that
  validates model ids against its own list) still needs a release. The row can
  restrict itself with `harnesses` until then.
- A commit to `main` reaches every install within an hour, on every update
  channel. Catalogue changes on `main` are live changes.

## Key files

- `src/server/shared/catalogue/model-list.ts` — document type, export, parse, apply.
- `src/server/shared/catalogue/models.json` — the published file (generated).
- `scripts/export-model-list.ts` — `npm run catalogue:export`.
- `src/server/orchestrator/services/published-model-list.ts` — fetch, cache, refresh.
