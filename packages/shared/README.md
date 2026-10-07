# @paparats/shared

Shared utilities for [Paparats MCP](https://github.com/IBazylchuk/paparats-mcp) - path validation, gitignore filtering, and language-aware exclude patterns used by the server and CLI packages.

## Install

```bash
npm install @paparats/shared
```

## API

### Path Validation

```ts
import { validateIndexingPaths, filterFilesWithinRoot } from '@paparats/shared';

// Throws on absolute paths, path traversal, glob syntax that could expand to a
// traversal ({..,src}, [.][.]), and symlinked directories leading outside the project
validateIndexingPaths(['src', '../etc/passwd'], '/path/to/repo');
// Error: Path must be inside project directory: ../etc/passwd

// Drop globbed files whose real path is outside the root, inside .git, or a dangling link
const safe = filterFilesWithinRoot(allFiles, '/path/to/repo');
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

// .gitignore-style: bare names match at any depth, paths with '/' are root-relative,
// and both cover everything beneath a matching directory:
// 'node_modules' -> '**/node_modules', '**/node_modules/**'
// 'spec/fixtures' -> 'spec/fixtures', 'spec/fixtures/**'
const patterns = normalizeExcludePatterns(['node_modules', 'spec/fixtures']);

// Get default excludes for specific languages
const excludes = getDefaultExcludeForLanguages(['typescript', 'python']);
```

## Part of Paparats MCP

This package provides shared utilities used by:

- **[@paparats/cli](https://www.npmjs.com/package/@paparats/cli)** - CLI tool for project indexing and setup
- **@paparats/server** - MCP server with semantic code search ([Docker image](https://hub.docker.com/r/ibaz/paparats-server))

## License

MIT
