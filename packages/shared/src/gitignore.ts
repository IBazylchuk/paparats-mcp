import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ign = require('ignore') as (opts?: object) => {
  add: (s: string) => { ignores: (p: string) => boolean };
};

const GITIGNORE = '.gitignore';

/**
 * Create a filter that returns true if the absolute path should be ignored by .gitignore.
 * Returns null if .gitignore doesn't exist. Paths must be relative to projectDir for matching.
 */
export function createGitignoreFilter(projectDir: string): ((absPath: string) => boolean) | null {
  const gitignorePath = path.join(projectDir, GITIGNORE);
  if (!fs.existsSync(gitignorePath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    return null;
  }

  const ig = ign().add(content);

  return (absPath: string): boolean => {
    const rel = path.relative(projectDir, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const normalized = rel.split(path.sep).join('/');
    return ig.ignores(normalized);
  };
}

/**
 * Filter file list by .gitignore. Returns files unchanged if .gitignore doesn't exist.
 */
export function filterFilesByGitignore(files: string[], projectDir: string): string[] {
  const filter = createGitignoreFilter(projectDir);
  if (!filter) return files;
  return files.filter((f) => !filter(f));
}
