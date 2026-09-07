---
title: ChatGPT subscriptions in OpenCode — requirements
description: Use a connected ChatGPT account with OpenCode inside ShipIt.
---

# ChatGPT subscriptions in OpenCode

## Requirement source

The user asked to investigate OpenCode's OpenAI subscription support, then
said: “go ahead and design this integration”, then “go ahead and implement it.”
This change implements the account integration.

The user goal is to use ChatGPT subscription access with the OpenCode harness
inside ShipIt. The requirements below express the requested experience and
safety constraints. Shared account storage and token projection are design
choices, not additional requests from the user.

## Requirements

1. A user can select OpenCode with a supported OpenAI model and subscription
   billing. ShipIt shows the selected service, model, and billing mode.
2. An existing connected ChatGPT account works without a second sign-in. A new
   user connects ChatGPT through the existing ShipIt account flow. Only the
   provider's authentication page opens outside ShipIt (§1–§3).
3. Codex and OpenCode use the same account identity, quota, cutoffs, and account
   selection rules. Switching tools must not create a second quota pool.
4. A subscription failure must never cause a silent switch to API billing,
   another service, or an unrelated account. Existing same-service subscription
   failover rules apply.
5. Concurrent sessions, long turns, restart, account changes, and disconnect
   must not introduce a second refresh-token writer through OpenCode. A token
   for account A must never be sent as account B.
6. Authentication errors and quota failures appear inside ShipIt with the
   correct OpenAI account. Recovery must be bounded. A failed turn keeps its
   edits through the existing turn settlement path.
7. Normal turns, resume, compaction, reviews, and background model tasks use
   the same account delivery rule. A path that cannot meet it is unavailable
   with an explicit reason, rather than silently using a different credential.
8. Existing OpenCode API-key routes and existing Codex accounts continue to
   work. No user must migrate files or paste subscription tokens.
9. ShipIt offers only model and capability combinations verified for this
   route. Subscription usage remains subscription usage; API-price estimates
   are not presented as charges.

The user subsequently authorized implementation. The initial supported model is
GPT-5.5; additional models need runtime validation before they are offered.

## Scope

ChatGPT subscription access only. No Copilot or Anthropic subscription work,
new inference proxy, second OpenAI account list, or standalone OpenCode login
screen. No change to the session's pinned harness rule.
