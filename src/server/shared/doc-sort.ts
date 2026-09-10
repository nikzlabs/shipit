function numericPrefix(segment: string): number | null {
  const match = /^(\d+)/.exec(segment);
  return match ? Number.parseInt(match[1], 10) : null;
}

function compareSegment(a: string, b: string): number {
  const pa = numericPrefix(a);
  const pb = numericPrefix(b);

  if (pa !== null && pb !== null) {
    if (pa !== pb) return pb - pa;
    return a.localeCompare(b);
  }

  if (pa !== null) return -1;
  if (pb !== null) return 1;

  return a.localeCompare(b);
}

/** Numbered segments sort newest first, ahead of unnumbered segments sorted A–Z. */
export function compareDocsByRecency(a: string, b: string): number {
  if (a === b) return 0;
  const aSegs = a.split("/");
  const bSegs = b.split("/");
  const len = Math.min(aSegs.length, bSegs.length);

  for (let i = 0; i < len; i++) {
    const cmp = compareSegment(aSegs[i], bSegs[i]);
    if (cmp !== 0) return cmp;
  }

  return aSegs.length - bSegs.length;
}
