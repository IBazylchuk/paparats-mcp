import { describe, it, expect } from 'vitest';
import path from 'path';
import { validateIndexingPaths } from './path-validation.js';

describe('validateIndexingPaths', () => {
  const projectDir = path.resolve('/some/project');

  it('accepts valid relative paths', () => {
    expect(() => validateIndexingPaths(['./', 'src', 'lib/'], projectDir)).not.toThrow();
  });

  it('rejects absolute paths', () => {
    const absolutePath = path.sep === '\\' ? 'C:\\tmp' : '/tmp';
    expect(() => validateIndexingPaths([absolutePath], projectDir)).toThrow(
      'Absolute paths not allowed in indexing.paths'
    );
  });

  it('rejects path traversal', () => {
    expect(() => validateIndexingPaths(['../../etc'], projectDir)).toThrow(
      'Path must be inside project directory'
    );
  });

  it('rejects path traversal with single parent', () => {
    expect(() => validateIndexingPaths(['../'], projectDir)).toThrow(
      'Path must be inside project directory'
    );
  });
});
