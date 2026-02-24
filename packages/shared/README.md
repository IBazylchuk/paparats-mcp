# @paparats/shared

Shared utilities for [Paparats MCP](https://github.com/IBazylchuk/paparats-mcp) - path validation, gitignore filtering, and language-aware exclude patterns used by the server and CLI packages.

## Install

```bash
npm install @paparats/shared
```

## API

### Path Validation

```ts
import { validateIndexingPaths } from '@paparats/shared';

// Rejects absolute paths and path traversal in indexing config
const errors = validateIndexingPaths(['src', '../etc/passwd']);
// errors: ['Path traversal not allowed: ../etc/passwd']
```

### Gitignore Filtering

```ts
import { createGitignoreFilter, filterFilesByGitignore } from '@paparats/shared';

// Per-file check
const filter = createGitignoreFilter('/path/to/repo');
if (filter('node_modules/foo.js')) {
  // file is gitignored
}

// Bulk filter
const included = filterFilesByGitignore('/path/to/repo', allFiles);
```

### Exclude Patterns

```ts
import {
  normalizeExcludePatterns,
  getDefaultExcludeForLanguages,
  LANGUAGE_EXCLUDE_DEFAULTS,
  COMMON_EXCLUDE,
  DEFAULT_EXCLUDE_BARE,
} from '@paparats/shared';

// Bare dir names become glob patterns: 'node_modules' -> '**/node_modules/**'
const patterns = normalizeExcludePatterns(['node_modules', 'dist']);

// Get default excludes for specific languages
const excludes = getDefaultExcludeForLanguages(['typescript', 'python']);
```

## Part of Paparats MCP

This package provides shared utilities used by:

- **[@paparats/cli](https://www.npmjs.com/package/@paparats/cli)** - CLI tool for project indexing and setup
- **@paparats/server** - MCP server with semantic code search ([Docker image](https://hub.docker.com/r/ibaz/paparats-server))

## License

MIT
