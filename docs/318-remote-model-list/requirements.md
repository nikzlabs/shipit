---
issue: planning#622
title: Remote model list
description: ShipIt reads its model list from a JSON file on the ShipIt repository's main branch, so a new model needs no release, and falls back to the list embedded in the release.
---

# 318 — Remote model list: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

New models are released often, and today every one of them needs a ShipIt
release before a user can pick it. This feature removes that step.

1. A model can become available on existing ShipIt installs without a new
   ShipIt release.

2. The list of models is published as a JSON file in the ShipIt repository,
   on its `main` branch.

3. When ShipIt cannot read the published list, it uses the list embedded in
   its own release.

4. The published list changes models only: it can add a model to a service
   ShipIt already has, change a model's label, price, context window,
   reasoning levels or image support, and retire a model. Services, their
   endpoints and their credentials come from the release and nothing else.

5. A model added to the published list appears on a running install within
   an hour, without a restart. The model picker shows it without the user
   doing anything.

6. After ShipIt has read the published list once, a later failure to read it
   leaves ShipIt on the last list it read — also across a restart. ShipIt
   falls back to the embedded list (req 3) only when it has never read the
   published list.

## Open questions

- None.

## Resolved questions

- 2026-09-29 — What may the published list change? Nik: models only (req 4).
  Carries the constraint that a user's credential only ever goes to a URL the
  release names for that credential's service. Nik confirmed this wording
  on 2026-09-29: a new model picks one of its own service's endpoints.
- 2026-09-29 — How soon must a new model appear on a running install? Nik:
  within an hour, without a restart, and the picker updates on its own
  (req 5).
- 2026-09-29 — What does ShipIt use when a read fails after a successful
  one? Nik: the last list it read, kept across restarts (req 6).
