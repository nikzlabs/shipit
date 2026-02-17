# Message Editing — Remaining Work

- Claude retains full context after UI truncation — after an edit, Claude may reference messages no longer visible in the UI. Possible fixes: start new CLI session with replayed prefix, CLI-level conversation truncation, or server-side replay mechanism. Low severity, matches ChatGPT behavior.
