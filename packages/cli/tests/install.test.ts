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
import { generateDockerCompose, generateServerCompose } from '../src/docker-compose-generator.js';

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

  describe('runInstall (developer mode)', () => {
    it('throws when docker not found', async () => {
      await expect(
        runInstall(
          { mode: 'developer', skipOllama: true },
          {
            commandExists: (c) => c === 'ollama',
            getDockerComposeCommand: () => 'docker compose',
            isOllamaRunning: () => Promise.resolve(true),
            waitForHealth: () => Promise.resolve(true),
            generateDockerCompose,
            mkdirSync: () => {},
            existsSync: () => false,
            writeFileSync: () => {},
            unlinkSync: () => {},
            promptUseExternalQdrant: () => Promise.resolve(false),
          }
        )
      ).rejects.toThrow(/Docker not found/);
    });

    it('throws when ollama not found in local mode', async () => {
      await expect(
        runInstall(
          { mode: 'developer', skipDocker: true, ollamaMode: 'local' },
          {
            commandExists: (c) => c === 'docker',
            ollamaModelExists: () => false,
            isOllamaRunning: () => Promise.resolve(false),
            downloadFile: () => Promise.resolve(),
            generateDockerCompose,
            mkdirSync: () => {},
            existsSync: () => false,
            writeFileSync: () => {},
            unlinkSync: () => {},
          }
        )
      ).rejects.toThrow(/Ollama not found/);
    });

    it('does NOT check ollama in docker mode', async () => {
      await runInstall(
        { mode: 'developer', skipDocker: true, skipOllama: true, ollamaMode: 'docker' },
        {
          commandExists: (c) => c === 'docker',
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
          existsSync: () => false,
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Installation complete'));
    });

    it('completes when skipDocker and skipOllama', async () => {
      await runInstall(
        { mode: 'developer', skipDocker: true, skipOllama: true },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Installation complete'));
    });

    it('skips ollama when model already exists', async () => {
      await runInstall(
        { mode: 'developer', skipDocker: true },
        {
          commandExists: () => true,
          ollamaModelExists: () => true,
          isOllamaRunning: () => Promise.resolve(true),
          generateDockerCompose,
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    });

    it('writes generated docker-compose to ~/.paparats/', async () => {
      const files = new Map<string, string>();

      mockedExecSync.mockImplementation(() => undefined as never);

      await runInstall(
        { mode: 'developer', skipOllama: true },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
          mkdirSync: () => {},
          writeFileSync: (p, d) => files.set(p, d),
          existsSync: () => false,
          unlinkSync: () => {},
          promptUseExternalQdrant: () => Promise.resolve(false),
        }
      );

      const composePath = path.join(os.homedir(), '.paparats', 'docker-compose.yml');
      expect(files.has(composePath)).toBe(true);
      const content = files.get(composePath)!;
      expect(content).toContain('qdrant');
      expect(content).toContain('paparats');
    });

    it('configures Cursor MCP when ~/.cursor/ exists', async () => {
      const cursorDir = path.join(os.homedir(), '.cursor');
      const mcpPath = path.join(cursorDir, 'mcp.json');
      const files = new Map<string, string>();

      await runInstall(
        { mode: 'developer', skipDocker: true, skipOllama: true },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
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

    it('skips local ollama check and setup when ollamaUrl is set', async () => {
      const files = new Map<string, string>();

      mockedExecSync.mockImplementation(() => undefined as never);

      // commandExists returns false for 'ollama' — should NOT throw because ollamaUrl is set
      await runInstall(
        { mode: 'developer', ollamaMode: 'local', ollamaUrl: 'http://fargate-ollama:11434' },
        {
          commandExists: (c) => c === 'docker', // ollama not found locally
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
          mkdirSync: () => {},
          writeFileSync: (p, d) => files.set(p, d),
          existsSync: () => false,
          unlinkSync: () => {},
          promptUseExternalQdrant: () => Promise.resolve(false),
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Installation complete'));

      // Compose should use the external URL
      const composePath = path.join(os.homedir(), '.paparats', 'docker-compose.yml');
      const content = files.get(composePath)!;
      expect(content).toContain('http://fargate-ollama:11434');
      expect(content).not.toContain('paparats-ollama');
    });

    it('skips Cursor config when ~/.cursor/ does not exist', async () => {
      await runInstall(
        { mode: 'developer', skipDocker: true, skipOllama: true },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
          existsSync: () => false,
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cursor not detected'));
    });

    it('passes qdrantUrl to docker-compose generator', async () => {
      const files = new Map<string, string>();

      mockedExecSync.mockImplementation(() => undefined as never);

      await runInstall(
        { mode: 'developer', skipOllama: true, qdrantUrl: 'http://my-qdrant:6333' },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
          mkdirSync: () => {},
          writeFileSync: (p, d) => files.set(p, d),
          existsSync: () => false,
          unlinkSync: () => {},
        }
      );

      const composePath = path.join(os.homedir(), '.paparats', 'docker-compose.yml');
      const content = files.get(composePath)!;
      expect(content).not.toContain('qdrant/qdrant');
      expect(content).toContain('http://my-qdrant:6333');
    });

    it('prompts for external qdrant interactively', async () => {
      const files = new Map<string, string>();

      mockedExecSync.mockImplementation(() => undefined as never);

      await runInstall(
        { mode: 'developer', skipOllama: true },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
          mkdirSync: () => {},
          writeFileSync: (p, d) => files.set(p, d),
          existsSync: () => false,
          unlinkSync: () => {},
          promptUseExternalQdrant: () => Promise.resolve(true),
          promptQdrantUrl: () => Promise.resolve('http://cloud-qdrant:6333'),
        }
      );

      const composePath = path.join(os.homedir(), '.paparats', 'docker-compose.yml');
      const content = files.get(composePath)!;
      expect(content).not.toContain('qdrant/qdrant');
      expect(content).toContain('http://cloud-qdrant:6333');
    });

    it('skips qdrant prompt when qdrantUrl already provided via flag', async () => {
      const promptSpy = vi.fn().mockResolvedValue(false);
      const files = new Map<string, string>();

      mockedExecSync.mockImplementation(() => undefined as never);

      await runInstall(
        { mode: 'developer', skipOllama: true, qdrantUrl: 'http://flag-qdrant:6333' },
        {
          commandExists: () => true,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          generateDockerCompose,
          mkdirSync: () => {},
          writeFileSync: (p, d) => files.set(p, d),
          existsSync: () => false,
          unlinkSync: () => {},
          promptUseExternalQdrant: promptSpy,
        }
      );

      expect(promptSpy).not.toHaveBeenCalled();
      const composePath = path.join(os.homedir(), '.paparats', 'docker-compose.yml');
      expect(files.get(composePath)!).toContain('http://flag-qdrant:6333');
    });
  });

  describe('runInstall (server mode)', () => {
    // Shared deps for server mode tests (docker ollama mode — no local ollama needed)
    const serverDeps = {
      commandExists: () => true,
      getDockerComposeCommand: () => 'docker compose',
      ollamaModelExists: () => false,
      isOllamaRunning: () => Promise.resolve(false),
      downloadFile: () => Promise.resolve(),
      waitForHealth: () => Promise.resolve(true),
      generateServerCompose,
      mkdirSync: () => {},
      writeFileSync: () => {},
      existsSync: () => false,
      unlinkSync: () => {},
      promptUseExternalQdrant: () => Promise.resolve(false),
    };

    it('throws when docker not found', async () => {
      await expect(
        runInstall(
          { mode: 'server' },
          {
            ...serverDeps,
            commandExists: () => false,
          }
        )
      ).rejects.toThrow(/Docker not found/);
    });

    it('generates server compose with all services', async () => {
      const files = new Map<string, string>();

      mockedExecSync.mockImplementation(() => undefined as never);

      await runInstall(
        { mode: 'server', repos: 'org/repo1,org/repo2' },
        {
          ...serverDeps,
          writeFileSync: (p, d) => files.set(p, d),
        }
      );

      const composePath = path.join(os.homedir(), '.paparats', 'docker-compose.yml');
      expect(files.has(composePath)).toBe(true);
      const content = files.get(composePath)!;
      expect(content).toContain('paparats-indexer');
      expect(content).toContain('ollama');

      // Should create .env
      const envPath = path.join(os.homedir(), '.paparats', '.env');
      expect(files.has(envPath)).toBe(true);
      expect(files.get(envPath)).toContain('org/repo1,org/repo2');
    });

    it('does not configure IDE MCP', async () => {
      mockedExecSync.mockImplementation(() => undefined as never);

      await runInstall({ mode: 'server' }, serverDeps);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Server installation complete'));
      // Should not mention Cursor
      const cursorLogs = logSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('Cursor')
      );
      expect(cursorLogs).toHaveLength(0);
    });

    it('checks ollama and sets up model in local mode', async () => {
      const ollamaModelMock = vi.fn().mockReturnValue(false);
      const ollamaRunningMock = vi.fn().mockResolvedValue(true);
      const downloadMock = vi.fn().mockResolvedValue(undefined);
      const files = new Map<string, string>();

      mockedExecSync.mockImplementation(() => undefined as never);

      await runInstall(
        { mode: 'server', ollamaMode: 'local' },
        {
          ...serverDeps,
          ollamaModelExists: ollamaModelMock,
          isOllamaRunning: ollamaRunningMock,
          downloadFile: downloadMock,
          writeFileSync: (p, d) => files.set(p, d),
          existsSync: () => false,
          promptUseExternalQdrant: () => Promise.resolve(false),
        }
      );

      // Should have checked model and downloaded GGUF
      expect(ollamaModelMock).toHaveBeenCalledWith('jina-code-embeddings');
      expect(ollamaRunningMock).toHaveBeenCalled();
      expect(downloadMock).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Server installation complete'));
    });

    it('throws when ollama not found in local mode', async () => {
      await expect(
        runInstall(
          { mode: 'server', ollamaMode: 'local' },
          {
            ...serverDeps,
            commandExists: (c) => c === 'docker', // ollama missing
          }
        )
      ).rejects.toThrow(/Ollama not found/);
    });

    it('skips ollama check in local mode when ollamaUrl is set', async () => {
      const files = new Map<string, string>();
      const ollamaModelMock = vi.fn();

      mockedExecSync.mockImplementation(() => undefined as never);

      await runInstall(
        { mode: 'server', ollamaMode: 'local', ollamaUrl: 'http://fargate:11434' },
        {
          ...serverDeps,
          commandExists: (c) => c === 'docker', // ollama missing — should be fine
          ollamaModelExists: ollamaModelMock,
          writeFileSync: (p, d) => files.set(p, d),
        }
      );

      expect(ollamaModelMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Server installation complete'));

      // Compose should use external URL and no ollama service
      const composePath = path.join(os.homedir(), '.paparats', 'docker-compose.yml');
      const content = files.get(composePath)!;
      expect(content).toContain('http://fargate:11434');
      expect(content).not.toContain('paparats-ollama');
    });
  });

  describe('runInstall (support mode)', () => {
    it('throws when server not reachable', async () => {
      await expect(
        runInstall(
          { mode: 'support', server: 'http://unreachable:9876' },
          {
            waitForHealth: () => Promise.resolve(false),
            existsSync: () => false,
            readFileSync: () => '',
            writeFileSync: () => {},
            mkdirSync: () => {},
          }
        )
      ).rejects.toThrow(/Server not reachable/);
    });

    it('configures support MCP endpoint', async () => {
      const cursorDir = path.join(os.homedir(), '.cursor');
      const files = new Map<string, string>();

      await runInstall(
        { mode: 'support', server: 'http://prod:9876' },
        {
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

      const mcpPath = path.join(cursorDir, 'mcp.json');
      expect(files.has(mcpPath)).toBe(true);
      const parsed = JSON.parse(files.get(mcpPath)!);
      expect(parsed.mcpServers['paparats-support'].url).toBe('http://prod:9876/support/mcp');
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
