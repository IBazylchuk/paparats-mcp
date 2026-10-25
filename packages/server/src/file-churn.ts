import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * How often each file of a project changed, as its commit-count percentile
 * among the project's indexed files. Stored on every code point as
 * `file_churn`; `search_code` ranks files that change often slightly higher
 * (see `CHURN_WEIGHT` in ranking.ts), since that is where the code people ask
 * about tends to live.
 */

/**
 * Percentiles are rounded to this many steps, so writing them back takes one
 * payload update per step rather than one per file.
 */
export const CHURN_STEPS = 20;

/**
 * Non-merge commits touching each file under `dir`, keyed by path relative to
 * `dir`, up to `rev`. Null when `dir` is not in a git repository or git fails.
 */
export async function readFileCommitCounts(
  dir: string,
  rev = 'HEAD'
): Promise<Map<string, number> | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      [
        '-C',
        dir,
        // Paths with non-ASCII characters would otherwise come back quoted.
        '-c',
        'core.quotePath=false',
        'log',
        '--no-merges',
        '--format=%x01',
        '--name-only',
        '--relative',
        rev,
        '--',
        '.',
      ],
      { maxBuffer: 1024 * 1024 * 1024 }
    ));
  } catch {
    return null;
  }
  const counts = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    if (line === '' || line === '\x01') continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * Commit-count percentile in [0, 1] of each of `files` (ties share the middle
 * rank; files git does not know count as 0 commits), rounded to
 * {@link CHURN_STEPS} steps.
 */
export function churnPercentiles(
  files: string[],
  counts: Map<string, number>
): Map<string, number> {
  const out = new Map<string, number>();
  const n = files.length;
  if (n === 0) return out;
  const value = (f: string): number => counts.get(f) ?? 0;
  const sorted = files.map(value).sort((a, b) => a - b);
  const bound = (v: number, inclusive: boolean): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < v || (inclusive && sorted[mid]! === v)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const f of files) {
    const v = value(f);
    const below = bound(v, false);
    const equal = bound(v, true) - below;
    const p = n === 1 ? 1 : (below + 0.5 * equal) / n;
    out.set(f, Math.round(p * CHURN_STEPS) / CHURN_STEPS);
  }
  return out;
}
