# Checklist — Credential for a declared Git LFS host

- [x] `lfs:` section in `shipit.yaml`: one exact host, not github.com, an
      identifier-named secret; anything else warns and is ignored
- [x] Parse the secret as a credential-store line; refuse any other scheme, a
      path, a missing half, or a host other than the declared one
- [x] Register one LFS host resolver at boot, read by `resolveTreeRemoteCredential`
      only for the four LFS transfers; a ref push, fetch or ls-remote never carries it
- [x] Key the secret by ShipIt's record of the tree's repository (session row, or
      repo store for a bare cache), never the agent-editable `origin`; record
      `remoteUrl` before the pull in the claim slow path and the fork
- [x] Keep the LFS credential on the anonymous retry after the remote refuses
      its token
- [x] Refuse a trailing-dot host and a secret with a control character; read
      `:443` as the default port
- [x] A second origin-scoped helper for the LFS host, secret in the environment
      only, after the `credential.helper=` reset — also when the remote has no token
- [x] Read a bare cache's declaration from the ref its LFS fetch uses
- [x] The session's credential broker answers the declared host only
      (`https`, exact host), and returns a refusal as a warning
- [x] `shipit-git-credential` prints that warning on stderr
- [x] Report a refusal on the push, the pulls and the shared store's fill
- [x] Tests: parser, secret parsing, resolver (checkout, bare cache, lookup key),
      shared attach and config against real git, broker route, shim, pull warning,
      and an end-to-end push against a real HTTPS LFS server requiring Basic auth
- [x] Agent-facing docs (`shipit-yaml.md`, `environment.md`, `secrets.md`) and
      the wiki
