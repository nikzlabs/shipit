---
title: Agent interface SDK requirements
description: User-provided requirements for letting agent-created interfaces send messages to their owning ShipIt session.
---

# Agent interface SDK — requirements

## Provenance

This file contains only requirements stated by the user in the conversation that
created this design. It intentionally does not promote implementation ideas,
security measures, UX details, or anticipated extensions into requirements.

## User-provided requirements

1. ShipIt provides an API that lets an interaction in a debug UI—such as a
   service UI—or in a presented artifact send a message to the ShipIt agent of
   that session.
2. The API is exposed as a JavaScript SDK available to the page.
3. Page JavaScript can collect user input or other information before composing
   and sending the message to the agent.
4. The capability lets the agent create an interface for itself: the agent can
   create a page whose interactions send subsequent messages back to the agent.
5. The API is compatible with the planned page-visibility feature that lets a
   page detect that it is running inside ShipIt and mute itself when it is not
   visible.
6. For a repository-backed page, the existing **Trust this repository** action
   is the user consent that authorizes repository code to use this API. The SDK
   does not require a second confirmation solely because the message originates
   from that trusted repository's page.
7. SDK messages may be initiated programmatically without a recent user
   gesture. Agent-created tools may invoke the agent automatically, including
   from load, timer, or other asynchronous application logic.

## Not requirements

Everything else in [plan.md](./plan.md)—including the transport, API spelling,
trust boundaries, response shape, and proposed first-version scope—is a design
proposal or implementation consequence. It is not attributed to the user as a
requirement.
