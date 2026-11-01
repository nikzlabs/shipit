# A Stop returns the queued messages to the input box — checklist

- [x] Requirements, with the user's two answers of 2026-10-12
- [x] Design, and an independent review of it before any code
- [x] Server: the Stop empties the queue (`queue-return.ts`, `agent-interrupt.ts`)
- [x] Server: the send order at acceptance, the cutoff, the second pass
- [x] Server: the returned list on `queue_updated`, on attach, and the acknowledgement
- [x] Server: the typed drain without its Stop branch; the compaction exemption removed
- [x] Server: the user's Kill follows the rule; a cancelled queue row is settled
- [x] Client: the input box takes the text and the files, saves the draft, then answers
- [x] Tests for each rule, and a mutation check of each
- [x] The sender check of requirement 3, in `plan.md`
- [x] Older documents and the wiki say the new behaviour
- [x] Independent review of the code, and its findings applied
