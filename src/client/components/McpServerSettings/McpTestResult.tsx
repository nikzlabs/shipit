import type { McpTestResult as McpTestResultData } from "../../../server/shared/types.js";

export function McpTestResult({
  result,
}: {
  result: McpTestResultData | "loading" | undefined;
}) {
  if (result === "loading") {
    return <p className="text-xs text-(--color-text-tertiary)">Testing…</p>;
  }
  if (!result) return null;
  if (result.ok) {
    return (
      <p className="text-xs text-(--color-success)">
        Connected — {result.tools.length} tool(s):{" "}
        {result.tools.map((t) => t.name).join(", ") || "none"}
      </p>
    );
  }
  return <p className="text-xs text-(--color-error)">Test failed: {result.error}</p>;
}
