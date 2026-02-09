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
});
