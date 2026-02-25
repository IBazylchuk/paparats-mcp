import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { PaparatsConfig } from '../src/types.js';
import {
  readConfig,
  resolveProject,
  loadProject,
  getLanguageProfile,
  getSupportedLanguages,
  detectLanguages,
  autoProjectConfig,
  CONFIG_FILE,
} from '../src/config.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function writeConfig(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, CONFIG_FILE), content, 'utf8');
}

const MINIMAL_CONFIG = `
group: my-group
language: ruby
`;

const FULL_CONFIG = `
group: my-group
language: [ruby, typescript]
indexing:
  paths: [src]
  chunkSize: 512
  overlap: 64
  concurrency: 4
  batchSize: 100
watcher:
  enabled: true
  debounce: 500
embeddings:
  provider: ollama
  model: jina-code-embeddings
  dimensions: 1536
`;

describe('Config', () => {
  describe('readConfig', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads minimal valid config', () => {
      writeConfig(tmpDir, MINIMAL_CONFIG);
      const config = readConfig(tmpDir);
      expect(config.group).toBe('my-group');
      expect(config.language).toBe('ruby');
    });

    it('throws when project dir does not exist', () => {
      const missing = path.join(tmpDir, 'nonexistent');
      expect(() => readConfig(missing)).toThrow('Project directory does not exist');
    });

    it('throws when config file not found', () => {
      expect(() => readConfig(tmpDir)).toThrow('Config not found');
    });

    it('throws when group is missing', () => {
      writeConfig(
        tmpDir,
        `
language: ruby
`
      );
      expect(() => readConfig(tmpDir)).toThrow("Missing required field 'group'");
    });

    it('throws when language is missing', () => {
      writeConfig(
        tmpDir,
        `
group: my-group
`
      );
      expect(() => readConfig(tmpDir)).toThrow("Missing required field 'language'");
    });

    it('rejects YAML with unsafe types (JSON_SCHEMA blocks !!js/function)', () => {
      writeConfig(
        tmpDir,
        `
group: test
language: ruby
injection: !!js/function >
  function() { return 1; }
`
      );
      expect(() => readConfig(tmpDir)).toThrow();
    });

    it('rejects invalid YAML structure', () => {
      writeConfig(tmpDir, 'not: valid: yaml: syntax:');
      expect(() => readConfig(tmpDir)).toThrow();
    });
  });

  describe('resolveProject', () => {
    const projectDir = path.resolve('/some/project');

    it('resolves minimal config with defaults', () => {
      const raw = { group: 'my-group', language: 'ruby' };
      const config = resolveProject(projectDir, raw);
      expect(config.group).toBe('my-group');
      expect(config.languages).toEqual(['ruby']);
      expect(config.indexing.chunkSize).toBe(1024);
      expect(config.indexing.overlap).toBe(128);
      expect(config.watcher.debounce).toBe(1000);
      expect(config.embeddings.provider).toBe('ollama');
      expect(config.patterns).toContain('**/*.rb');
    });

    it('deduplicates languages array', () => {
      const raw = { group: 'g', language: ['ruby', 'typescript', 'ruby'] };
      const config = resolveProject(projectDir, raw);
      expect(config.languages).toEqual(['ruby', 'typescript']);
    });

    it('merges multiple language profiles', () => {
      const raw = { group: 'g', language: ['ruby', 'typescript'] };
      const config = resolveProject(projectDir, raw);
      expect(config.patterns).toContain('**/*.rb');
      expect(config.patterns).toContain('**/*.ts');
      expect(config.patterns).toContain('**/*.tsx');
    });

    it('applies user indexing overrides', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        indexing: { chunkSize: 512, overlap: 64, concurrency: 4, batchSize: 100 },
      };
      const config = resolveProject(projectDir, raw);
      expect(config.indexing.chunkSize).toBe(512);
      expect(config.indexing.overlap).toBe(64);
      expect(config.indexing.concurrency).toBe(4);
      expect(config.indexing.batchSize).toBe(100);
    });

    it('scopes patterns to user paths when provided', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        indexing: { paths: ['src'] },
      };
      const config = resolveProject(projectDir, raw);
      expect(config.patterns.some((p) => p.startsWith('src'))).toBe(true);
      expect(config.patterns).toContain('src/**/*.rb');
    });

    describe('path validation', () => {
      it('rejects absolute paths', () => {
        const absolutePath = path.sep === '\\' ? 'C:\\tmp' : '/tmp';
        const raw = {
          group: 'g',
          language: 'ruby',
          indexing: { paths: [absolutePath] },
        };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'Absolute paths not allowed in indexing.paths'
        );
      });

      it('rejects path traversal', () => {
        const raw = {
          group: 'g',
          language: 'ruby',
          indexing: { paths: ['../../etc'] },
        };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'Path must be inside project directory'
        );
      });

      it('accepts valid relative paths', () => {
        const raw = {
          group: 'g',
          language: 'ruby',
          indexing: { paths: ['./', 'src', 'lib/'] },
        };
        const config = resolveProject(projectDir, raw);
        expect(config.indexing.paths).toEqual(['./', 'src', 'lib/']);
      });
    });

    describe('respectGitignore', () => {
      it('defaults to true', () => {
        const raw = { group: 'g', language: 'ruby' };
        const config = resolveProject(projectDir, raw);
        expect(config.indexing.respectGitignore).toBe(true);
      });

      it('accepts user override to false', () => {
        const raw = {
          group: 'g',
          language: 'ruby',
          indexing: { respectGitignore: false },
        };
        const config = resolveProject(projectDir, raw);
        expect(config.indexing.respectGitignore).toBe(false);
      });
    });

    describe('numeric validation', () => {
      it('rejects chunkSize out of range', () => {
        const raw = { group: 'g', language: 'ruby', indexing: { chunkSize: -1 } };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'chunkSize must be between 128 and 8192'
        );
      });

      it('rejects chunkSize too large', () => {
        const raw = { group: 'g', language: 'ruby', indexing: { chunkSize: 99999 } };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'chunkSize must be between 128 and 8192'
        );
      });

      it('rejects overlap >= chunkSize', () => {
        const raw = {
          group: 'g',
          language: 'ruby',
          indexing: { chunkSize: 256, overlap: 256 },
        };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'overlap must be between 0 and chunkSize'
        );
      });

      it('rejects concurrency out of range', () => {
        const raw = { group: 'g', language: 'ruby', indexing: { concurrency: 100 } };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'concurrency must be between 1 and 20'
        );
      });

      it('rejects batchSize out of range', () => {
        const raw = { group: 'g', language: 'ruby', indexing: { batchSize: 0 } };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'batchSize must be between 1 and 1000'
        );
      });

      it('rejects watcher.debounce too small', () => {
        const raw = { group: 'g', language: 'ruby', watcher: { debounce: 50 } };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'watcher.debounce must be between 100 and 10000ms'
        );
      });

      it('rejects watcher.debounce too large', () => {
        const raw = { group: 'g', language: 'ruby', watcher: { debounce: 50000 } };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'watcher.debounce must be between 100 and 10000ms'
        );
      });

      it('rejects watcher.stabilityThreshold too small', () => {
        const raw = { group: 'g', language: 'ruby', watcher: { stabilityThreshold: 50 } };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'watcher.stabilityThreshold must be between 100 and 10000ms'
        );
      });

      it('rejects watcher.stabilityThreshold too large', () => {
        const raw = { group: 'g', language: 'ruby', watcher: { stabilityThreshold: 20000 } };
        expect(() => resolveProject(projectDir, raw)).toThrow(
          'watcher.stabilityThreshold must be between 100 and 10000ms'
        );
      });

      it('accepts watcher.stabilityThreshold in range', () => {
        const raw = { group: 'g', language: 'ruby', watcher: { stabilityThreshold: 2000 } };
        expect(resolveProject(projectDir, raw).watcher.stabilityThreshold).toBe(2000);
      });
    });

    describe('embeddings validation', () => {
      it('rejects invalid provider', () => {
        const raw = {
          group: 'g',
          language: 'ruby',
          embeddings: { provider: 'invalid' },
        } as unknown as PaparatsConfig;
        expect(() => resolveProject(projectDir, raw)).toThrow('Invalid embeddings.provider');
      });

      it('accepts ollama and openai providers', () => {
        const rawOllama = {
          group: 'g',
          language: 'ruby',
          embeddings: { provider: 'ollama' as const },
        };
        const rawOpenai = {
          group: 'g',
          language: 'ruby',
          embeddings: { provider: 'openai' as const },
        };
        expect(resolveProject(projectDir, rawOllama).embeddings.provider).toBe('ollama');
        expect(resolveProject(projectDir, rawOpenai).embeddings.provider).toBe('openai');
      });
    });
  });

  describe('loadProject', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads and resolves config in one call', () => {
      writeConfig(tmpDir, FULL_CONFIG);
      const config = loadProject(tmpDir);
      expect(config.group).toBe('my-group');
      expect(config.languages).toEqual(['ruby', 'typescript']);
      expect(config.indexing.chunkSize).toBe(512);
      expect(config.indexing.paths).toEqual(['src']);
      expect(config.watcher.debounce).toBe(500);
    });
  });

  describe('getLanguageProfile', () => {
    it('returns profile for known language', () => {
      const profile = getLanguageProfile('ruby');
      expect(profile.patterns).toContain('**/*.rb');
      expect(profile.extensions).toContain('.rb');
    });

    it('falls back to generic for unknown language', () => {
      const profile = getLanguageProfile('brainfuck');
      expect(profile.patterns).toEqual(['**/*']);
    });
  });

  describe('getSupportedLanguages', () => {
    it('returns languages excluding generic', () => {
      const langs = getSupportedLanguages();
      expect(langs).toContain('ruby');
      expect(langs).toContain('typescript');
      expect(langs).not.toContain('generic');
    });
  });

  describe('git metadata config', () => {
    const projectDir = path.resolve('/some/project');

    it('resolves default git config when none provided', () => {
      const raw = { group: 'g', language: 'ruby' };
      const config = resolveProject(projectDir, raw);
      expect(config.metadata.git).toBeDefined();
      expect(config.metadata.git.enabled).toBe(true);
      expect(config.metadata.git.maxCommitsPerFile).toBe(50);
      expect(config.metadata.git.ticketPatterns).toEqual([]);
    });

    it('resolves partial git config with defaults', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        metadata: { git: { maxCommitsPerFile: 100 } },
      };
      const config = resolveProject(projectDir, raw);
      expect(config.metadata.git.enabled).toBe(true);
      expect(config.metadata.git.maxCommitsPerFile).toBe(100);
      expect(config.metadata.git.ticketPatterns).toEqual([]);
    });

    it('resolves git.enabled = false', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        metadata: { git: { enabled: false } },
      };
      const config = resolveProject(projectDir, raw);
      expect(config.metadata.git.enabled).toBe(false);
    });

    it('rejects maxCommitsPerFile below 1', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        metadata: { git: { maxCommitsPerFile: 0 } },
      };
      expect(() => resolveProject(projectDir, raw)).toThrow(
        'metadata.git.maxCommitsPerFile must be between 1 and 500'
      );
    });

    it('rejects maxCommitsPerFile above 500', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        metadata: { git: { maxCommitsPerFile: 501 } },
      };
      expect(() => resolveProject(projectDir, raw)).toThrow(
        'metadata.git.maxCommitsPerFile must be between 1 and 500'
      );
    });

    it('rejects invalid ticket patterns', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        metadata: { git: { ticketPatterns: ['[invalid'] } },
      };
      expect(() => resolveProject(projectDir, raw)).toThrow('Invalid ticket pattern');
    });

    it('accepts valid ticket patterns', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        metadata: { git: { ticketPatterns: ['TASK_\\d+', 'BUG-\\d+'] } },
      };
      const config = resolveProject(projectDir, raw);
      expect(config.metadata.git.ticketPatterns).toEqual(['TASK_\\d+', 'BUG-\\d+']);
    });

    it('parses git metadata from YAML file', () => {
      const tmpDir = createTempDir();
      try {
        writeConfig(
          tmpDir,
          `
group: my-group
language: ruby
metadata:
  git:
    enabled: true
    maxCommitsPerFile: 100
    ticketPatterns:
      - 'TASK_\\d+'
`
        );
        const config = loadProject(tmpDir);
        expect(config.metadata.git.enabled).toBe(true);
        expect(config.metadata.git.maxCommitsPerFile).toBe(100);
        expect(config.metadata.git.ticketPatterns).toEqual(['TASK_\\d+']);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('metadata config', () => {
    const projectDir = path.resolve('/some/project');

    it('resolves default metadata when none provided', () => {
      const raw = { group: 'g', language: 'ruby' };
      const config = resolveProject(projectDir, raw);
      expect(config.metadata).toBeDefined();
      expect(config.metadata.service).toBe('project');
      expect(config.metadata.bounded_context).toBeNull();
      expect(config.metadata.tags).toEqual([]);
      expect(config.metadata.directory_tags).toEqual({});
    });

    it('resolves metadata from config', () => {
      const raw = {
        group: 'g',
        language: 'ruby',
        metadata: {
          service: 'user-service',
          bounded_context: 'identity',
          tags: ['api', 'auth'],
          directory_tags: {
            'src/controllers': ['controller'],
          },
        },
      };
      const config = resolveProject(projectDir, raw);
      expect(config.metadata.service).toBe('user-service');
      expect(config.metadata.bounded_context).toBe('identity');
      expect(config.metadata.tags).toEqual(['api', 'auth']);
      expect(config.metadata.directory_tags).toEqual({ 'src/controllers': ['controller'] });
    });

    it('uses project name as service default', () => {
      const raw = { group: 'g', language: 'ruby', metadata: {} };
      const config = resolveProject(projectDir, raw);
      expect(config.metadata.service).toBe('project');
    });

    it('handles partial metadata (only service)', () => {
      const raw = { group: 'g', language: 'ruby', metadata: { service: 'my-svc' } };
      const config = resolveProject(projectDir, raw);
      expect(config.metadata.service).toBe('my-svc');
      expect(config.metadata.bounded_context).toBeNull();
      expect(config.metadata.tags).toEqual([]);
      expect(config.metadata.directory_tags).toEqual({});
    });

    it('parses metadata from YAML file', () => {
      const tmpDir = createTempDir();
      try {
        writeConfig(
          tmpDir,
          `
group: my-group
language: ruby
metadata:
  service: payment-service
  bounded_context: billing
  tags: [api, payments]
  directory_tags:
    src/controllers: [controller]
    src/models: [model]
`
        );
        const config = loadProject(tmpDir);
        expect(config.metadata.service).toBe('payment-service');
        expect(config.metadata.bounded_context).toBe('billing');
        expect(config.metadata.tags).toEqual(['api', 'payments']);
        expect(config.metadata.directory_tags).toEqual({
          'src/controllers': ['controller'],
          'src/models': ['model'],
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('detectLanguages', () => {
    it('detects typescript from tsconfig.json', () => {
      const tmpDir = createTempDir();
      try {
        fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
        expect(detectLanguages(tmpDir)).toEqual(['typescript']);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects python from requirements.txt', () => {
      const tmpDir = createTempDir();
      try {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '');
        expect(detectLanguages(tmpDir)).toEqual(['python']);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects multiple languages', () => {
      const tmpDir = createTempDir();
      try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), '');
        expect(detectLanguages(tmpDir)).toEqual(['typescript', 'go']);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns generic for empty directory', () => {
      const tmpDir = createTempDir();
      try {
        expect(detectLanguages(tmpDir)).toEqual(['generic']);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns generic for non-existent directory', () => {
      expect(detectLanguages('/nonexistent-path-xyz')).toEqual(['generic']);
    });
  });

  describe('autoProjectConfig', () => {
    it('resolves correct patterns and excludes for detected language', () => {
      const tmpDir = createTempDir();
      try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        const config = autoProjectConfig(tmpDir);

        expect(config.languages).toEqual(['typescript']);
        expect(config.patterns).toEqual(
          expect.arrayContaining(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'])
        );
        expect(config.exclude.length).toBeGreaterThan(0);
        expect(config.exclude).toEqual(
          expect.arrayContaining([expect.stringContaining('node_modules')])
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('uses provided group name', () => {
      const tmpDir = createTempDir();
      try {
        const config = autoProjectConfig(tmpDir, { group: 'my-group' });
        expect(config.group).toBe('my-group');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('defaults group to directory basename', () => {
      const tmpDir = createTempDir();
      try {
        const config = autoProjectConfig(tmpDir);
        expect(config.group).toBe(path.basename(tmpDir));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('includes generic excludes even for generic language', () => {
      const tmpDir = createTempDir();
      try {
        const config = autoProjectConfig(tmpDir);
        expect(config.languages).toEqual(['generic']);
        expect(config.exclude.length).toBeGreaterThan(0);
        expect(config.exclude).toEqual(
          expect.arrayContaining([expect.stringContaining('node_modules')])
        );
        expect(config.exclude).toEqual(expect.arrayContaining([expect.stringContaining('.git')]));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
