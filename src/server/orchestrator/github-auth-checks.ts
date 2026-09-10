import { fetchGitHub } from "./github-api.js";

export async function getCheckStatus(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number }> {
  let passed = 0, failed = 0, pending = 0;

  try {
    const statusRes = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`,
      token,
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

  try {
    const checksRes = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs`,
      token,
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
    const res = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`,
      token,
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

export async function getJobLogs(
  token: string,
  owner: string,
  repo: string,
  jobId: number,
): Promise<string> {
  try {
    const res = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      token,
      { redirect: "follow" },
    );

    if (!res.ok) return "";

    const text = await res.text();
    return text;
  } catch {
    return "";
  }
}
