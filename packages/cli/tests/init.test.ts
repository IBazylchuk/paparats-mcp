import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runInit, validateGroupName, appendToGitignore } from '../src/commands/init.js';
import { CONFIG_FILE, readConfig } from '../src/config.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-cli-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

describe('init', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = createTempDir();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('validateGroupName', () => {
    it('returns true for valid group names', () => {
      expect(validateGroupName('my-group')).toBe(true);
      expect(validateGroupName('my_group')).toBe(true);
      expect(validateGroupName('MyGroup123')).toBe(true);
      expect(validateGroupName('a')).toBe(true);
    });

    it('returns error for empty', () => {
      expect(validateGroupName('')).toBe('Group name is required');
      expect(validateGroupName('   ')).toBe('Group name is required');
    });

    it('returns error for invalid characters', () => {
      expect(validateGroupName('my group')).toBe(
        'Group name can only contain letters, numbers, dashes, and underscores'
      );
      expect(validateGroupName('my.group')).toBe(
        'Group name can only contain letters, numbers, dashes, and underscores'
      );
    });
  });

  describe('appendToGitignore', () => {
    it('appends with leading newline when content exists without trailing newline', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules');
      appendToGitignore(gitignorePath);
      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('\n.paparats.yml\n');
    });

    it('appends without leading newline when content ends with newline', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules\n');
      appendToGitignore(gitignorePath);
      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('.paparats.yml\n');
    });

    it('appends to empty file', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '');
      appendToGitignore(gitignorePath);
      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toBe('.paparats.yml\n');
    });
  });

  describe('runInit', () => {
    it('creates config in non-interactive mode with defaults', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);
      const basename = path.basename(tmpDir);

      await runInit(tmpDir, { nonInteractive: true });

      expect(fs.existsSync(configPath)).toBe(true);
      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain(`group: ${basename}`);
      expect(content).toContain('language:');
      expect(content).toContain('node_modules');
      expect(content).toContain('dist');
    });

    it('creates config with --group and --language in non-interactive mode', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);

      await runInit(tmpDir, {
        nonInteractive: true,
        group: 'my-group',
        language: 'rust',
      });

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('group: my-group');
      expect(content).toContain('language: rust');
    });

    it('throws when config exists and no --force', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);
      fs.writeFileSync(configPath, 'group: old\nlanguage: ruby');

      await expect(runInit(tmpDir, {})).rejects.toThrow(
        'already exists. Use --force to overwrite.'
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('group: old');
    });

    it('overwrites config with --force', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);
      fs.writeFileSync(configPath, 'group: old\nlanguage: ruby');

      await runInit(tmpDir, { force: true, nonInteractive: true, group: 'new-group' });

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('group: new-group');
      expect(content).not.toContain('group: old');
    });

    it('uses deps to skip prompts', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);

      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('test-group'),
          promptLanguage: () => Promise.resolve('python'),
          promptAddExclude: () => Promise.resolve(true),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(false),
        }
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('group: test-group');
      expect(content).toContain('language: python');
      expect(content).toContain('node_modules');
    });

    it('throws when --group has invalid format', async () => {
      await expect(
        runInit(tmpDir, { nonInteractive: true, group: 'invalid name' })
      ).rejects.toThrow('can only contain letters');
    });

    it('throws when --language is unsupported', async () => {
      await expect(runInit(tmpDir, { nonInteractive: true, language: 'haskell' })).rejects.toThrow(
        'Unsupported language'
      );
    });

    it('supports multi-language via deps', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);

      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('multi'),
          promptLanguage: () => Promise.resolve(['typescript', 'python']),
          promptAddExclude: () => Promise.resolve(true),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(false),
        }
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('language:');
      expect(content).toMatch(/typescript|python/);
    });

    it('adds embeddings config when configured via deps', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);

      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('g'),
          promptLanguage: () => Promise.resolve('typescript'),
          promptAddExclude: () => Promise.resolve(false),
          promptConfigureEmbeddings: () => Promise.resolve(true),
          promptEmbeddingsProvider: () => Promise.resolve('ollama'),
          promptEmbeddingsModel: () => Promise.resolve('jina-code-embeddings'),
          promptGitignore: () => Promise.resolve(false),
        }
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('embeddings:');
      expect(content).toContain('provider: ollama');
      expect(content).toContain('model: jina-code-embeddings');
    });

    it('adds paths when promptPaths returns selection', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      const configPath = path.join(tmpDir, CONFIG_FILE);

      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('with-paths'),
          promptLanguage: () => Promise.resolve('typescript'),
          promptAddPaths: () => Promise.resolve(true),
          promptPaths: () => Promise.resolve(['src/', 'lib/']),
          promptAddExclude: () => Promise.resolve(true),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(false),
        }
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('paths:');
      expect(content).toContain('src/');
      expect(content).toContain('lib/');
    });

    it('omits exclude when promptAddExclude returns false', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);

      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('no-exclude'),
          promptLanguage: () => Promise.resolve('go'),
          promptAddExclude: () => Promise.resolve(false),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(false),
        }
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).not.toContain('exclude:');
      expect(content).not.toContain('node_modules');
    });

    it('adds to .gitignore when promptGitignore returns true', async () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules\n');

      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('g'),
          promptLanguage: () => Promise.resolve('ruby'),
          promptAddExclude: () => Promise.resolve(false),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(true),
        }
      );

      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      expect(gitignoreContent).toContain(CONFIG_FILE);
    });

    it('produces valid config readable by readConfig', async () => {
      await runInit(tmpDir, {
        nonInteractive: true,
        group: 'valid-group',
        language: 'typescript',
      });

      const { config } = readConfig(tmpDir);
      expect(config.group).toBe('valid-group');
      expect(config.language).toBe('typescript');
      expect(config.indexing?.exclude).toContain('node_modules');
      expect(config.indexing?.exclude).toContain('dist');
    });

    it('shows overwrite warning when using --force', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);
      fs.writeFileSync(configPath, 'group: old\nlanguage: ruby');

      await runInit(tmpDir, {
        force: true,
        nonInteractive: true,
        group: 'new',
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('exists and will be overwritten')
      );
    });

    it('logs example config in interactive mode', async () => {
      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('demo'),
          promptLanguage: () => Promise.resolve('python'),
          promptAddExclude: () => Promise.resolve(false),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(false),
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Example config:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/group:.*demo/));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/language:.*python/));
    });

    it('does not prompt for gitignore when already in .gitignore', async () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, `node_modules\n${CONFIG_FILE}\n`);

      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('g'),
          promptLanguage: () => Promise.resolve('rust'),
          promptAddExclude: () => Promise.resolve(false),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(true),
        }
      );

      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      const count = (gitignoreContent.match(new RegExp(CONFIG_FILE, 'g')) ?? []).length;
      expect(count).toBe(1);
    });

    it('uses OpenAI model default when embeddings provider is openai', async () => {
      const configPath = path.join(tmpDir, CONFIG_FILE);

      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('g'),
          promptLanguage: () => Promise.resolve('typescript'),
          promptAddExclude: () => Promise.resolve(false),
          promptConfigureEmbeddings: () => Promise.resolve(true),
          promptEmbeddingsProvider: () => Promise.resolve('openai'),
          promptEmbeddingsModel: () => Promise.resolve('text-embedding-3-small'),
          promptGitignore: () => Promise.resolve(false),
        }
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('provider: openai');
      expect(content).toContain('model: text-embedding-3-small');
    });
  });
});
