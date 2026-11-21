import { glob } from 'glob';
import { filterFilesByGitignore, filterFilesWithinRoot } from '@paparats/shared';
import type { ProjectConfig } from './types.js';

/**
 * The files a project pass reads for the code index: every `patterns` glob
 * under the project directory minus `exclude`, symlinks that leave the project
 * dropped, then `.gitignore` applied when the project asks for it. Absolute
 * paths, in glob order per pattern.
 *
 * Shared by `Indexer.indexProjectWithReport` and the offline benchmark's
 * lexical arm, so both see exactly the same file set.
 */
export async function collectProjectFiles(
  project: Pick<ProjectConfig, 'path' | 'patterns' | 'exclude' | 'indexing'>
): Promise<string[]> {
  const fileSet = new Set<string>();
  for (const pattern of project.patterns) {
    const found = await glob(pattern, {
      cwd: project.path,
      absolute: true,
      ignore: project.exclude,
      nodir: true,
    });
    found.forEach((f) => fileSet.add(f));
  }
  // Globs follow symlinks: a committed `leak.ts -> .git/config` (a remote URL
  // carrying a token) or a link out of the repository would be read and made
  // searchable. Dropping them here also lets the orphan sweep remove anything
  // indexed through such a link before.
  let files = filterFilesWithinRoot(Array.from(fileSet), project.path);
  if (project.indexing.respectGitignore) {
    files = filterFilesByGitignore(files, project.path);
  }
  return files;
}
