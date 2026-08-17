/**
 * Display names for paths that share a leaf.
 *
 * Regions and backtest projects are both keyed by a working directory and
 * labelled with its last segment. Several checkouts called `opus` produce
 * several regions all displayed as "opus", which makes region-level stats
 * unreadable. Extending each colliding name by the shortest path suffix that
 * tells it apart keeps labels short while making them unambiguous.
 */

function segmentsOf(p: string): string[] {
  return p.split('/').filter((s) => s !== '');
}

/**
 * Maps each path to the shortest trailing run of segments unique among the
 * inputs — `opus` when it stands alone, `01-bugfix/opus` when it does not.
 * Paths with no distinguishing suffix keep their full value.
 */
export function distinguishingNames(paths: readonly string[]): Map<string, string> {
  const unique = [...new Set(paths)];
  const segments = new Map(unique.map((p) => [p, segmentsOf(p)]));
  const names = new Map<string, string>();

  for (const p of unique) {
    const segs = segments.get(p)!;
    if (segs.length === 0) {
      names.set(p, p);
      continue;
    }
    let name = p;
    for (let depth = 1; depth <= segs.length; depth += 1) {
      const candidate = segs.slice(-depth).join('/');
      const collides = unique.some(
        (other) => other !== p && segments.get(other)!.slice(-depth).join('/') === candidate
      );
      if (!collides) {
        name = candidate;
        break;
      }
    }
    names.set(p, name);
  }
  return names;
}
