# Security Policy

ShipIt runs AI-agent-written code inside Docker containers and brokers credentials
(GitHub tokens, Anthropic/OpenAI subscription auth) on the user's behalf. We take
the isolation and credential-handling boundaries seriously and appreciate reports
that help us keep them sound.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.** Public issues
disclose the problem to everyone before a fix is available.

Instead, use **GitHub's private vulnerability reporting**:

1. Go to the [Security tab](https://github.com/nicolasalt/shipit/security) of the repository.
2. Click **Report a vulnerability**.
3. Describe the issue using the guidance below.

This opens a private advisory visible only to you and the maintainers. (Maintainers:
private reporting must be enabled under *Settings → Code security and analysis →
Private vulnerability reporting* for the link above to work.)

If you cannot use GitHub private reporting, you may instead open a regular issue
that contains **no exploit details** — just "I have a security report, please open
a private channel" — and a maintainer will follow up.

## What to include

A good report contains:

- The component affected (orchestrator, session worker, preview proxy, docker proxy, auth, git/credential handling, etc.).
- A description of the impact (what an attacker gains).
- Step-by-step reproduction, ideally with a minimal proof of concept.
- The version, commit SHA, or release channel (`stable` / `edge`) you tested against.
- Your assessment of severity and any suggested remediation.

## Scope — what counts

ShipIt's core function is to let an AI agent write and execute code, so **"the agent
ran code I asked it to" is not a vulnerability.** The interesting boundary failures are:

**In scope (please report):**

- Container escape — agent-controlled code breaking out of a session container to the host or the orchestrator.
- Cross-session leakage — one session reading another session's files, credentials, or memory.
- Credential exposure — GitHub/Anthropic/OpenAI tokens leaking into logs, error messages, responses, git remotes, or the browser of a different user.
- Orchestrator remote code execution or authentication/authorization bypass.
- Docker socket proxy (`docker-proxy.ts`) allowing operations beyond its intended allow-list.
- Preview proxy (`preview-proxy.ts`) SSRF or routing to unintended hosts/containers.
- Secret-store or credential-store disclosure, path traversal, or privilege escalation.

**Out of scope:**

- The agent executing code, editing files, or running shell commands within its own session container — that is the product working as designed.
- Findings that require an already-compromised host or pre-existing root access.
- Denial of service from intentionally pathological agent prompts (these are a cost/usage concern, not a boundary breach).
- Vulnerabilities in third-party dependencies with no demonstrated impact on ShipIt — report those upstream (we track dependency age and updates separately).

## Supported versions

ShipIt ships from two channels (see [RELEASING.md](RELEASING.md)):

| Channel  | Supported            |
|----------|----------------------|
| `stable` | ✅ Yes               |
| `edge`   | ✅ Yes (latest only) |

Fixes land on `edge` first and roll into the next `stable` release. We do not
backport security fixes to older tagged releases — upgrading to the current
`stable` is the supported remediation path.

## Disclosure process

- We aim to acknowledge a report within **5 business days**.
- We will work with you on a fix and a coordinated disclosure timeline; please give
  us a reasonable window (typically up to 90 days) before any public disclosure.
- With your permission, we will credit you in the advisory and release notes.

Thank you for helping keep ShipIt and its users safe.
