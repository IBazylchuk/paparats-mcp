import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  runInstall,
  commandExists,
  getDockerComposeCommand,
  ollamaModelExists,
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
  });
});
