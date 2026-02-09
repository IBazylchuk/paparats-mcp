import { describe, it, expect } from 'vitest';
import {
  LSP_CONFIGS,
  buildCclspConfig,
  checkLspInstalled,
  getCclspConfigPath,
} from '../src/lsp-installers.js';

describe('lsp-installers', () => {
  describe('LSP_CONFIGS', () => {
    it('has configs for all supported LSP languages', () => {
      const expected = [
        'typescript',
        'javascript',
        'python',
        'go',
        'rust',
        'java',
        'ruby',
        'csharp',
      ];
      for (const lang of expected) {
        expect(LSP_CONFIGS[lang]).toBeDefined();
        expect(LSP_CONFIGS[lang]!.extensions.length).toBeGreaterThan(0);
        expect(LSP_CONFIGS[lang]!.command.length).toBeGreaterThan(0);
        expect(LSP_CONFIGS[lang]!.installCmd).toBeTruthy();
        expect(LSP_CONFIGS[lang]!.installCheck).toBeTruthy();
        expect(LSP_CONFIGS[lang]!.displayName).toBeTruthy();
      }
    });
  });

  describe('checkLspInstalled', () => {
    it('returns true when command exists', () => {
      const result = checkLspInstalled('typescript', {
        commandExists: () => true,
      });
      expect(result).toBe(true);
    });

    it('returns false when command does not exist', () => {
      const result = checkLspInstalled('typescript', {
        commandExists: () => false,
      });
      expect(result).toBe(false);
    });

    it('returns false for unknown language', () => {
      const result = checkLspInstalled('haskell', {
        commandExists: () => true,
      });
      expect(result).toBe(false);
    });

    it('checks the correct command for each language', () => {
      const checked: string[] = [];
      const mockCommandExists = (cmd: string) => {
        checked.push(cmd);
        return true;
      };

      checkLspInstalled('typescript', { commandExists: mockCommandExists });
      expect(checked).toContain('typescript-language-server');

      checked.length = 0;
      checkLspInstalled('python', { commandExists: mockCommandExists });
      expect(checked).toContain('pylsp');

      checked.length = 0;
      checkLspInstalled('go', { commandExists: mockCommandExists });
      expect(checked).toContain('gopls');

      checked.length = 0;
      checkLspInstalled('rust', { commandExists: mockCommandExists });
      expect(checked).toContain('rust-analyzer');
    });
  });

  describe('buildCclspConfig', () => {
    it('builds config for a single language (cclsp servers format, portable rootDir)', () => {
      const config = buildCclspConfig(['typescript']);
      expect(config.servers).toHaveLength(1);
      expect(config.servers[0]).toEqual({
        extensions: ['ts', 'tsx', 'js', 'jsx'],
        command: ['typescript-language-server', '--stdio'],
        rootDir: '.',
      });
    });

    it('builds config for multiple languages', () => {
      const config = buildCclspConfig(['typescript', 'python']);
      expect(config.servers).toHaveLength(2);
      expect(config.servers[0]!.extensions).toContain('ts');
      expect(config.servers[0]!.command).toEqual(['typescript-language-server', '--stdio']);
      const pyServer = config.servers.find((s) => s.extensions.includes('py'));
      expect(pyServer).toBeDefined();
      expect(pyServer!.extensions).toEqual(['py']);
      expect(pyServer!.command).toEqual(['pylsp']);
    });

    it('skips unknown languages', () => {
      const config = buildCclspConfig(['typescript', 'terraform']);
      expect(config.servers).toHaveLength(1);
      expect(config.servers[0]!.extensions).toContain('ts');
    });

    it('does not duplicate languages', () => {
      const config = buildCclspConfig(['typescript', 'typescript']);
      expect(config.servers).toHaveLength(1);
    });

    it('merges typescript and javascript into one server (same command)', () => {
      const config = buildCclspConfig(['typescript', 'javascript']);
      expect(config.servers).toHaveLength(1);
      expect(config.servers[0]!.extensions).toContain('ts');
      expect(config.servers[0]!.extensions).toContain('mjs');
    });

    it('builds config for all supported LSP languages', () => {
      const allLangs = [
        'typescript',
        'javascript',
        'python',
        'go',
        'rust',
        'java',
        'ruby',
        'csharp',
      ];
      const config = buildCclspConfig(allLangs);
      expect(config.servers.length).toBeGreaterThanOrEqual(7);

      expect(config.servers.find((s) => s.command[0] === 'gopls')?.command).toEqual(['gopls']);
      expect(config.servers.find((s) => s.command[0] === 'rust-analyzer')?.command).toEqual([
        'rust-analyzer',
      ]);
      const rubyServer = config.servers.find((s) => s.command[0] === 'solargraph');
      expect(rubyServer?.command).toEqual(['solargraph', 'stdio']);
      expect(rubyServer?.extensions).toContain('rbs');
      expect(config.servers.find((s) => s.command[0] === 'omnisharp')?.command).toEqual([
        'omnisharp',
      ]);
    });
  });

  describe('getCclspConfigPath', () => {
    it('returns path under .claude directory', () => {
      const result = getCclspConfigPath('/my/project');
      expect(result).toBe('/my/project/cclsp.json');
    });
  });
});
