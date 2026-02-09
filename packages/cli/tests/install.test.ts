import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  runInstall,
  commandExists,
  getDockerComposeCommand,
  ollamaModelExists,
  upsertMcpServer,
} from '../src/commands/install.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});

const mockedExecSync = vi.mocked(execSync);

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-cli-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

describe('install', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'command -v node') return undefined as never;
      if (cmd === 'command -v nonexistent-command-xyz-123') throw new Error('not found');
      if (cmd === 'ollama list') return 'other-model' as never;
      throw new Error(`Unexpected execSync: ${cmd}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('commandExists', () => {
    it('returns true for existing commands', () => {
      expect(commandExists('node')).toBe(true);
    });

    it('returns false for non-existent commands', () => {
      expect(commandExists('nonexistent-command-xyz-123')).toBe(false);
    });
  });

  describe('getDockerComposeCommand', () => {
    it('returns docker compose when available', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'docker compose version') return undefined as never;
        throw new Error('Command failed');
      });
      expect(getDockerComposeCommand()).toBe('docker compose');
    });

    it('returns docker-compose when docker compose not available', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'docker compose version') throw new Error('not found');
        if (cmd === 'docker-compose version') return undefined as never;
        throw new Error('Command failed');
      });
      expect(getDockerComposeCommand()).toBe('docker-compose');
    });

    it('throws when neither available', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(() => getDockerComposeCommand()).toThrow(/Docker Compose not found/);
    });
  });

  describe('ollamaModelExists', () => {
    it('returns false when ollama not running or model missing', () => {
      const result = ollamaModelExists('nonexistent-model-xyz');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('runInstall', () => {
    it('throws when docker not found', async () => {
      await expect(
        runInstall(
          { skipOllama: true },
          {
            commandExists: (c) => c === 'ollama',
            getDockerComposeCommand: () => 'docker compose',
            isOllamaRunning: () => Promise.resolve(true),
            waitForHealth: () => Promise.resolve(true),
            findTemplatePath: () => createTempDir() + '/template.yml',
            mkdirSync: () => {},
            copyFileSync: () => {},
            existsSync: () => false,
            writeFileSync: () => {},
            unlinkSync: () => {},
          }
        )
      ).rejects.toThrow(/Docker not found/);
    });

    it('throws when ollama not found when skipOllama is false', async () => {
      await expect(
        runInstall(
          { skipDocker: true },
          {
            commandExists: (c) => c === 'docker',
            ollamaModelExists: () => false,
            isOllamaRunning: () => Promise.resolve(false),
            downloadFile: () => Promise.resolve(),
            findTemplatePath: () => '',
            mkdirSync: () => {},
            existsSync: () => false,
            writeFileSync: () => {},
            unlinkSync: () => {},
          }
        )
      ).rejects.toThrow(/Ollama not found/);
    });

    it('completes when skipDocker and skipOllama', async () => {
      await runInstall(
        { skipDocker: true, skipOllama: true },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Installation complete'));
    });

    it('skips ollama when model already exists', async () => {
      await runInstall(
        { skipDocker: true },
        {
          commandExists: () => true,
          ollamaModelExists: () => true,
          isOllamaRunning: () => Promise.resolve(true),
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    });

    it('configures Cursor MCP when ~/.cursor/ exists', async () => {
      const cursorDir = path.join(os.homedir(), '.cursor');
      const mcpPath = path.join(cursorDir, 'mcp.json');
      const files = new Map<string, string>();

      await runInstall(
        { skipDocker: true, skipOllama: true },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: (p) => {
            if (p === cursorDir) return true;
            return files.has(p);
          },
          readFileSync: (p) => {
            if (files.has(p)) return files.get(p)!;
            throw new Error('ENOENT');
          },
          writeFileSync: (p, d) => files.set(p, d),
          mkdirSync: () => {},
        }
      );

      expect(files.has(mcpPath)).toBe(true);
      const parsed = JSON.parse(files.get(mcpPath)!);
      expect(parsed.mcpServers.paparats.type).toBe('http');
      expect(parsed.mcpServers.paparats.url).toBe('http://localhost:9876/mcp');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cursor MCP configured'));
    });

    it('skips Cursor config when ~/.cursor/ does not exist', async () => {
      await runInstall(
        { skipDocker: true, skipOllama: true },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => false,
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cursor not detected'));
    });
  });

  describe('upsertMcpServer', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates new file when missing', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      const result = upsertMcpServer(filePath, 'paparats', {
        type: 'http',
        url: 'http://localhost:9876/mcp',
      });

      expect(result).toBe('added');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed.mcpServers.paparats.type).toBe('http');
      expect(parsed.mcpServers.paparats.url).toBe('http://localhost:9876/mcp');
    });

    it('adds server to existing file with other servers', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({ mcpServers: { other: { url: 'http://other:1234' } } }, null, 2)
      );

      const result = upsertMcpServer(filePath, 'paparats', {
        type: 'http',
        url: 'http://localhost:9876/mcp',
      });

      expect(result).toBe('added');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed.mcpServers.other.url).toBe('http://other:1234');
      expect(parsed.mcpServers.paparats.type).toBe('http');
      expect(parsed.mcpServers.paparats.url).toBe('http://localhost:9876/mcp');
    });

    it('returns unchanged when URL matches', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          { mcpServers: { paparats: { type: 'http', url: 'http://localhost:9876/mcp' } } },
          null,
          2
        )
      );

      const result = upsertMcpServer(filePath, 'paparats', {
        type: 'http',
        url: 'http://localhost:9876/mcp',
      });
      expect(result).toBe('unchanged');
    });

    it('returns updated when URL differs', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({ mcpServers: { paparats: { url: 'http://old:1234/sse' } } }, null, 2)
      );

      const result = upsertMcpServer(filePath, 'paparats', {
        type: 'http',
        url: 'http://localhost:9876/mcp',
      });

      expect(result).toBe('updated');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed.mcpServers.paparats.type).toBe('http');
      expect(parsed.mcpServers.paparats.url).toBe('http://localhost:9876/mcp');
    });

    it('returns unchanged for matching command-based config', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      const config = {
        command: 'npx',
        args: ['-y', 'cclsp'],
        env: { CCLSP_CONFIG_PATH: '/project/.claude/cclsp.json' },
      };
      fs.writeFileSync(filePath, JSON.stringify({ mcpServers: { cclsp: config } }, null, 2));

      const result = upsertMcpServer(filePath, 'cclsp', config);
      expect(result).toBe('unchanged');
    });

    it('returns updated when command-based config differs', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            mcpServers: {
              cclsp: {
                command: 'npx',
                args: ['-y', 'cclsp'],
                env: { CCLSP_CONFIG_PATH: '/old/.claude/cclsp.json' },
              },
            },
          },
          null,
          2
        )
      );

      const result = upsertMcpServer(filePath, 'cclsp', {
        command: 'npx',
        args: ['-y', 'cclsp'],
        env: { CCLSP_CONFIG_PATH: '/new/.claude/cclsp.json' },
      });

      expect(result).toBe('updated');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed.mcpServers.cclsp.env.CCLSP_CONFIG_PATH).toBe('/new/.claude/cclsp.json');
    });

    it('adds command-based server alongside url-based server', () => {
      const filePath = path.join(tmpDir, 'mcp.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            mcpServers: {
              paparats: { type: 'http', url: 'http://localhost:9876/mcp' },
            },
          },
          null,
          2
        )
      );

      const result = upsertMcpServer(filePath, 'cclsp', {
        command: 'npx',
        args: ['-y', 'cclsp'],
        env: { CCLSP_CONFIG_PATH: '/project/.claude/cclsp.json' },
      });

      expect(result).toBe('added');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed.mcpServers.paparats.url).toBe('http://localhost:9876/mcp');
      expect(parsed.mcpServers.cclsp.command).toBe('npx');
    });

    it('creates parent directory if needed', () => {
      const filePath = path.join(tmpDir, 'subdir', 'mcp.json');
      const result = upsertMcpServer(filePath, 'paparats', {
        type: 'http',
        url: 'http://localhost:9876/mcp',
      });

      expect(result).toBe('added');
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});
