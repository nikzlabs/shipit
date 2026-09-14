import type { ToolDescriptor } from "./types.js";
import {
  validateRepoSessionProposal,
  MAX_PROMPT_LEN,
  MAX_REPO_LEN,
  MAX_SESSION_TITLE_LEN,
} from "../../shared/repo-session-proposal-validation.js";

const TOOL_DESCRIPTION = [
  "Propose work that belongs in a DIFFERENT repository than the one you are in,",
  "as a card the user starts with one click. Use it the moment you conclude that",
  "a change has to happen somewhere else — the API repo you consume, a shared",
  "library, an infrastructure repo — instead of writing the instruction into chat",
  "for the user to copy into a session they make by hand. One click starts an",
  "ordinary session on that repository and sends your prompt, so the prompt must",
  "stand on its own: the agent there has none of this conversation, and a",
  "different repository on disk. Name the repository as `owner/repo`; ShipIt",
  "resolves it against the GitHub account the user connected and rejects this",
  "call if it cannot reach it, so you find out now rather than the user finding",
  "out on the click. The started session is INDEPENDENT — you cannot message it,",
  "wait on it, or hear when it merges, so put everything it needs in the prompt.",
  "Do NOT use it for work in the repository you are already in (that is just your",
  "own work), and do not use it to fan out your current task.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    repo: {
      type: "string",
      maxLength: MAX_REPO_LEN,
      description:
        "The target repository as `owner/repo` (a clone URL also works). It must be a repository "
        + "the user's connected GitHub account can write to, and it must not be the repository you are in.",
    },
    title: {
      type: "string",
      maxLength: MAX_SESSION_TITLE_LEN,
      description:
        `Short sidebar name for the new session (≤${MAX_SESSION_TITLE_LEN} chars), e.g. "Add cursor pagination to /events".`,
    },
    prompt: {
      type: "string",
      maxLength: MAX_PROMPT_LEN,
      description:
        `The first message the new session receives — at most ${MAX_PROMPT_LEN} characters. It must be `
        + "self-contained: the agent reading it has a different repository checked out and none of this "
        + "conversation. State the goal, the constraints, and what to read there; name files, docs and "
        + "issues rather than pasting their contents. Say which repository the request came from, so the "
        + "agent can see the other half of a contract it is being asked to match.",
    },
  },
  required: ["repo", "title", "prompt"],
};

const INSTRUCTIONS = [
  "When work you identify belongs in a different repository than the one you are",
  "working in, propose it with `propose_repo_session` instead of writing the",
  "instruction into chat for the user to copy elsewhere. One click starts a",
  "session on that repository with your prompt already sent. The prompt must be",
  "self-contained — the session that receives it has a different repository",
  "checked out and none of this conversation.",
].join(" ");

export const proposeRepoSessionTool: ToolDescriptor = {
  id: "propose_repo_session",
  name: "propose_repo_session",
  description: TOOL_DESCRIPTION,
  inputSchema,
  instructions: INSTRUCTIONS,
  async call(args, { workerUrl }) {
    const a = args as { repo?: unknown; title?: unknown; prompt?: unknown };

    const pre = validateRepoSessionProposal(a);
    if ("error" in pre) {
      return {
        content: [{ type: "text", text: `propose_repo_session failed: ${pre.error}` }],
        isError: true,
      };
    }

    try {
      const res = await fetch(`${workerUrl}/agent-ops/propose-repo-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pre),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        repo?: string;
        registered?: boolean;
      };
      if (!res.ok) {
        const reason = body.error || `propose_repo_session service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `propose_repo_session failed: ${reason}` }],
          isError: true,
        };
      }
      const repo = body.repo ?? pre.repo;
      const newRepoNote = body.registered === false
        ? ` ${repo} is not in ShipIt yet; the card says so, and starting it adds the repository.`
        : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Posted a card proposing a session on ${repo}.${newRepoNote} `
              + "The user starts it with one click, and it runs independently of this session — "
              + "you will not hear back from it. Do not repeat the proposal in prose; end your turn.",
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `propose_repo_session could not reach the worker: ${message}` },
        ],
        isError: true,
      };
    }
  },
};
