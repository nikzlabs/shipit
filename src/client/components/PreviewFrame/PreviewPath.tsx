import { useState, useRef } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";

interface PreviewPathProps {
  /** Path + query + hash of the page the preview is on, or null when unknown. */
  path: string | null;
  /** The same location as an absolute URL, used for click-to-copy. */
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

  // Render the empty region anyway so the toolbar layout doesn't shift when a
  // path arrives (or never does — a non-proxied local preview has no injected
  // script to report one). An empty *chip* would read as "this page has no URL".
  if (!path) return <div className="flex-1 min-w-0" />;

  // Everything from the first "?" is the query string, shown dimmer: the route
  // is what you actually read. Splitting on "?" rather than stripping
  // `location.search` also does the right thing for hash routers, where the
  // real route lives in the hash (`/#/orders?tab=open` → route `/#/orders`).
  const qIdx = path.indexOf("?");
  const route = qIdx === -1 ? path : path.slice(0, qIdx);
  const query = qIdx === -1 ? "" : path.slice(qIdx);
  const isRoot = route === "/" && !query;

  const copy = async () => {
    if (!fullUrl || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(fullUrl);
    } catch {
      // Rejects on a denied permission or an insecure context. The full URL is
      // already in the tooltip, so there is nothing to recover or report.
      return;
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex-1 min-w-0 flex items-center gap-1">
      <button
        onClick={() => void copy()}
        title={fullUrl ?? path}
        aria-label={`Copy preview URL${fullUrl ? `: ${fullUrl}` : ""}`}
        className="group flex items-baseline min-w-0 gap-0 px-1.5 py-0.5 rounded border border-transparent font-mono text-[11px] hover:bg-(--color-bg-tertiary) hover:border-(--color-border-secondary) transition-colors cursor-pointer"
      >
        <span className={`truncate min-w-0 shrink ${isRoot ? "text-(--color-text-tertiary)" : "text-(--color-text-primary)"}`}>
          {route}
        </span>
        {query && (
          // Shrinks far more eagerly than the route, so a long query gives up
          // its space first instead of both truncating proportionally and
          // costing the user the part that says where they are.
          <span className="truncate min-w-0 shrink-[999] text-(--color-text-tertiary)">{query}</span>
        )}
        <span className="ml-1.5 shrink-0 self-center text-(--color-text-tertiary) group-hover:text-(--color-text-secondary)">
          {copied
            ? <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" data-testid="preview-path-copied" />
            : <CopyIcon size={ICON_SIZE.XS} />}
        </span>
      </button>
    </div>
  );
}
