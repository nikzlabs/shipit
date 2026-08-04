import { stripAnsi } from "../../../shared/strip-ansi.js";

export type ClaudeAuthPhase =
  | "starting"
  | "waiting_for_cli"
  | "skipping_setup"
  | "waiting_for_url"
  | "waiting_for_code"
  | "checking_credentials"
  | "complete"
  | "failed";

export type ClaudeAuthLogLevel = "debug" | "info" | "warn" | "error";
export type ClaudeAuthLogSource = "shipit" | "claude_stdout" | "claude_stderr" | "claude_control";

export interface AgentAuthProgressPayload {
  agentId: "claude";
  accountId?: string;
  attemptId: string;
  phase: ClaudeAuthPhase;
  message: string;
  elapsedMs?: number;
}

export interface AgentAuthLogPayload {
  agentId: "claude";
  accountId?: string;
  attemptId: string;
  timestamp: string;
  level: ClaudeAuthLogLevel;
  source: ClaudeAuthLogSource;
  message: string;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_ASSIGNMENT_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|code_verifier|code_challenge|state|session|ticket|jwt|bearer)\b\s*[:=]\s*([^\s"',;]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-[A-Za-z0-9._-]+/g;
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const ROOT_SECRET_PATH_PATTERN = /\/root\/\.(claude|codex)(?:\/[^\s"'<>)]*)?/g;
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
 * Sanitize Claude CLI auth diagnostics before they are allowed onto the SSE
 * stream. The goal is useful structure, not perfect raw logs: redact full
 * auth URLs, OAuth codes/tokens, email addresses, and local credential paths.
 */
export function sanitizeClaudeAuthDiagnostic(input: string): string {
  return stripAnsi(input)
    .replace(URL_PATTERN, (url) => sanitizeUrl(url))
    .replace(EMAIL_PATTERN, "[email redacted]")
    .replace(ANTHROPIC_KEY_PATTERN, "sk-ant-[redacted]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(TOKEN_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[redacted]`)
    .replace(ROOT_SECRET_PATH_PATTERN, "/root/.[redacted]")
    .replace(CREDENTIALS_PATH_PATTERN, "/credentials/[redacted]")
    .replace(LONG_SECRET_PATTERN, (value) => {
      // UUIDs and ordinary long option names are useful and not secrets by
      // themselves; leave UUID-shaped text alone, redact opaque blobs.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return value;
      }
      return "[redacted]";
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
