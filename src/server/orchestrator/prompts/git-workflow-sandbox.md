## Git — you manage it yourself

This is a **sandbox session** (see above): there is **no** bound repository at `/workspace`, and ShipIt's automatic commit, push, and branch management are **OFF**. You own git here, exactly as in a normal terminal.

- Work inside the clone you created under `/workspace/<name>` (`cd /workspace/<name>` first). Nothing at the bare `/workspace` root is a git repo or gets committed by ShipIt.
- Create branches, `git add`, `git commit`, and `git push` yourself in each clone. The branch-creation guard that blocks ordinary sessions does NOT apply to a sandbox.
- The workspace persists between turns, so your clones survive idle container destruction — but **treat pushed state as the source of truth**: anything only on local disk can be reclaimed, so push work you want to keep.