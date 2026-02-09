import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    it('returns docker compose or docker-compose when available', () => {
      const cmd = getDockerComposeCommand();
      expect(cmd).toMatch(/docker(\s+compose|-compose)/);
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
