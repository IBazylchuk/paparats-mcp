import path from 'path';

/**
 * Validate indexing paths: no absolute paths, no path traversal.
 * Ensures all paths stay within the project directory to prevent
 * reading sensitive files from outside the project (e.g. via malicious .paparats.yml).
 */
export function validateIndexingPaths(paths: string[], projectDir: string): void {
  const resolvedProject = path.resolve(projectDir);
  for (const p of paths) {
    if (path.isAbsolute(p)) {
      throw new Error(`Absolute paths not allowed in indexing.paths: ${p}`);
    }
    const fullPath = path.resolve(projectDir, p);
    const relative = path.relative(resolvedProject, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path must be inside project directory: ${p}`);
    }
  }
}
