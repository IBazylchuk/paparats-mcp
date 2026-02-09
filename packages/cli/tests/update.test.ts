import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runUpdate } from '../src/commands/update.js';

describe('update', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    execMock = vi.fn();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('runUpdate', () => {
    it('updates CLI and Docker when neither skipped', async () => {
      await runUpdate(
        {},
        {
          execSync: execMock,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('npm install -g paparats-mcp@latest'),
        expect.any(Object)
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringMatching(/docker compose -f .* pull/),
        expect.any(Object)
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringMatching(/docker compose -f .* up -d/),
        expect.any(Object)
      );
    });

    it('skips CLI when --skip-cli', async () => {
      await runUpdate(
        { skipCli: true },
        {
          execSync: execMock,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
        }
      );

      const npmCalls = execMock.mock.calls.filter((c) => String(c[0]).includes('npm install'));
      expect(npmCalls).toHaveLength(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
    });

    it('skips Docker when --skip-docker', async () => {
      await runUpdate(
        { skipDocker: true },
        {
          execSync: execMock,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
        }
      );

      const dockerCalls = execMock.mock.calls.filter(
        (c) => String(c[0]).includes('docker compose') || String(c[0]).includes('docker-compose')
      );
      expect(dockerCalls).toHaveLength(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
    });

    it('skips Docker when compose file does not exist', async () => {
      await runUpdate(
        {},
        {
          execSync: execMock,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => false,
        }
      );

      const dockerCalls = execMock.mock.calls.filter(
        (c) => String(c[0]).includes('docker compose') || String(c[0]).includes('docker-compose')
      );
      expect(dockerCalls).toHaveLength(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Docker compose not found'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
    });
  });
});
