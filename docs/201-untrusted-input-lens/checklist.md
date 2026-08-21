# Untrusted-input lens — checklist (planning#100, Gap 4)

- [x] Reusable provenance-envelope mechanism (`shared/untrusted-input.ts` —
      `wrapUntrustedContent`, extensible source map, boundary defang). (Moved to
      `shared/` by planning#87 so the session-side issue shim can reuse it.)
- [x] Enroll the orchestrator-brokered file/upload ingestion point
      (`formatFileContext` in `validation.ts`) into the envelope.
- [x] Defang envelope-marker and `<file>`-tag breakout in attacker content.
- [x] Documented lens in the system prompt ("## Untrusted input") covering all
      four surfaces (uploads, repo files, web fetch, MCP returns) so new
      surfaces inherit by default.
- [x] Agent-facing reference `shipit-docs/untrusted-input.md` + prompt pointer.
- [x] Record the treatment in `SECURITY-MODEL.md`.
- [x] Tests: envelope unit tests, `formatFileContext` enrollment + breakout,
      system-prompt assertion, file-context integration assertion.
- [x] Design doc (`docs/201`) cross-linked to planning#100 and to the planning#87 slice.

## Deliberately out of scope (owned elsewhere — keep disjoint)

- [x] Issue-text envelope wiring → planning#87 / `docs/176` (enrolled via the `issue` source;
      the `shipit issue` shim wraps fetched title/body/comments).
- [ ] Egress allowlist (the actual exfil barrier) → planning#92 / Gap 1.
- [ ] Per-repo code-execution trust gate → planning#98 / `docs/178`.
