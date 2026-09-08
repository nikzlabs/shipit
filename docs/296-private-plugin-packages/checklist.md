---
title: Private plugin packages — delivery checklist
description: Design review and implementation work for private npm plugin sources.
---

# Design

- [x] Record user outcomes separately from engineering decisions.
- [x] Trace current parsing, authentication, generation, and cache behavior.
- [x] Specify package contents, credentials, identity, activation, and recovery.
- [x] Complete independent design review and address its findings.

# Implementation (not part of the design task)

- [ ] Ship positive temporary-debris recognition before package IDs exist.
- [ ] Add normalized package sources and backwards-compatible revision types.
- [ ] Add registry settings, credential isolation, and the resolve broker.
- [ ] Add verified bounded downloads, safe extraction, and temporary-file cleanup.
- [ ] Integrate generations, install records, leases, runtime identity, and cleanup.
- [ ] Add inline package status, settings, update/rebuild behavior, and worker gating.
- [ ] Document package authoring and update the agent-facing platform reference.
- [ ] Pass focused tests, lint, typecheck, browser checks, and private acceptance.
