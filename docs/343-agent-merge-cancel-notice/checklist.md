# Checklist

- [x] `AgentMergeClaimStore.retarget` and `setAgentInbox`
- [x] Inbox message on every executor ending, inside the ending transaction where there is one
- [x] Inbox message on settlement's not-merged paths
- [x] Inbox message on permission revocation
- [x] Rebase flow moves a pending request to the commit it pushed
- [x] Executor waits instead of cancelling when the head moved under a session hold
- [x] Conflict-resolution prompt names the armed merge
- [x] Agent docs (`shipit-docs/github.md`, wiki) and the `--auto` answer
- [x] Tests
