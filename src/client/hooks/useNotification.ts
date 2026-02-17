import { useEffect, useRef, useCallback } from "react";

const DEFAULT_TITLE = "ShipIt";
const DONE_TITLE = "\u2713 Agent finished \u2014 ShipIt";

/**
 * Tracks tab visibility and provides a `notify` function that:
 * 1. Changes the document title when the tab is hidden
 * 2. Sends a browser Notification (if permission was granted)
 *
 * The title reverts when the user returns to the tab.
 */
export function useNotification() {
  const hiddenRef = useRef(document.hidden);
  const titleChangedRef = useRef(false);

  // Track tab visibility
  useEffect(() => {
    const onVisibilityChange = () => {
      hiddenRef.current = document.hidden;

      // Restore title when user returns to the tab
      if (!document.hidden && titleChangedRef.current) {
        document.title = DEFAULT_TITLE;
        titleChangedRef.current = false;
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const notify = useCallback((body: string) => {
    if (!hiddenRef.current) return;

    // Tab title change
    document.title = DONE_TITLE;
    titleChangedRef.current = true;

    // Browser notification
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("ShipIt", { body });
    }
  }, []);

  const requestPermission = useCallback(() => {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission();
    }
  }, []);

  return { notify, requestPermission };
}
