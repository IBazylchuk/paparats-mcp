import type { ResolvedMetadataConfig } from './types.js';

/**
 * Resolve tags for a file path based on metadata config.
 * Combines explicit tags with directory-matched tags.
 */
export function resolveTags(metadata: ResolvedMetadataConfig, filePath: string): string[] {
  const tags = new Set<string>(metadata.tags);

  // Match directory_tags: check if filePath starts with any configured directory prefix
  const normalizedPath = filePath.replace(/\\/g, '/');
  for (const [dir, dirTags] of Object.entries(metadata.directory_tags)) {
    const normalizedDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedPath.startsWith(normalizedDir + '/') || normalizedPath === normalizedDir) {
      for (const tag of dirTags) {
        tags.add(tag);
      }
    }
  }

  // Auto-detect tags from path if no directory_tags matched anything extra
  const autoTags = autoDetectTags(filePath);
  for (const tag of autoTags) {
    tags.add(tag);
  }

  return Array.from(tags);
}

/**
 * Auto-detect tags from a file path based on its directory structure.
 * Extracts the first meaningful directory name after the root.
 *
 * Examples:
 *   "src/controllers/user.ts" -> ["controllers"]
 *   "lib/models/user.rb" -> ["models"]
 *   "app/services/auth/login.ts" -> ["services"]
 *   "user.ts" -> [] (no directory)
 */
export function autoDetectTags(filePath: string): string[] {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/').filter(Boolean);

  // Need at least 2 parts (directory + filename) to extract a directory tag
  if (parts.length < 2) return [];

  // Common root directories to skip when looking for meaningful directory names
  const rootDirs = new Set(['src', 'lib', 'app', 'pkg', 'internal', 'cmd', 'packages']);

  // Walk through path parts to find the first meaningful directory
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!rootDirs.has(part)) {
      return [part];
    }
  }

  return [];
}
