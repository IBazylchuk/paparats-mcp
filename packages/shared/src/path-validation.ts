import fs from 'fs';
import path from 'path';

/**
 * Glob syntax that can turn an innocent-looking entry into a parent-directory
 * segment once the path is joined into a glob pattern: brace expansion
 * (`{..,src}`), character classes (`[.][.]`), backslash escapes (`\.\.`), and
 * `?`, `!` and extglob groups. `*` is allowed: it never matches `.` or `..`,
 * and `app/**` is a documented way to write a subtree.
 */
const UNSAFE_GLOB_CHARS = /[{}[\]?!()\\]/;

/**
 * Validate indexing paths: no absolute paths, no path traversal, no glob syntax
 * that could expand to a traversal, and no symlink resolving outside the project.
 * Ensures all paths stay within the project directory to prevent
 * reading sensitive files from outside the project (e.g. via malicious .paparats.yml).
 */
export function validateIndexingPaths(paths: string[], projectDir: string): void {
  const resolvedProject = path.resolve(projectDir);
  const realProject = realpathOrNull(resolvedProject);
  for (const p of paths) {
    if (path.isAbsolute(p)) {
      throw new Error(`Absolute paths not allowed in indexing.paths: ${p}`);
    }
    if (UNSAFE_GLOB_CHARS.test(p)) {
      throw new Error(
        `Glob syntax not allowed in indexing.paths (use plain directory names): ${p}`
      );
    }
    const fullPath = path.resolve(projectDir, p);
    if (!isInside(resolvedProject, fullPath)) {
      throw new Error(`Path must be inside project directory: ${p}`);
    }
    // Lexically inside, but a symlinked directory can still point elsewhere.
    // Only checkable when both ends exist; a missing path globs to nothing.
    const realPath = realProject ? realpathOrNull(fullPath) : null;
    if (realProject && realPath && !isInside(realProject, realPath)) {
      throw new Error(`Path must be inside project directory (resolves through a symlink): ${p}`);
    }
  }
}

/**
 * Drop files that must never be indexed even though a glob matched them:
 * anything whose real path (symlinks resolved) is outside `root`, anything
 * inside a `.git` directory (its config can carry a token-bearing remote URL),
 * and dangling or unreadable links. Guards against a committed symlink such as
 * `leak.ts -> ../../.ssh/id_rsa` or `notes.md -> .git/config`.
 *
 * Returns the surviving entries unchanged (not their real paths), in input
 * order. Relative entries are resolved against `root`. Returns `[]` when `root`
 * itself cannot be resolved.
 */
export function filterFilesWithinRoot(files: string[], root: string): string[] {
  const realRoot = realpathOrNull(path.resolve(root));
  if (!realRoot) return [];
  return files.filter((file) => {
    const real = realpathOrNull(path.resolve(root, file));
    if (!real || real === realRoot || !isInside(realRoot, real)) return false;
    return !path.relative(realRoot, real).split(path.sep).includes('.git');
  });
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}
