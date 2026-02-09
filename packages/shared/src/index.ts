export { validateIndexingPaths } from './path-validation.js';
export { normalizeExcludePatterns } from './exclude-patterns.js';
export {
  LANGUAGE_EXCLUDE_DEFAULTS,
  COMMON_EXCLUDE,
  DEFAULT_EXCLUDE_BARE,
  getDefaultExcludeForLanguages,
} from './language-excludes.js';
export { createGitignoreFilter, filterFilesByGitignore } from './gitignore.js';
