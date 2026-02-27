/**
 * Vite plugin that injects an error-capture script into the preview HTML.
 *
 * The injected script:
 * 1. Listens for `window.onerror` and `window.onunhandledrejection`
 * 2. Overrides `console.error` and `console.warn`
 * 3. Sends captured errors to the parent window via `postMessage`
 *
 * The parent (ShipIt React app) listens for these messages via the
 * `usePreviewErrors` hook and surfaces them in the UI.
 */

const ERROR_CAPTURE_SCRIPT = `<script>
(function() {
  var send = function(type, data) {
    try {
      window.parent.postMessage(
        Object.assign({ source: 'shipit-preview', type: type }, data),
        '*'
      );
    } catch(e) {}
  };

  window.onerror = function(msg, src, line, col, err) {
    send('error', {
      message: String(msg),
      fileSrc: src,
      line: line,
      col: col,
      stack: err && err.stack ? err.stack : undefined
    });
    return false;
  };

  window.addEventListener('unhandledrejection', function(e) {
    send('error', {
      message: String(e.reason),
      stack: e.reason && e.reason.stack ? e.reason.stack : undefined
    });
  });

  var origError = console.error;
  console.error = function() {
    var args = Array.prototype.slice.call(arguments);
    send('console', { level: 'error', args: args.map(String) });
    origError.apply(console, args);
  };

  var origWarn = console.warn;
  console.warn = function() {
    var args = Array.prototype.slice.call(arguments);
    send('console', { level: 'warn', args: args.map(String) });
    origWarn.apply(console, args);
  };
})();
</script>`;

/**
 * Returns a Vite plugin configuration object that injects the error-capture
 * script into every HTML page served by the dev server.
 *
 * Usage in Vite config:
 *   plugins: [shipitErrorCapture()]
 */
export function shipitErrorCapturePlugin(): {
  name: string;
  transformIndexHtml: (html: string) => string;
} {
  return {
    name: "shipit-error-capture",
    transformIndexHtml(html: string): string {
      // Inject right after <head> so it runs before any app scripts
      const headIndex = html.indexOf("<head>");
      if (headIndex !== -1) {
        const insertPos = headIndex + "<head>".length;
        return html.slice(0, insertPos) + "\n" + ERROR_CAPTURE_SCRIPT + "\n" + html.slice(insertPos);
      }
      // Fallback: prepend to the HTML if no <head> tag found
      return ERROR_CAPTURE_SCRIPT + "\n" + html;
    },
  };
}

/** Exported for testing */
export { ERROR_CAPTURE_SCRIPT };
