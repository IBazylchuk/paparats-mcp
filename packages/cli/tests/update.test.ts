import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runUpdate } from '../src/commands/update.js';
import type { RegenerateOptions, RegenerateResult } from '../src/projects-yml.js';

const COMPOSE_WITH_QDRANT = `services:
  qdrant:
    image: qdrant/qdrant:latest
  paparats:
    image: ibaz/paparats-server:latest
`;

const COMPOSE_WITHOUT_QDRANT = `services:
  paparats:
    image: ibaz/paparats-server:latest
  embed:
    image: ibaz/paparats-embed:latest
`;

const STUB_INSTALL_STATE = { embedMode: 'native' as const };

function stubRegenerate(
  override?: Partial<RegenerateResult>
): (opts: RegenerateOptions) => RegenerateResult {
  return () => ({ changed: false, composeYaml: COMPOSE_WITH_QDRANT, ...override });
}

describe('update', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let execMock: ReturnType<typeof vi.fn>;
  let embedMock: ReturnType<typeof vi.fn>;

  // Default CLI-version deps: installed === latest → the version guard passes.
  // Individual tests override to exercise the mismatch path. Bundled so every
  // runUpdate call can spread them without touching real npm.
  const versionDeps = {
    readInstalledCliVersion: () => '1.7.2',
    readNpmLatestVersion: () => '1.7.2',
    commandExists: () => false,
    platform: () => 'linux' as NodeJS.Platform,
  };

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    execMock = vi.fn();
    // Stub the native embed setup everywhere so tests never touch brew/network.
    embedMock = vi.fn().mockResolvedValue(undefined);
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
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => STUB_INSTALL_STATE,
          regenerateCompose: stubRegenerate(),
        }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('npm install -g @paparats/cli@latest'),
        expect.any(Object)
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringMatching(/docker compose -f .* pull/),
        expect.any(Object)
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringMatching(/docker compose -f .* up -d --remove-orphans/),
        expect.any(Object)
      );
    });

    it('skips CLI when --skip-cli', async () => {
      await runUpdate(
        { skipCli: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => STUB_INSTALL_STATE,
          regenerateCompose: stubRegenerate(),
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
          setupNativeEmbed: embedMock,
          ...versionDeps,
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
          setupNativeEmbed: embedMock,
          ...versionDeps,
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

    it('skips Qdrant health check when using external Qdrant', async () => {
      const healthMock = vi.fn().mockResolvedValue(true);
      await runUpdate(
        { skipCli: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: healthMock,
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITHOUT_QDRANT,
          readInstallState: () => STUB_INSTALL_STATE,
          regenerateCompose: stubRegenerate({ composeYaml: COMPOSE_WITHOUT_QDRANT }),
        }
      );

      // Should only check MCP server health, not Qdrant
      expect(healthMock).toHaveBeenCalledTimes(1);
      expect(healthMock).toHaveBeenCalledWith(
        expect.stringContaining('9876/health'),
        expect.any(String)
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
    });

    it('checks both Qdrant and MCP health when Qdrant is local', async () => {
      const healthMock = vi.fn().mockResolvedValue(true);
      await runUpdate(
        { skipCli: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: healthMock,
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => STUB_INSTALL_STATE,
          regenerateCompose: stubRegenerate(),
        }
      );

      expect(healthMock).toHaveBeenCalledTimes(2);
      expect(healthMock).toHaveBeenCalledWith(
        expect.stringContaining('6333/healthz'),
        expect.any(String)
      );
      expect(healthMock).toHaveBeenCalledWith(
        expect.stringContaining('9876/health'),
        expect.any(String)
      );
    });

    it('regenerates compose, reports the backup path, and tears down orphans', async () => {
      const regenerate = vi.fn((_opts: RegenerateOptions): RegenerateResult => ({
        changed: true,
        composeYaml: COMPOSE_WITH_QDRANT,
        backupPath: '/tmp/docker-compose.yml.bak',
      }));

      await runUpdate(
        { skipCli: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => STUB_INSTALL_STATE,
          regenerateCompose: regenerate,
        }
      );

      expect(regenerate).toHaveBeenCalledWith(
        expect.objectContaining({ backupOnChange: true, embedMode: 'native' })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('/tmp/docker-compose.yml.bak'));
      expect(execMock).toHaveBeenCalledWith(
        expect.stringMatching(/docker compose -f .* up -d --remove-orphans/),
        expect.any(Object)
      );
    });

    it('skips compose regeneration when install.json is missing', async () => {
      const regenerate = vi.fn(stubRegenerate());

      await runUpdate(
        { skipCli: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => null,
          regenerateCompose: regenerate,
        }
      );

      expect(regenerate).not.toHaveBeenCalled();
      // Pull + up still run — we don't want missing install.json to stop the update.
      expect(execMock).toHaveBeenCalledWith(
        expect.stringMatching(/docker compose -f .* pull/),
        expect.any(Object)
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringMatching(/docker compose -f .* up -d --remove-orphans/),
        expect.any(Object)
      );
    });

    it('refreshes the native embed server for native installs', async () => {
      await runUpdate(
        { skipCli: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => ({ embedMode: 'native' as const }),
          regenerateCompose: stubRegenerate(),
        }
      );

      expect(embedMock).toHaveBeenCalledTimes(1);
    });

    it('does not touch the embed server for docker installs', async () => {
      await runUpdate(
        { skipCli: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => ({ embedMode: 'docker' as const }),
          regenerateCompose: stubRegenerate(),
        }
      );

      expect(embedMock).not.toHaveBeenCalled();
    });

    it('skips the embed refresh when --skip-embed', async () => {
      await runUpdate(
        { skipCli: true, skipEmbed: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => ({ embedMode: 'native' as const }),
          regenerateCompose: stubRegenerate(),
        }
      );

      expect(embedMock).not.toHaveBeenCalled();
    });

    it('refreshes the embed server even when Docker is skipped (native install)', async () => {
      await runUpdate(
        { skipCli: true, skipDocker: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          readInstallState: () => ({ embedMode: 'native' as const }),
        }
      );

      expect(embedMock).toHaveBeenCalledTimes(1);
    });

    // ── CLI-version verification (defect A) ──────────────────────────────────

    it('throws when the CLI did not actually upgrade to npm latest', async () => {
      await expect(
        runUpdate(
          {},
          {
            execSync: execMock,
            setupNativeEmbed: embedMock,
            ...versionDeps,
            // npm install exited 0 but the global stayed on an old version
            readInstalledCliVersion: () => '0.2.18',
            readNpmLatestVersion: () => '1.7.2',
            getDockerComposeCommand: () => 'docker compose',
            waitForHealth: () => Promise.resolve(true),
            existsSync: () => true,
            readFileSync: () => COMPOSE_WITH_QDRANT,
            readInstallState: () => STUB_INSTALL_STATE,
            regenerateCompose: stubRegenerate(),
          }
        )
      ).rejects.toThrow(
        /CLI did not update: the running .* is 0\.2\.18, but npm latest is 1\.7\.2/
      );

      // Aborts before Docker/embed run — old code must not proceed.
      expect(embedMock).not.toHaveBeenCalled();
    });

    it('does not throw when version is unknown (offline / npm unreachable)', async () => {
      await runUpdate(
        {},
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          readInstalledCliVersion: () => '0.2.18',
          readNpmLatestVersion: () => null, // registry unreachable
          getDockerComposeCommand: () => 'docker compose',
          waitForHealth: () => Promise.resolve(true),
          existsSync: () => true,
          readFileSync: () => COMPOSE_WITH_QDRANT,
          readInstallState: () => STUB_INSTALL_STATE,
          regenerateCompose: stubRegenerate(),
        }
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Update complete'));
    });

    // ── native-embed detection without install.json (defect B) ───────────────

    it('refreshes embed when no install.json but llama-swap is on PATH', async () => {
      await runUpdate(
        { skipCli: true, skipDocker: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          commandExists: (cmd: string) => cmd === 'llama-swap',
          readInstallState: () => null,
        }
      );
      expect(embedMock).toHaveBeenCalledTimes(1);
    });

    it('refreshes embed when no install.json but llama-swap.yaml exists', async () => {
      await runUpdate(
        { skipCli: true, skipDocker: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          commandExists: () => false,
          existsSync: (p: string) => p.endsWith('llama-swap.yaml'),
          readInstallState: () => null,
        }
      );
      expect(embedMock).toHaveBeenCalledTimes(1);
    });

    it('refreshes embed on macOS with no install.json and no docker-compose.yml', async () => {
      await runUpdate(
        { skipCli: true, skipDocker: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          commandExists: () => false,
          platform: () => 'darwin' as NodeJS.Platform,
          existsSync: () => false, // no compose file
          readInstallState: () => null,
        }
      );
      expect(embedMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT refresh embed when no install.json and no native signals (Linux, docker-only)', async () => {
      await runUpdate(
        { skipCli: true, skipDocker: true },
        {
          execSync: execMock,
          setupNativeEmbed: embedMock,
          ...versionDeps,
          commandExists: () => false,
          platform: () => 'linux' as NodeJS.Platform,
          existsSync: () => false,
          readInstallState: () => null,
        }
      );
      expect(embedMock).not.toHaveBeenCalled();
      // And it says why it skipped (defect C).
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping native embed refresh'));
    });
  });
});
