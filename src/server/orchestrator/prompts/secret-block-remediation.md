[secret-scan] Your last turn's changes were NOT committed. ShipIt's secret scanner refused the auto-commit because the staged diff contains what looks like a real credential:

{{FINDINGS}}

Nothing was committed or pushed — your edits are still in the working tree, and **every** later turn will also fail to commit until this is resolved. Anything you believed shipped has not shipped.

Fix it now:

1. Open each file listed above and look at the flagged line.
2. If it is a real credential, remove it. Replace it with an environment variable read (`process.env.X` or the language equivalent) and, if the value is genuinely needed at runtime, tell the user to add it under Settings → Secrets. Never invent a placeholder that still looks like a token.
3. If the credential was only ever an example, replace it with something that cannot be mistaken for real — a short, obviously-fake string with no valid prefix.

Do NOT silence the scanner. Adding a `gitleaks:allow` or `shipit:allow-secret` comment is not a fix, and you must not add one here even if you believe the match is a false positive — that decision is the user's, not yours. If after reading the line you are confident it is a false positive, leave the code as it is, explain in one or two sentences why you think it is safe, and tell the user they can add the allow-comment themselves. Then stop.

Report what you changed in one or two sentences. Do not start unrelated work in this turn.
