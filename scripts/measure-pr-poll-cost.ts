#!/usr/bin/env tsx
/**
 * Phase 0 measurement script for docs/155-pr-poll-query-scoping.
 *
 * Runs the two candidate PR-status query shapes against a real GitHub repo
 * and reports the GraphQL `rateLimit.cost` charged for each. This is the
 * authoritative per-call points charge — the same number GitHub uses to
 * decide whether to rate-limit.
 *
 * Shapes measured:
 *   - Bulk (current production):  pullRequests(first: N)
 *       Light variant (no conversation fields)
 *       Heavy variant (with conversation fields — issue comments + review threads)
 *   - Aliased candidate:          K aliased pullRequest(number: $n) selections
 *       Light, heavy, and mixed (heavy on one, light on the rest)
 *
 * Methodology notes:
 *   - We include `rateLimit { cost limit remaining resetAt }` in every query.
 *   - All bulk variants share the same connection cap (`first: 30` files,
 *     `first: 10` contexts, `last: 3` deployments, etc.) used in production.
 *   - Aliased variants reuse the identical per-PR selection set so cost
 *     differences are attributable to the bulk wrapper, not the inner shape.
 *   - For aliased queries we need real PR numbers. We do one cheap GraphQL
 *     lookup to grab the first K open-PR numbers from the target repo and
 *     use those.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx npx tsx scripts/measure-pr-poll-cost.ts \
 *     --owner nicolasalt --repo shipit \
 *     [--out docs/155-pr-poll-query-scoping/cost-measurements.md]
 *
 * Exit non-zero on auth / network failure; rate-limit cost itself is a value,
 * not a failure mode.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface CliArgs {
  owner: string;
  repo: string;
  out?: string;
  token: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--owner") { out.owner = value; i++; }
    else if (flag === "--repo") { out.repo = value; i++; }
    else if (flag === "--out") { out.out = value; i++; }
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) die("GITHUB_TOKEN env var is required (use a PAT with `repo` scope or a GitHub App installation token).");
  if (!out.owner || !out.repo) die("--owner and --repo are required.");
  return { owner: out.owner, repo: out.repo, out: out.out, token };
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

interface RateLimit {
  cost: number;
  limit: number;
  remaining: number;
  resetAt: string;
  nodeCount?: number;
}

interface GqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
}

/** Per-PR selection set — kept verbatim from pr-status-parser.ts so cost
 *  comparison is apples-to-apples. */
const PR_NODE_FIELDS_LIGHT = `
  number
  title
  body
  createdAt
  author { login avatarUrl }
  url
  state
  mergeable
  autoMergeRequest { mergeMethod }
  headRefName
  baseRefName
  additions
  deletions
  files(first: 100) {
    nodes { path additions deletions changeType }
  }
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 10) {
            nodes {
              ... on CheckRun {
                databaseId
                name
                status
                conclusion
                title
                detailsUrl
              }
              ... on StatusContext {
                context
                state
              }
            }
          }
        }
        deployments(last: 3) {
          nodes {
            environment
            latestStatus { state environmentUrl }
            createdAt
            creator { login }
          }
        }
      }
    }
  }
`;

const CONVERSATION_FIELDS = `
  comments(last: 30) {
    nodes {
      id
      body
      createdAt
      url
      author { login avatarUrl }
    }
  }
  reviewThreads(first: 30) {
    nodes {
      id
      isResolved
      isOutdated
      path
      line
      comments(first: 50) {
        nodes {
          id
          body
          createdAt
          author { login avatarUrl }
        }
      }
    }
  }
`;

function prNodeFields(includeConversation: boolean): string {
  return includeConversation ? `${PR_NODE_FIELDS_LIGHT}${CONVERSATION_FIELDS}` : PR_NODE_FIELDS_LIGHT;
}

const RATE_LIMIT_TRAILER = `
  rateLimit {
    cost
    limit
    remaining
    resetAt
    nodeCount
  }
`;

function buildBulkQuery(first: number, includeConversation: boolean): string {
  return `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: ${first}, states: [OPEN]) {
          nodes {
            ${prNodeFields(includeConversation)}
          }
        }
      }
      ${RATE_LIMIT_TRAILER}
    }
  `;
}

/** Builds an aliased query that fetches K specific PR numbers, optionally
 *  with one of them upgraded to the heavy conversation variant ("mixed" mode). */
function buildAliasedQuery(
  numbers: number[],
  heavyMode: "none" | "all" | "first-only",
): string {
  const aliases = numbers.map((n, i) => {
    const isHeavy = heavyMode === "all" || (heavyMode === "first-only" && i === 0);
    return `
      pr${i}: pullRequest(number: ${n}) {
        ${prNodeFields(isHeavy)}
      }
    `;
  }).join("\n");

  return `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${aliases}
      }
      ${RATE_LIMIT_TRAILER}
    }
  `;
}

const PR_NUMBERS_QUERY = `
  query($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: $first, states: [OPEN]) {
        nodes { number }
      }
    }
    ${RATE_LIMIT_TRAILER}
  }
`;

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ env: GqlEnvelope<T> & { data?: T & { rateLimit?: RateLimit } }; httpStatus: number }> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "shipit-pr-poll-cost-measurement",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let env: GqlEnvelope<T> & { data?: T & { rateLimit?: RateLimit } };
  try {
    env = JSON.parse(text) as typeof env;
  } catch {
    die(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return { env, httpStatus: res.status };
}

interface MeasurementRow {
  shape: string;
  /** N for bulk, K for aliased */
  n: number;
  variant: "light" | "heavy" | "mixed";
  cost: number | "error";
  nodeCount?: number;
  prsReturned?: number;
  notes?: string;
}

async function measureBulk(
  token: string,
  owner: string,
  repo: string,
  first: number,
  variant: "light" | "heavy",
): Promise<MeasurementRow> {
  const includeConversation = variant === "heavy";
  const query = buildBulkQuery(first, includeConversation);
  const { env, httpStatus } = await graphql<{ repository?: { pullRequests?: { nodes: unknown[] } } }>(
    token, query, { owner, name: repo },
  );
  if (env.errors?.length) {
    return { shape: "bulk", n: first, variant, cost: "error", notes: env.errors.map((e) => e.message).join("; ") };
  }
  const cost = env.data?.rateLimit?.cost ?? -1;
  const nodeCount = env.data?.rateLimit?.nodeCount;
  const prsReturned = env.data?.repository?.pullRequests?.nodes?.length;
  return {
    shape: "bulk",
    n: first,
    variant,
    cost: cost === -1 ? "error" : cost,
    nodeCount,
    prsReturned,
    notes: cost === -1 ? `http ${httpStatus} no rateLimit` : undefined,
  };
}

async function measureAliased(
  token: string,
  owner: string,
  repo: string,
  numbers: number[],
  variant: "light" | "heavy" | "mixed",
): Promise<MeasurementRow> {
  const heavyMode: "none" | "all" | "first-only" =
    variant === "light" ? "none" : variant === "heavy" ? "all" : "first-only";
  const query = buildAliasedQuery(numbers, heavyMode);
  const { env, httpStatus } = await graphql<Record<string, unknown>>(token, query, { owner, name: repo });
  if (env.errors?.length) {
    return { shape: "aliased", n: numbers.length, variant, cost: "error", notes: env.errors.map((e) => e.message).join("; ") };
  }
  const cost = env.data?.rateLimit?.cost ?? -1;
  const nodeCount = env.data?.rateLimit?.nodeCount;
  return {
    shape: "aliased",
    n: numbers.length,
    variant,
    cost: cost === -1 ? "error" : cost,
    nodeCount,
    notes: cost === -1 ? `http ${httpStatus} no rateLimit` : undefined,
  };
}

async function fetchPrNumbers(token: string, owner: string, repo: string, count: number): Promise<number[]> {
  const { env } = await graphql<{ repository?: { pullRequests?: { nodes: { number: number }[] } } }>(
    token, PR_NUMBERS_QUERY, { owner, name: repo, first: count },
  );
  if (env.errors?.length) die(`failed to fetch PR numbers: ${env.errors.map((e) => e.message).join("; ")}`);
  const nodes = env.data?.repository?.pullRequests?.nodes;
  if (!nodes || nodes.length === 0) die("no open PRs found on the target repo — pick a repo with ≥20 open PRs for a useful measurement.");
  return nodes.map((n) => n.number);
}

function renderTable(rows: MeasurementRow[]): string {
  const header = "| Shape | N (PRs in query) | Variant | Cost | nodeCount | PRs returned | Notes |";
  const sep = "|---|---:|---|---:|---:|---:|---|";
  const body = rows.map((r) => {
    const cost = typeof r.cost === "number" ? String(r.cost) : r.cost;
    return `| ${r.shape} | ${r.n} | ${r.variant} | ${cost} | ${r.nodeCount ?? ""} | ${r.prsReturned ?? ""} | ${r.notes ?? ""} |`;
  });
  return [header, sep, ...body].join("\n");
}

const BULK_N = [1, 5, 10, 20, 30] as const;
const ALIASED_K = [1, 5, 10, 20, 30] as const;

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`measuring GraphQL cost against ${args.owner}/${args.repo}`);

  const maxK = Math.max(...ALIASED_K);
  console.log(`fetching up to ${maxK} open PR numbers for aliased queries...`);
  const allNumbers = await fetchPrNumbers(args.token, args.owner, args.repo, maxK);
  console.log(`got ${allNumbers.length} open PRs.`);

  if (allNumbers.length < Math.max(...BULK_N)) {
    console.warn(`warning: repo has only ${allNumbers.length} open PRs; bulk N=${Math.max(...BULK_N)} will return fewer nodes than requested.`);
  }

  const rows: MeasurementRow[] = [];

  for (const n of BULK_N) {
    console.log(`bulk N=${n} light...`);
    rows.push(await measureBulk(args.token, args.owner, args.repo, n, "light"));
    console.log(`bulk N=${n} heavy...`);
    rows.push(await measureBulk(args.token, args.owner, args.repo, n, "heavy"));
  }

  for (const k of ALIASED_K) {
    const subset = allNumbers.slice(0, k);
    if (subset.length < k) {
      console.warn(`skipping aliased K=${k} (only ${subset.length} PRs available).`);
      continue;
    }
    console.log(`aliased K=${k} light...`);
    rows.push(await measureAliased(args.token, args.owner, args.repo, subset, "light"));
    console.log(`aliased K=${k} heavy...`);
    rows.push(await measureAliased(args.token, args.owner, args.repo, subset, "heavy"));
    if (k > 1) {
      console.log(`aliased K=${k} mixed (1 heavy + ${k - 1} light)...`);
      rows.push(await measureAliased(args.token, args.owner, args.repo, subset, "mixed"));
    }
  }

  const table = renderTable(rows);
  console.log("\n" + table + "\n");

  if (args.out) {
    const outPath = resolve(process.cwd(), args.out);
    const doc = renderMarkdownReport(args.owner, args.repo, rows, allNumbers.length);
    writeFileSync(outPath, doc, "utf8");
    console.log(`wrote ${outPath}`);
  }
}

function renderMarkdownReport(owner: string, repo: string, rows: MeasurementRow[], totalOpenPrs: number): string {
  const now = new Date().toISOString();
  return `# PR poll cost measurements

Measured against \`${owner}/${repo}\` on ${now}. Source repo had ${totalOpenPrs} open PRs at measurement time (the aliased K range tops out here if smaller than 30).

The \`cost\` column is GitHub's authoritative \`rateLimit.cost\` value — the same number that's deducted from the 5,000-points/hour primary budget. \`nodeCount\` is GitHub's count of objects loaded; useful for sanity-checking that bulk vs. aliased are walking comparable amounts of data.

${renderTable(rows)}

## Reading the table

- Compare \`bulk N=X / heavy\` vs. \`aliased K=X / heavy\` at the same X. The delta is the cost of the bulk wrapper for a fixed number of PRs in the response.
- Compare \`bulk N=30 / heavy\` (today's worst case when the PR tab is open on any session in the repo) vs. \`aliased K=1 / heavy\` (Phase 2 best case: only the active session is due). This is the headline savings target.
- \`aliased K=N / mixed\` shows Phase 1's "scope conversation fields to focused session only" win: heavy fields on one session, light on the rest in the same call.

See \`docs/155-pr-poll-query-scoping/plan.md\` Phase 0 for the decision branches.
`;
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
