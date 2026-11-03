const MAX_JOBS_LISTED = 10;
const MAX_JOB_CHARS = 300;

/** A CLI job description is the agent's label or the whole command, so each is cut to one short line. */
export function listBackgroundJobs(jobs: readonly string[]): string[] {
  const lines = jobs.slice(0, MAX_JOBS_LISTED).map((job) => {
    const oneLine = job.replace(/\s+/g, " ").trim();
    return oneLine.length > MAX_JOB_CHARS ? `${oneLine.slice(0, MAX_JOB_CHARS)}…` : oneLine;
  });
  const more = jobs.length - lines.length;
  return more > 0 ? [...lines, `and ${more} more`] : lines;
}
