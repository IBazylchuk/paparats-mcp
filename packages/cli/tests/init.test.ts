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

      await runInit(tmpDir, { nonInteractive: true, skipCclsp: true });

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
        skipCclsp: true,
      });

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('group: my-group');
      expect(content).toContain('language: rust');
      expect(content).toContain('target');
    });

    it('uses language-specific exclude patterns (e.g. Ruby gets vendor, tmp, spec)', async () => {
      await runInit(tmpDir, {
        nonInteractive: true,
        group: 'jobs',
        language: 'ruby',
        skipCclsp: true,
      });

      const { config } = readConfig(tmpDir);
      expect(config.indexing?.exclude).toContain('vendor');
      expect(config.indexing?.exclude).toContain('tmp');
      expect(config.indexing?.exclude).toContain('spec');
      expect(config.indexing?.exclude).not.toContain('.next');
      expect(config.indexing?.exclude).not.toContain('.turbo');
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

      await runInit(tmpDir, {
        force: true,
        nonInteractive: true,
        group: 'new-group',
        skipCclsp: true,
      });

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
          promptSetupCclsp: () => Promise.resolve(false),
        }
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('group: test-group');
      expect(content).toContain('language: python');
      expect(content).toContain('venv');
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
          promptSetupCclsp: () => Promise.resolve(false),
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
          promptSetupCclsp: () => Promise.resolve(false),
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
          promptSetupCclsp: () => Promise.resolve(false),
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
          promptSetupCclsp: () => Promise.resolve(false),
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
          promptSetupCclsp: () => Promise.resolve(false),
        }
      );

      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      expect(gitignoreContent).toContain(CONFIG_FILE);
    });

    it('creates cclsp.json in non-interactive mode', async () => {
      await runInit(
        tmpDir,
        {
          nonInteractive: true,
          group: 'test-cclsp',
          language: 'typescript',
        },
        {
          lspDeps: { commandExists: () => true },
        }
      );

      const cclspPath = path.join(tmpDir, 'cclsp.json');
      expect(fs.existsSync(cclspPath)).toBe(true);
      const cclsp = JSON.parse(fs.readFileSync(cclspPath, 'utf8'));
      expect(cclsp.servers).toBeDefined();
      expect(Array.isArray(cclsp.servers)).toBe(true);
      const tsServer = cclsp.servers.find((s: { extensions: string[] }) =>
        s.extensions.includes('ts')
      );
      expect(tsServer).toBeDefined();
      expect(tsServer.extensions).toContain('ts');
      expect(tsServer.rootDir).toBe('.');
    });

    it('adds cclsp to .mcp.json in non-interactive mode', async () => {
      await runInit(
        tmpDir,
        {
          nonInteractive: true,
          group: 'test-cclsp',
          language: 'typescript',
        },
        {
          lspDeps: { commandExists: () => true },
        }
      );

      const mcpJsonPath = path.join(tmpDir, '.mcp.json');
      const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(parsed.mcpServers.cclsp).toBeDefined();
      expect(parsed.mcpServers.cclsp.command).toBe('cclsp');
      expect(parsed.mcpServers.cclsp.env.CCLSP_CONFIG_PATH).toBe('./cclsp.json');
    });

    it('skips cclsp with --skip-cclsp', async () => {
      await runInit(tmpDir, {
        nonInteractive: true,
        group: 'test-skip',
        language: 'typescript',
        skipCclsp: true,
      });

      const cclspPath = path.join(tmpDir, 'cclsp.json');
      expect(fs.existsSync(cclspPath)).toBe(false);

      const mcpJsonPath = path.join(tmpDir, '.mcp.json');
      const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(parsed.mcpServers.cclsp).toBeUndefined();
    });

    it('skips cclsp when promptSetupCclsp returns false', async () => {
      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('g'),
          promptLanguage: () => Promise.resolve('typescript'),
          promptAddExclude: () => Promise.resolve(false),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(false),
          promptSetupCclsp: () => Promise.resolve(false),
          lspDeps: { commandExists: () => true },
        }
      );

      const cclspPath = path.join(tmpDir, 'cclsp.json');
      expect(fs.existsSync(cclspPath)).toBe(false);
    });

    it('creates cclsp.json for multi-language projects', async () => {
      await runInit(
        tmpDir,
        {},
        {
          promptGroup: () => Promise.resolve('multi-cclsp'),
          promptLanguage: () => Promise.resolve(['typescript', 'python']),
          promptAddExclude: () => Promise.resolve(false),
          promptConfigureEmbeddings: () => Promise.resolve(false),
          promptGitignore: () => Promise.resolve(false),
          promptSetupCclsp: () => Promise.resolve(true),
          lspDeps: { commandExists: () => true },
        }
      );

      const cclspPath = path.join(tmpDir, 'cclsp.json');
      expect(fs.existsSync(cclspPath)).toBe(true);
      const cclsp = JSON.parse(fs.readFileSync(cclspPath, 'utf8'));
      expect(cclsp.servers).toBeDefined();
      const hasTs = cclsp.servers.some((s: { extensions: string[] }) =>
        s.extensions.includes('ts')
      );
      const hasPy = cclsp.servers.some((s: { extensions: string[] }) =>
        s.extensions.includes('py')
      );
      expect(hasTs).toBe(true);
      expect(hasPy).toBe(true);
    });

    it('skips cclsp for languages without LSP config (e.g. terraform)', async () => {
      await runInit(tmpDir, {
        nonInteractive: true,
        group: 'test-terraform',
        language: 'terraform',
      });

      const cclspPath = path.join(tmpDir, 'cclsp.json');
      expect(fs.existsSync(cclspPath)).toBe(false);
    });

    it('warns on LSP install failure but continues', async () => {
      await runInit(
        tmpDir,
        {
          nonInteractive: true,
          group: 'test-fail',
          language: 'typescript',
        },
        {
          lspDeps: {
            commandExists: () => false,
            execInstall: () => {
              throw new Error('install failed');
            },
          },
        }
      );

      // cclsp.json should still be created even if LSP install fails
      const cclspPath = path.join(tmpDir, 'cclsp.json');
      expect(fs.existsSync(cclspPath)).toBe(true);
    });

    it('produces valid config readable by readConfig', async () => {
      await runInit(tmpDir, {
        nonInteractive: true,
        group: 'valid-group',
        language: 'typescript',
        skipCclsp: true,
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
        skipCclsp: true,
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
          promptSetupCclsp: () => Promise.resolve(false),
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
          promptSetupCclsp: () => Promise.resolve(false),
        }
      );

      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      const count = (gitignoreContent.match(new RegExp(CONFIG_FILE, 'g')) ?? []).length;
      expect(count).toBe(1);
    });

    it('creates .mcp.json alongside .paparats.yml', async () => {
      const mcpJsonPath = path.join(tmpDir, '.mcp.json');

      await runInit(tmpDir, { nonInteractive: true, group: 'test-mcp', skipCclsp: true });

      expect(fs.existsSync(mcpJsonPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(parsed.mcpServers.paparats).toEqual({
        type: 'http',
        url: 'http://localhost:9876/mcp',
      });
    });

    it('preserves existing .mcp.json with paparats added', async () => {
      const mcpJsonPath = path.join(tmpDir, '.mcp.json');
      fs.writeFileSync(
        mcpJsonPath,
        JSON.stringify({ mcpServers: { other: { url: 'http://other:1234' } } }, null, 2)
      );

      await runInit(tmpDir, { nonInteractive: true, group: 'test-mcp', skipCclsp: true });

      const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(parsed.mcpServers.other.url).toBe('http://other:1234');
      expect(parsed.mcpServers.paparats).toEqual({
        type: 'http',
        url: 'http://localhost:9876/mcp',
      });
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
          promptSetupCclsp: () => Promise.resolve(false),
        }
      );

      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('provider: openai');
      expect(content).toContain('model: text-embedding-3-small');
    });
  });
});
