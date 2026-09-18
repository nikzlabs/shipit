import { useState, useRef } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { ADDRESS_MEASURE_ATTR } from "../../hooks/usePreviewToolbarCollapse.js";

interface PreviewPathProps {

  path: string | null;

  fullUrl: string | null;
}

/**
 * Shows which page the preview is currently on — path and query string only,
 * never the host or port (docs/253 req 2). The host is a generated subdomain
 * (`a3f9c2--5173.localhost`) that tells the user nothing; it stays available
 * through click-to-copy, which yields the full absolute URL (req 4).
 *
 * The component owns its own toolbar region rather than joining the left group,
 * so it truncates on its own terms instead of competing with the port and
 * device selectors for width. Content is left-aligned (req 5): the path starts
 * at a fixed x position, so it stays where the eye last found it instead of
 * drifting as the route changes length.
 *
 * The separator that opens this region is rendered by PreviewToolbar, not here:
 * the Home button sits between it and the path, and must stay visible when this
 * component renders nothing because no path was ever reported.
 */
export function PreviewPath({ path, fullUrl }: PreviewPathProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // path arrives (or never does — a non-proxied local preview has no injected

  if (!path) return <div className="flex-1 min-w-0" />;

  const qIdx = path.indexOf("?");
  const route = qIdx === -1 ? path : path.slice(0, qIdx);
  const query = qIdx === -1 ? "" : path.slice(qIdx);
  const isRoot = route === "/" && !query;

  const copy = async () => {
    if (!fullUrl || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(fullUrl);
    } catch {

      return;
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (

    <div className="flex-1 min-w-7 flex items-center gap-1">
      <button
        onClick={() => void copy()}
        title={fullUrl ?? path}
        aria-label={`Copy preview URL${fullUrl ? `: ${fullUrl}` : ""}`}
        className="group flex items-baseline min-w-0 gap-0 px-1.5 py-0.5 rounded border border-transparent font-mono text-[11px] hover:bg-(--color-bg-tertiary) hover:border-(--color-border-secondary) transition-colors cursor-pointer"
      >
        {/* The measured element: the toolbar drops labels to keep this above
            ADDRESS_MIN_PX. Content-sized and shrinkable rather than hidden at a
            breakpoint, so it always renders as much of the URL as the region
            holds — a truncated address never leaves unused space beside it. */}
        <span
          {...{ [ADDRESS_MEASURE_ATTR]: "" }}
          className="flex items-baseline min-w-0 overflow-hidden"
        >
          <span className={`truncate min-w-0 shrink ${isRoot ? "text-(--color-text-tertiary)" : "text-(--color-text-primary)"}`}>
            {route}
          </span>
          {query && (

            <span className="truncate min-w-0 shrink-[999] text-(--color-text-tertiary)">{query}</span>
          )}
        </span>
        <span className="ml-1.5 shrink-0 self-center text-(--color-text-tertiary) group-hover:text-(--color-text-secondary)">
          {copied
            ? <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" data-testid="preview-path-copied" />
            : <CopyIcon size={ICON_SIZE.XS} />}
        </span>
      </button>
    </div>
  );
}
