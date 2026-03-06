/**
 * GitHub CI check operations — extracted from GitHubAuthManager.
 * Functions in this module handle check status, annotations, and job logs.
 */

const GITHUB_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ShipIt",
});

/**
 * Get CI check status for a PR's head commit.
 */
export async function getCheckStatus(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number }> {
  let passed = 0, failed = 0, pending = 0;

  // Get combined status (legacy status API)
  try {
    const statusRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`,
      { headers: GITHUB_HEADERS(token) },
    );

    if (statusRes.ok) {
      const statusData = (await statusRes.json()) as { statuses: { state: string }[] };
      for (const s of statusData.statuses) {
        if (s.state === "success") passed++;
        else if (s.state === "failure" || s.state === "error") failed++;
        else pending++;
      }
    }
  } catch {
    // ignore
  }

  // Also get check runs (GitHub Actions uses this API)
  try {
    const checksRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs`,
      { headers: GITHUB_HEADERS(token) },
    );

    if (checksRes.ok) {
      const checksData = (await checksRes.json()) as { check_runs: { conclusion: string | null; status: string }[] };
      for (const check of checksData.check_runs) {
        if (check.conclusion === "success") passed++;
        else if (check.conclusion === "failure" || check.conclusion === "cancelled" || check.conclusion === "timed_out") failed++;
        else if (check.status !== "completed") pending++;
      }
    }
  } catch {
    // ignore
  }

  const total = passed + failed + pending;
  const state = total === 0 ? "none" as const : failed > 0 ? "failure" as const : pending > 0 ? "pending" as const : "success" as const;

  return { state, total, passed, failed, pending };
}

/**
 * Get check run annotations (structured failure details with file paths and line numbers).
 * Returns empty array if the API call fails.
 */
export async function getCheckRunAnnotations(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
): Promise<{
  path: string;
  startLine: number;
  endLine: number;
  message: string;
  annotationLevel: "failure" | "warning" | "notice";
}[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`,
      { headers: GITHUB_HEADERS(token) },
    );

    if (!res.ok) return [];

    const data = (await res.json()) as {
      path: string;
      start_line: number;
      end_line: number;
      message: string;
      annotation_level: string;
    }[];
    return data.map((a) => ({
      path: a.path,
      startLine: a.start_line,
      endLine: a.end_line,
      message: a.message,
      annotationLevel: a.annotation_level as "failure" | "warning" | "notice",
    }));
  } catch {
    return [];
  }
}

/**
 * Get raw job logs for a check run (fallback when annotations aren't available).
 * Returns the last 100 lines of the log, or empty string on failure.
 * Note: the check run databaseId maps to the job ID for GitHub Actions.
 */
export async function getJobLogs(
  token: string,
  owner: string,
  repo: string,
  jobId: number,
): Promise<string> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      {
        headers: GITHUB_HEADERS(token),
        redirect: "follow",
      },
    );

    if (!res.ok) return "";

    const text = await res.text();
    return text;
  } catch {
    return "";
  }
}
