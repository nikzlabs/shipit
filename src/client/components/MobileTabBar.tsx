/**
 * MobileTabBar — bottom navigation bar shown only on mobile viewports.
 *
 * Provides a fixed-bottom tab bar with "Chat" and "Preview" tabs so users
 * can switch between the chat panel and the preview/docs panel when the
 * side-by-side layout isn't available.
 *
 * Design:
 *   - Fixed to the bottom of the screen
 *   - Two tabs: Chat (message icon) and Preview (eye icon)
 *   - Active tab gets a blue highlight; inactive tabs are muted gray
 *   - The tab bar includes a top border to separate from content
 */

export type MobilePanel = "chat" | "preview";

export function MobileTabBar({
  activePanel,
  onChangePanel,
}: {
  activePanel: MobilePanel;
  onChangePanel: (panel: MobilePanel) => void;
}) {
  return (
    <nav
      className="flex border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950"
      aria-label="Mobile navigation"
    >
      <button
        onClick={() => onChangePanel("chat")}
        className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors ${
          activePanel === "chat"
            ? "text-blue-500 dark:text-blue-400"
            : "text-gray-500 active:text-gray-700 dark:active:text-gray-300"
        }`}
        aria-current={activePanel === "chat" ? "page" : undefined}
      >
        {/* Chat icon (speech bubble) */}
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
          />
        </svg>
        Chat
      </button>

      <button
        onClick={() => onChangePanel("preview")}
        className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors ${
          activePanel === "preview"
            ? "text-blue-500 dark:text-blue-400"
            : "text-gray-500 active:text-gray-700 dark:active:text-gray-300"
        }`}
        aria-current={activePanel === "preview" ? "page" : undefined}
      >
        {/* Preview icon (eye) */}
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
        Preview
      </button>
    </nav>
  );
}
