/**
 * docs/303 — field validation for `propose_repo_session`, shared by the MCP tool
 * and the orchestrator route so the two cannot disagree about what is accepted.
 * Repository resolution and access checks live in the route; only shapes and
 * lengths are checked here.
 */

export const MAX_REPO_LEN = 200;
export const MAX_SESSION_TITLE_LEN = 60;
export const MAX_PROMPT_LEN = 4000;

export interface ValidatedRepoSessionProposal {
  repo: string;
  title: string;
  prompt: string;
}

// JSON Schema maxLength counts code points, not UTF-16 units.
function charLength(s: string): number {
  return /[\uD800-\uDBFF]/.test(s) ? Array.from(s).length : s.length;
}

function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  return typeof v === "string" ? v.trim() : "";
}

export function validateRepoSessionProposal(body: {
  repo?: unknown;
  title?: unknown;
  prompt?: unknown;
}): ValidatedRepoSessionProposal | { error: string } {
  const raw = body as Record<string, unknown>;

  const repo = field(raw, "repo");
  if (!repo) {
    return { error: "`repo` is required — the target repository, as `owner/repo` or a clone URL." };
  }
  if (charLength(repo) > MAX_REPO_LEN) {
    return { error: `\`repo\` is ${charLength(repo)} characters; the cap is ${MAX_REPO_LEN}.` };
  }

  const title = field(raw, "title");
  if (!title) {
    return { error: "`title` is required — the name the new session carries in the sidebar." };
  }
  if (charLength(title) > MAX_SESSION_TITLE_LEN) {
    return {
      error:
        `\`title\` is ${charLength(title)} characters; the cap is ${MAX_SESSION_TITLE_LEN}. `
        + "It is a sidebar label, not a summary.",
    };
  }

  const prompt = field(raw, "prompt");
  if (!prompt) {
    return { error: "`prompt` is required — the first message the new session receives." };
  }
  if (charLength(prompt) > MAX_PROMPT_LEN) {
    return {
      error:
        `\`prompt\` is ${charLength(prompt)} characters; the cap is ${MAX_PROMPT_LEN}. `
        + "Name the files, docs and issues to read instead of pasting their contents.",
    };
  }

  return { repo, title, prompt };
}
