import { describe, it, expect } from 'vitest';
import { resolveTags, autoDetectTags } from '../src/metadata.js';
import type { ResolvedMetadataConfig } from '../src/types.js';

describe('autoDetectTags', () => {
  it('extracts first meaningful directory', () => {
    expect(autoDetectTags('src/controllers/user.ts')).toEqual(['controllers']);
  });

  it('skips common root dirs', () => {
    expect(autoDetectTags('lib/models/user.rb')).toEqual(['models']);
  });

  it('handles app root dir', () => {
    expect(autoDetectTags('app/services/auth/login.ts')).toEqual(['services']);
  });

  it('returns empty for top-level file', () => {
    expect(autoDetectTags('user.ts')).toEqual([]);
  });

  it('returns empty for single directory', () => {
    expect(autoDetectTags('src/index.ts')).toEqual([]);
  });

  it('handles nested paths under common roots', () => {
    expect(autoDetectTags('packages/server/src/indexer.ts')).toEqual(['server']);
  });

  it('handles Windows-style paths', () => {
    expect(autoDetectTags('src\\controllers\\user.ts')).toEqual(['controllers']);
  });
});

describe('resolveTags', () => {
  it('returns explicit tags', () => {
    const metadata: ResolvedMetadataConfig = {
      service: 'test',
      bounded_context: null,
      tags: ['api', 'auth'],
      directory_tags: {},
      git: { enabled: true, maxCommitsPerFile: 50, ticketPatterns: [] },
    };
    const tags = resolveTags(metadata, 'README.md');
    expect(tags).toContain('api');
    expect(tags).toContain('auth');
  });

  it('adds directory_tags when path matches', () => {
    const metadata: ResolvedMetadataConfig = {
      service: 'test',
      bounded_context: null,
      tags: [],
      directory_tags: {
        'src/controllers': ['controller', 'api'],
      },
      git: { enabled: true, maxCommitsPerFile: 50, ticketPatterns: [] },
    };
    const tags = resolveTags(metadata, 'src/controllers/user.ts');
    expect(tags).toContain('controller');
    expect(tags).toContain('api');
  });

  it('does not add directory_tags when path does not match', () => {
    const metadata: ResolvedMetadataConfig = {
      service: 'test',
      bounded_context: null,
      tags: [],
      directory_tags: {
        'src/controllers': ['controller'],
      },
      git: { enabled: true, maxCommitsPerFile: 50, ticketPatterns: [] },
    };
    const tags = resolveTags(metadata, 'src/models/user.ts');
    expect(tags).not.toContain('controller');
  });

  it('combines explicit tags, directory_tags, and auto-detected tags', () => {
    const metadata: ResolvedMetadataConfig = {
      service: 'test',
      bounded_context: null,
      tags: ['auth'],
      directory_tags: {
        'src/controllers': ['controller'],
      },
      git: { enabled: true, maxCommitsPerFile: 50, ticketPatterns: [] },
    };
    const tags = resolveTags(metadata, 'src/controllers/login.ts');
    expect(tags).toContain('auth');
    expect(tags).toContain('controller');
    expect(tags).toContain('controllers'); // auto-detected
  });

  it('deduplicates tags', () => {
    const metadata: ResolvedMetadataConfig = {
      service: 'test',
      bounded_context: null,
      tags: ['controllers'],
      directory_tags: {
        'src/controllers': ['controllers'],
      },
      git: { enabled: true, maxCommitsPerFile: 50, ticketPatterns: [] },
    };
    const tags = resolveTags(metadata, 'src/controllers/user.ts');
    const controllersCount = tags.filter((t) => t === 'controllers').length;
    expect(controllersCount).toBe(1);
  });
});
