import { Button } from "../ui/button.js";

/**
 * The message the "Ask the agent to set it up" button sends.
 *
 * Lives here, next to the copy that offers it, because `dispatchAgentMessage`
 * appends this verbatim as a visible user bubble — it is chat the user appears
 * to have written, not a private instruction, so it is held to the same bar as
 * the invite above it and names no path, skill, or config key. The agent has
 * /shipit-docs/compose.md and the android-build skill already.
 *
 * The last sentence is load-bearing. The invite asks a question, so "no" has to
 * be an answer the agent may give; without it the button pushes it into fitting
 * a library or a CLI with a preview nobody wanted.
 */
export const PREVIEW_SETUP_PROMPT =
  "Set up a live preview for this repo, so the app runs in ShipIt's preview panel. "
  + "Check whether the repo contains a web app or an Android app, and configure whichever you find. "
  + "If there is nothing here that a preview would show, say so instead of adding configuration.";

/**
 * The empty preview panel's illustration: a browser window and a phone drawn as
 * empty slots, with a chat bubble pointing at them.
 *
 * Bespoke line art rather than composed Phosphor glyphs, under the illustration
 * exception in the design-language skill — no glyph carries the two facts this
 * state has to land at a glance: these are the app *kinds* that can appear here,
 * and *chat* is what puts them there. Purely decorative, so it is hidden from
 * assistive tech: the copy beside it already says everything it says. Motion
 * stops under `prefers-reduced-motion` (index.css).
 */
function PreviewSetupArt() {
  return (
    <svg
      width="200"
      height="144"
      viewBox="0 0 200 144"
      fill="none"
      // `max-w-full h-auto` so the art shrinks with the pane instead of being
      // clipped: the right panel is user-resizable well below 200px.
      className="mx-auto max-w-full h-auto overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="preview-invite-glow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx="100" cy="62" rx="92" ry="60" fill="url(#preview-invite-glow)" />

      <g className="preview-art-float">
        {/* Browser window — the web app slot */}
        <g transform="translate(6 12)">
          <rect
            x="0" y="0" width="118" height="88" rx="9"
            fill="var(--color-bg-secondary)"
            stroke="var(--color-border-secondary)"
            strokeWidth="1.5"
          />
          <path d="M0 20 h118" stroke="var(--color-border-secondary)" strokeWidth="1.5" />
          <circle cx="12" cy="10" r="2.6" fill="var(--color-text-tertiary)" opacity="0.5" />
          <circle cx="21" cy="10" r="2.6" fill="var(--color-text-tertiary)" opacity="0.5" />
          <circle cx="30" cy="10" r="2.6" fill="var(--color-text-tertiary)" opacity="0.5" />
          <rect x="42" y="6.5" width="62" height="7" rx="3.5" fill="var(--color-bg-tertiary)" />
          <rect
            className="preview-art-dash"
            x="12" y="32" width="94" height="44" rx="7"
            fill="var(--color-accent)" fillOpacity="0.12"
            stroke="var(--color-accent)" strokeWidth="1.5"
            strokeDasharray="6 5" opacity="0.75"
          />
        </g>

        {/* Phone — the Android app slot */}
        <g transform="translate(132 34) rotate(7)">
          <rect
            x="0" y="0" width="46" height="82" rx="10"
            fill="var(--color-bg-secondary)"
            stroke="var(--color-border-secondary)"
            strokeWidth="1.5"
          />
          <rect x="16" y="5" width="14" height="3" rx="1.5" fill="var(--color-text-tertiary)" opacity="0.5" />
          <rect
            className="preview-art-dash"
            x="6" y="14" width="34" height="56" rx="6"
            fill="var(--color-accent)" fillOpacity="0.12"
            stroke="var(--color-accent)" strokeWidth="1.5"
            strokeDasharray="6 5" opacity="0.75"
          />
          <rect x="15" y="74" width="16" height="2.5" rx="1.25" fill="var(--color-text-tertiary)" opacity="0.45" />
        </g>

        <g className="preview-art-sparkle" fill="var(--color-accent)">
          <path d="M118 8 l1.6 4.4 4.4 1.6 -4.4 1.6 -1.6 4.4 -1.6 -4.4 -4.4 -1.6 4.4 -1.6 z" />
        </g>
        <g className="preview-art-sparkle preview-art-sparkle-late" fill="var(--color-accent)">
          <path d="M186 24 l1.1 3 3 1.1 -3 1.1 -1.1 3 -1.1 -3 -3 -1.1 3 -1.1 z" />
        </g>
      </g>

      {/* Chat bubble + arrow — chat is how an app gets into those slots */}
      <g transform="translate(14 104)">
        <path
          d="M0 8 a8 8 0 0 1 8 -8 h44 a8 8 0 0 1 8 8 v10 a8 8 0 0 1 -8 8 h-30 l-10 8 v-8 h-4 a8 8 0 0 1 -8 -8 z"
          fill="var(--color-bg-tertiary)"
          stroke="var(--color-border-secondary)"
          strokeWidth="1.5"
        />
        <circle className="preview-art-blink" cx="19" cy="13" r="2.8" fill="var(--color-accent)" />
        <circle className="preview-art-blink preview-art-blink-2" cx="30" cy="13" r="2.8" fill="var(--color-accent)" />
        <circle className="preview-art-blink preview-art-blink-3" cx="41" cy="13" r="2.8" fill="var(--color-accent)" />
      </g>
      <path
        d="M78 112 C 96 112, 104 104, 108 94"
        stroke="var(--color-accent)" strokeWidth="1.5"
        strokeDasharray="3 4" opacity="0.55" fill="none"
      />
      <path d="M108 94 l-3.6 5 6 .4 z" fill="var(--color-accent)" opacity="0.55" />
    </svg>
  );
}

interface PreviewSetupInviteProps {
  /** Called when the user asks the agent to set a preview up. */
  onSendToAgent?: () => void;
}

/**
 * Shown in the preview panel when the session has no preview configured.
 *
 * The copy names what the *user* has (a web or Android app) and what to do
 * about it, and deliberately says nothing about how ShipIt runs it — `compose`
 * and `shipit.yaml` are ours to know, and a user who just connected a repo has
 * no way to read them as anything but a chore. It is also phrased as a question
 * rather than an instruction, because for a backend-only, library, or CLI repo
 * the honest answer is "no", and the old copy left no room for one.
 */
export function PreviewSetupInvite({ onSendToAgent }: PreviewSetupInviteProps) {
  return (
    // `max-h-full overflow-y-auto` keeps the button reachable rather than
    // clipped when the pane is short or the user has zoomed the browser in.
    <div className="text-center max-w-sm px-4 max-h-full overflow-y-auto">
      <PreviewSetupArt />
      {/* text-lg font-semibold is the documented heading step (design-language
          skill). Tailwind's preflight resets heading sizes to inherit, so
          without it this would silently render at the overlay's body size. */}
      <h2 className="text-lg font-semibold text-(--color-text-primary) mt-5 mb-1.5">Your app can run here</h2>
      <p className="text-sm text-(--color-text-secondary) leading-relaxed">
        Do you have a <span className="text-(--color-text-primary) font-medium">web</span> or{" "}
        <span className="text-(--color-text-primary) font-medium">Android</span> app in this repo?
        Ask the agent to set it up. It then runs in this panel while you build.
      </p>
      {/* The Button base is `whitespace-nowrap h-8`, which clips this label out
          of the panel's right edge once the pane is dragged to ~200px wide.
          Overriding both (twMerge lets className win) lets it wrap to two lines
          and grow instead — measured, it overflowed by 19px at 200px before. */}
      {onSendToAgent && (
        <Button
          variant="primary"
          size="md"
          onClick={onSendToAgent}
          className="mt-4 h-auto min-h-8 py-1.5 max-w-full whitespace-normal"
        >
          Ask the agent to set it up
        </Button>
      )}
    </div>
  );
}
