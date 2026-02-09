import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  CONFIG_FILE,
  findConfigDir,
  readConfig,
  writeConfig,
  detectLanguage,
  detectLanguages,
  collectProjectFiles,
  normalizeExcludePatterns,
  SUPPORTED_LANGUAGES,
  type PaparatsConfig,
} from '../src/config.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-cli-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

describe('Config', () => {
  describe('findConfigDir', () => {
    it('returns dir when config exists', () => {
      const dir = createTempDir();
      fs.writeFileSync(path.join(dir, CONFIG_FILE), 'group: g\nlanguage: ruby');
      expect(findConfigDir(dir)).toBe(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('searches upward and finds config in parent', () => {
      const parent = createTempDir();
      const child = path.join(parent, 'sub', 'nested');
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(parent, CONFIG_FILE), 'group: g\nlanguage: ruby');
      expect(findConfigDir(child)).toBe(parent);
      fs.rmSync(parent, { recursive: true, force: true });
    });

    it('returns null when not found', () => {
      const dir = createTempDir();
      expect(findConfigDir(dir)).toBeNull();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('readConfig', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads minimal valid config', () => {
      fs.writeFileSync(path.join(tmpDir, CONFIG_FILE), 'group: my-group\nlanguage: ruby');
      const { config, projectDir } = readConfig(tmpDir);
      expect(config.group).toBe('my-group');
      expect(config.language).toBe('ruby');
      expect(projectDir).toBe(path.resolve(tmpDir));
    });

    it('throws when config file not found in given dir', () => {
      expect(() => readConfig(tmpDir)).toThrow('Config file not found');
    });

    it('throws when no config in cwd or parents', () => {
      const emptyDir = createTempDir();
      const cwd = process.cwd();
      process.chdir(emptyDir);
      try {
        expect(() => readConfig()).toThrow('No .paparats.yml found');
      } finally {
        process.chdir(cwd);
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('throws when group is missing', () => {
      fs.writeFileSync(path.join(tmpDir, CONFIG_FILE), 'language: ruby');
      expect(() => readConfig(tmpDir)).toThrow("Invalid 'group'");
    });

    it('throws when language is missing', () => {
      fs.writeFileSync(path.join(tmpDir, CONFIG_FILE), 'group: g');
      expect(() => readConfig(tmpDir)).toThrow("Missing required field 'language'");
    });

    it('throws on invalid YAML', () => {
      fs.writeFileSync(path.join(tmpDir, CONFIG_FILE), 'group: g\n  language: [');
      expect(() => readConfig(tmpDir)).toThrow('Invalid YAML');
    });

    it('throws on unsupported language', () => {
      fs.writeFileSync(path.join(tmpDir, CONFIG_FILE), 'group: g\nlanguage: elixir');
      expect(() => readConfig(tmpDir)).toThrow('Unsupported language');
    });

    it('validates optional chunkSize range', () => {
      fs.writeFileSync(
        path.join(tmpDir, CONFIG_FILE),
        'group: g\nlanguage: ruby\nindexing:\n  chunkSize: 50'
      );
      expect(() => readConfig(tmpDir)).toThrow('Invalid chunkSize');
    });

    it('rejects absolute paths in indexing.paths', () => {
      const absolutePath = path.sep === '\\' ? 'C:\\tmp' : '/tmp';
      fs.writeFileSync(
        path.join(tmpDir, CONFIG_FILE),
        `group: g\nlanguage: ruby\nindexing:\n  paths: [${JSON.stringify(absolutePath)}]`
      );
      expect(() => readConfig(tmpDir)).toThrow('Absolute paths not allowed in indexing.paths');
    });

    it('rejects path traversal in indexing.paths', () => {
      fs.writeFileSync(
        path.join(tmpDir, CONFIG_FILE),
        'group: g\nlanguage: ruby\nindexing:\n  paths: [../../etc]'
      );
      expect(() => readConfig(tmpDir)).toThrow('Path must be inside project directory');
    });

    it('accepts valid optional fields', () => {
      fs.writeFileSync(
        path.join(tmpDir, CONFIG_FILE),
        `group: g
language: ruby
indexing:
  chunkSize: 512
  overlap: 64
watcher:
  enabled: true
  debounce: 300
embeddings:
  provider: ollama
  dimensions: 1536`
      );
      const { config } = readConfig(tmpDir);
      expect(config.indexing?.chunkSize).toBe(512);
      expect(config.watcher?.enabled).toBe(true);
      expect(config.embeddings?.provider).toBe('ollama');
    });
  });

  describe('writeConfig', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes valid config', () => {
      const config: PaparatsConfig = {
        group: 'my-group',
        language: 'typescript',
      };
      writeConfig(tmpDir, config);
      const content = fs.readFileSync(path.join(tmpDir, CONFIG_FILE), 'utf8');
      expect(content).toContain('group: my-group');
      expect(content).toContain('language: typescript');
    });

    it('throws when directory does not exist', () => {
      const missing = path.join(tmpDir, 'nonexistent');
      expect(() => writeConfig(missing, { group: 'g', language: 'ruby' })).toThrow(
        'Directory does not exist'
      );
    });
  });

  describe('detectLanguage / detectLanguages', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns null for empty directory', () => {
      expect(detectLanguage(tmpDir)).toBeNull();
      expect(detectLanguages(tmpDir)).toEqual([]);
    });

    it('detects typescript from tsconfig.json (priority over package.json)', () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      expect(detectLanguage(tmpDir)).toBe('typescript');
      expect(detectLanguages(tmpDir)).toEqual(['typescript']);
    });

    it('detects typescript from package.json when no tsconfig', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      expect(detectLanguage(tmpDir)).toBe('typescript');
    });

    it('detects rust from Cargo.toml', () => {
      fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]');
      expect(detectLanguage(tmpDir)).toBe('rust');
    });

    it('detects python from pyproject.toml', () => {
      fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]');
      expect(detectLanguage(tmpDir)).toBe('python');
    });

    it('detects csharp from .csproj', () => {
      fs.writeFileSync(path.join(tmpDir, 'MyApp.csproj'), '<Project>');
      expect(detectLanguage(tmpDir)).toBe('csharp');
    });

    it('detects csharp from .sln', () => {
      fs.writeFileSync(path.join(tmpDir, 'Solution.sln'), '');
      expect(detectLanguage(tmpDir)).toBe('csharp');
    });

    it('detectLanguages returns multiple when project has both', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '');
      const langs = detectLanguages(tmpDir);
      expect(langs).toContain('typescript');
      expect(langs).toContain('python');
      expect(langs.length).toBe(2);
    });

    it('uses deterministic priority (tsconfig before package.json)', () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '');
      expect(detectLanguage(tmpDir)).toBe('typescript');
    });

    it('returns empty for non-existent directory', () => {
      expect(detectLanguages(path.join(tmpDir, 'nonexistent'))).toEqual([]);
      expect(detectLanguage(path.join(tmpDir, 'nonexistent'))).toBeNull();
    });
  });

  describe('SUPPORTED_LANGUAGES', () => {
    it('includes all expected languages', () => {
      expect(SUPPORTED_LANGUAGES).toContain('typescript');
      expect(SUPPORTED_LANGUAGES).toContain('csharp');
      expect(SUPPORTED_LANGUAGES).toContain('rust');
    });
  });

  describe('normalizeExcludePatterns', () => {
    it('wraps bare dir names with **/ and /**', () => {
      expect(normalizeExcludePatterns(['node_modules', 'dist'])).toEqual([
        '**/node_modules/**',
        '**/dist/**',
      ]);
    });

    it('leaves patterns with / or ** unchanged', () => {
      expect(normalizeExcludePatterns(['**/node_modules/**', 'foo/bar'])).toEqual([
        '**/node_modules/**',
        'foo/bar',
      ]);
    });
  });

  describe('collectProjectFiles', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('excludes node_modules when using bare exclude pattern', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');

      const config: PaparatsConfig = {
        group: 'g',
        language: 'typescript',
        indexing: { exclude: ['node_modules'] },
      };
      const files = await collectProjectFiles(tmpDir, config);
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
      expect(files.some((f) => f.includes('src/index.ts'))).toBe(true);
    });

    it('excludes dist, build, .next, coverage, .turbo when using bare patterns', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'build'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.next'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
      fs.writeFileSync(path.join(tmpDir, 'dist', 'index.js'), '');
      fs.writeFileSync(path.join(tmpDir, 'build', 'out.js'), '');
      fs.writeFileSync(path.join(tmpDir, '.next', 'page.js'), '');

      const config: PaparatsConfig = {
        group: 'g',
        language: 'typescript',
        indexing: { exclude: ['dist', 'build', '.next'] },
      };
      const files = await collectProjectFiles(tmpDir, config);
      expect(files.some((f) => f.includes('dist'))).toBe(false);
      expect(files.some((f) => f.includes('build'))).toBe(false);
      expect(files.some((f) => f.includes('.next'))).toBe(false);
      expect(files.some((f) => f.includes('src/index.ts'))).toBe(true);
    });

    it('excludes files matching .gitignore when respectGitignore is true', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'secrets'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
      fs.writeFileSync(path.join(tmpDir, 'secrets', 'key.ts'), 'const secret = "key";');
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'secrets/\n*.log\n');

      const config: PaparatsConfig = {
        group: 'g',
        language: 'typescript',
        indexing: { respectGitignore: true },
      };
      const files = await collectProjectFiles(tmpDir, config);
      expect(files.some((f) => f.includes('secrets'))).toBe(false);
      expect(files.some((f) => f.includes('src/index.ts'))).toBe(true);
    });

    it('includes gitignored files when respectGitignore is false', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'secrets'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
      fs.writeFileSync(path.join(tmpDir, 'secrets', 'key.ts'), 'const secret = "key";');
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'secrets/\n');

      const config: PaparatsConfig = {
        group: 'g',
        language: 'typescript',
        indexing: { respectGitignore: false },
      };
      const files = await collectProjectFiles(tmpDir, config);
      expect(files.some((f) => f.includes('secrets'))).toBe(true);
      expect(files.some((f) => f.includes('src/index.ts'))).toBe(true);
    });

    it('uses default exclude when indexing.exclude is empty', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), '');

      const config: PaparatsConfig = {
        group: 'g',
        language: 'typescript',
      };
      const files = await collectProjectFiles(tmpDir, config);
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
      expect(files.some((f) => f.includes('src/index.ts'))).toBe(true);
    });
  });
});
