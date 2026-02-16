export function AuthOverlay({ url }: { url: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 text-center space-y-6">
        <div className="space-y-2">
          <div className="text-3xl">&#128274;</div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Authentication Required
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Claude Code CLI needs to authenticate with your Anthropic account.
            Click the link below to sign in.
          </p>
        </div>

        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          Open Authentication Page
        </a>

        <p className="text-xs text-gray-500">
          After signing in, this page will update automatically.
        </p>

        <div className="pt-2 border-t border-gray-200 dark:border-gray-800">
          <p className="text-xs text-gray-400 dark:text-gray-600 font-mono break-all">{url}</p>
        </div>
      </div>
    </div>
  );
}
