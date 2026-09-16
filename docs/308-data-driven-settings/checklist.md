# Data-driven settings UI — checklist

This branch's deliverable is the design set. The implementation order lives in
[plan.md](plan.md) → *Slices*, and the work is tracked on planning#580.

- [x] Requirements written, from what the user asked for
- [x] Per-setting inventory: all 77 declarations, with their store, agent policy and target control
- [x] Design: two declaration fields, a machine-readable route store, a shared scalar reader and writer, a control table by value kind
- [x] Subtraction review, and the design cut down to what it found
- [x] Pull-request review, and its corrections folded in — P17 to P19
- [ ] Requirement 12 reopened: decide what replaces the coverage walk's copy and reachability guarantees
