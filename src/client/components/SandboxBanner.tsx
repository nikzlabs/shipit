import { InfoIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { SessionCapabilities } from "../../server/shared/types.js";

/**
 * docs/211 — the Sandbox orientation banner. It occupies the chat panel's
 * PR-card slot for a `kind === "sandbox"` session (which has no PR lifecycle).
 *
 * This is **derived chrome**, NOT a chat-history card: it's rendered purely from
 * the session's durable `kind`/`capabilities` metadata (bootstrapped + on the
 * `sessions` row), so it survives reload / session switch / restart without
 * being persisted into the transcript. Deliberately the opposite of the
 * persist-on-emit card path (CLAUDE.md "transcript content must persist") — we
 * never want a banner copy in the scrollback that could duplicate on replay.
 *
 * Operational guidance for the agent (where to clone, use `gh` for PRs, pushed
 * state is the source of truth) lives in the system prompt, not here — this
 * banner is human-facing orientation only.
 */
export function SandboxBanner({ capabilities }: { capabilities?: SessionCapabilities }) {
  const granted: string[] = [];
  if (capabilities?.git) granted.push("GitHub");
  if (capabilities?.docker) granted.push("Docker");
  if (capabilities?.network) granted.push("Network");

  return (
    <div className="px-3 pt-1.5 pb-1">
      <div className="flex items-start gap-2.5 rounded-lg border border-(--color-sandbox-border) bg-(--color-sandbox-subtle) px-3.5 py-2.5 text-[12.5px]">
        <InfoIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0 mt-0.5 text-(--color-sandbox)" />
        <div className="min-w-0 text-(--color-text-secondary)">
          <span className="font-semibold text-(--color-sandbox)">Sandbox session — no repository bound.</span>{" "}
          The agent clones and pushes repos itself, so there&apos;s no live preview or PR card here.
          {granted.length > 0 && (
            <>
              {" "}Granted: <span className="font-semibold text-(--color-text-primary)">{granted.join(" · ")}</span>.
            </>
          )}
        </div>
      </div>
    </div>
  );
}
