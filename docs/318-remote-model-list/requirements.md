---
issue: planning#622
title: Remote model list
description: ShipIt reads its model list from a JSON file on the ShipIt repository's main branch, so a new model needs no release, and falls back to the list embedded in the release.
---

# 318 — Remote model list: requirements

New models are released often, and today every one of them needs a ShipIt
release before a user can pick it. This feature removes that step.

1. A model can become available on existing ShipIt installs without a new
   ShipIt release.

2. The list of models is published as a JSON file in the ShipIt repository,
   on its `main` branch.

3. When ShipIt cannot read the published list, it uses the list embedded in
   its own release.

## Open questions

- What may the published list change? Only models (add a model, change its
  label, price, context window, reasoning levels or image support, retire it) —
  or also services, their endpoints and their credentials? An endpoint in this
  file decides which URL receives a user's API key.
- How soon must a new model in the published list appear on a running install:
  without a restart, within a set time — or only at the next restart?
- After ShipIt has read the published list once, and later cannot read it (no
  network, file removed), what does it use: the last list it read, or the list
  embedded in its release?

## Resolved questions

- None yet.
