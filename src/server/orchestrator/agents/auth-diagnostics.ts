import { stripAnsi } from "../../shared/strip-ansi.js";
import type { LoginIntegrationId } from "../../shared/catalogue/types.js";
import type { AgentAuthPhase } from "../../shared/types/ws-server-messages.js";

/**
 * The record of one sign-in, as the panel in Settings shows it.
 *
 * **Harness-neutral, and it lives beside `agent-auth-base.ts` for that reason.**
 * It was `agents/claude/auth-diagnostics.ts`, with `loginId` pinned to the
 * `"anthropic-oauth"` literal and a `claude_*` source union — so every other
 * harness's sign-in could report nothing, and a failing Antigravity login left
 * the user with one summary sentence and no way to see what the CLI said. The
 * SSE layer was already generic (`app-lifecycle.ts` forwards `progress` and
 * `log` from every manager in `authManagers`); only these types were not.
 */

export type AgentAuthLogLevel = "debug" | "info" | "warn" | "error";

/** `cli_*` is whichever harness CLI the flow spawned; `shipit` is our own line. */
export type AgentAuthLogSource = "shipit" | "cli_stdout" | "cli_stderr" | "cli_control";

export interface AgentAuthProgressPayload {
  loginId: LoginIntegrationId;
  accountId?: string;
  attemptId: string;
  phase: AgentAuthPhase;
  message: string;
  elapsedMs?: number;
}

export interface AgentAuthLogPayload {
  loginId: LoginIntegrationId;
  accountId?: string;
  attemptId: string;
  timestamp: string;
  level: AgentAuthLogLevel;
  source: AgentAuthLogSource;
  message: string;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_ASSIGNMENT_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|code_verifier|code_challenge|state|session|ticket|jwt|bearer)\b\s*[:=]\s*([^\s"',;]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-[A-Za-z0-9._-]+/g;
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
/**
 * Every harness keeps its credentials in a dot-directory of the account HOME,
 * and the set is open (`.claude`, `.codex`, `.gemini`, and whatever the next
 * harness brings), so this matches the shape rather than a list that silently
 * stops covering a newly added backend.
 */
const ROOT_SECRET_PATH_PATTERN = /\/root\/\.[A-Za-z][\w.-]*(?:\/[^\s"'<>)]*)?/g;
const CREDENTIALS_PATH_PATTERN = /\/credentials\/[^\s"'<>)]*/g;

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?[redacted]" : "";
    url.hash = url.hash ? "#[redacted]" : "";
    return url.toString();
  } catch {
    return "[url redacted]";
  }
}

/**
 * **A sign-in URL does not survive this, and must not be logged through it.** An
 * OAuth link is all query string, and that is exactly what is stripped — so a
 * manager reports that the link arrived, and the link itself reaches the user as
 * the challenge's button, which is not sanitized.
 */
export function sanitizeAuthDiagnostic(input: string): string {
  return stripAnsi(input)
    .replace(URL_PATTERN, (url) => sanitizeUrl(url))
    .replace(EMAIL_PATTERN, "[email redacted]")
    .replace(ANTHROPIC_KEY_PATTERN, "sk-ant-[redacted]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(TOKEN_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[redacted]`)
    .replace(ROOT_SECRET_PATH_PATTERN, "/root/.[redacted]")
    .replace(CREDENTIALS_PATH_PATTERN, "/credentials/[redacted]")
    .replace(LONG_SECRET_PATTERN, (value) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return value;
      }
      return "[redacted]";
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
