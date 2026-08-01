# Requirements

1. Until the user clicks the existing “Trust this repository” button, messages to the agent are blocked for that repository.
2. The chat send button must be disabled while the repository is untrusted.
3. The server must independently enforce the block; disabling the client is not the security boundary.
4. The existing Trust action is the consent that enables agent messaging.
