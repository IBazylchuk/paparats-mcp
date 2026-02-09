/**
 * Normalize exclude patterns: bare dir names become glob patterns to ignore entire dirs.
 * Patterns with / or ** are left unchanged.
 */
export function normalizeExcludePatterns(patterns: string[]): string[] {
  return patterns.map((p) => {
    if (p.includes('/') || p.includes('**')) return p;
    return `**/${p.replace(/^\//, '')}/**`;
  });
}
