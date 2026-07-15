import { describe, it, expect, vi } from 'vitest';
import {
  detectLegacyInstall,
  decideEmbedMode,
  decideEmbeddingProvider,
  mergeDotenv,
  upsertMcpServer,
  ensureLocalEmbed,
  type InstallOptions,
  type EmbedSetupDeps,
} from '../src/commands/install.js';
import type { EmbeddingProvider } from '../src/docker-compose-generator.js';

describe('detectLegacyInstall', () => {
  it('returns null for null content', () => {
    expect(detectLegacyInstall(null)).toBeNull();
  });

  it('returns null when compose already includes paparats-indexer', () => {
    const compose = `services:
  paparats:
    container_name: paparats-mcp
  paparats-indexer:
    container_name: paparats-indexer
`;
    expect(detectLegacyInstall(compose)).toBeNull();
  });

  it('triggers migration when paparats-mcp is present without paparats-indexer', () => {
    const compose = `services:
  paparats:
    container_name: paparats-mcp
    environment:
      QDRANT_URL: http://qdrant:6333
`;
    expect(detectLegacyInstall(compose)).not.toBeNull();
  });

  it('triggers migration with single-quoted container_name (yaml dump variant)', () => {
    const compose = "container_name: 'paparats-mcp'";
    expect(detectLegacyInstall(compose)).not.toBeNull();
  });

  it('returns null for unrelated compose content', () => {
    expect(detectLegacyInstall('services:\n  other:\n    image: foo')).toBeNull();
  });
});

// ── decideEmbedMode ─────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<Parameters<typeof decideEmbedMode>[1]> = {}) {
  return {
    commandExists: vi.fn().mockReturnValue(false),
    getDockerComposeCommand: vi.fn(),
    isEmbedServerRunning: vi.fn().mockResolvedValue(false),
    waitForHealth: vi.fn().mockResolvedValue(true),
    downloadFile: vi.fn(),
    generateCompose: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
    platform: vi.fn().mockReturnValue('linux' as NodeJS.Platform),
    execSync: vi.fn(),
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  };
}

describe('decideEmbedMode', () => {
  it('returns external when --embed-url is set', async () => {
    const deps = makeDeps();
    const result = await decideEmbedMode({ embedUrl: 'http://10.0.0.5:11434' }, deps);
    expect(result.mode).toBe('external');
    expect(result.embedUrl).toBe('http://10.0.0.5:11434');
    expect(result.setupHostEmbed).toBe(false);
  });

  it('macOS + llama-server & llama-swap on PATH → native, no prompt', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      commandExists: vi
        .fn()
        .mockImplementation((cmd: string) => cmd === 'llama-server' || cmd === 'llama-swap'),
    });
    const result = await decideEmbedMode({}, deps);
    expect(result.mode).toBe('native');
    expect(result.setupHostEmbed).toBe(true);
  });

  it('macOS + no llama binaries + --non-interactive → throws with hint', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      commandExists: vi.fn().mockReturnValue(false),
    });
    const opts: InstallOptions = { nonInteractive: true };
    await expect(decideEmbedMode(opts, deps)).rejects.toThrow(
      /llama.cpp mostlygeek\/llama-swap\/llama-swap/
    );
  });

  it('macOS + no llama + user picks brew → returns native (brew install deferred)', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      commandExists: vi.fn().mockImplementation((cmd: string) => cmd === 'brew'),
      promptEmbedChoiceMacOs: vi.fn().mockResolvedValue('brew' as const),
    });
    const result = await decideEmbedMode({}, deps);
    expect(result.mode).toBe('native');
    expect(result.setupHostEmbed).toBe(true);
    // brew install happens later in ensureLocalEmbed, not in the decision
    expect(deps.execSync).not.toHaveBeenCalled();
  });

  it('macOS + no llama + user picks remote → returns external with prompted url', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      promptEmbedChoiceMacOs: vi.fn().mockResolvedValue('remote' as const),
      promptRemoteEmbedUrl: vi.fn().mockResolvedValue('http://my.host:11434'),
    });
    const result = await decideEmbedMode({}, deps);
    expect(result.mode).toBe('external');
    expect(result.embedUrl).toBe('http://my.host:11434');
  });

  it('macOS + no llama + user picks docker → returns docker mode', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      promptEmbedChoiceMacOs: vi.fn().mockResolvedValue('docker' as const),
    });
    const result = await decideEmbedMode({}, deps);
    expect(result.mode).toBe('docker');
  });

  it('Linux default → docker without prompts', async () => {
    const deps = makeDeps({ platform: vi.fn().mockReturnValue('linux' as NodeJS.Platform) });
    const result = await decideEmbedMode({}, deps);
    expect(result.mode).toBe('docker');
    expect(result.setupHostEmbed).toBe(false);
  });

  it('--embed-mode docker forces docker', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      commandExists: vi
        .fn()
        .mockImplementation((cmd: string) => cmd === 'llama-server' || cmd === 'llama-swap'),
    });
    const result = await decideEmbedMode({ embedMode: 'docker' }, deps);
    expect(result.mode).toBe('docker');
  });

  it('--embed-mode native forces native (setupHostEmbed=true)', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('linux' as NodeJS.Platform),
    });
    const result = await decideEmbedMode({ embedMode: 'native' }, deps);
    expect(result.mode).toBe('native');
    expect(result.setupHostEmbed).toBe(true);
  });
});

// ── decideEmbeddingProvider ────────────────────────────────────────────────

describe('decideEmbeddingProvider', () => {
  it('returns llama with no API key when --embeddings llama', async () => {
    const deps = makeDeps();
    const result = await decideEmbeddingProvider({ embeddings: 'llama' }, deps);
    expect(result.provider).toBe('llama');
    expect(result.apiKey).toBeUndefined();
  });

  it('returns llama by default in --non-interactive without --embeddings', async () => {
    const deps = makeDeps();
    const result = await decideEmbeddingProvider({ nonInteractive: true }, deps);
    expect(result.provider).toBe('llama');
  });

  it('uses --embedding-api-key when provided', async () => {
    const deps = makeDeps();
    const result = await decideEmbeddingProvider(
      { embeddings: 'openai', embeddingApiKey: '  sk-explicit ' },
      deps
    );
    expect(result.provider).toBe('openai');
    expect(result.apiKey).toBe('sk-explicit');
  });

  it('falls back to OPENAI_API_KEY env var when --embedding-api-key absent', async () => {
    const deps = makeDeps({ env: { OPENAI_API_KEY: 'sk-from-env' } as NodeJS.ProcessEnv });
    const result = await decideEmbeddingProvider({ embeddings: 'openai' }, deps);
    expect(result.apiKey).toBe('sk-from-env');
  });

  it('falls back to VOYAGE_API_KEY env var for voyage', async () => {
    const deps = makeDeps({ env: { VOYAGE_API_KEY: 'pa-from-env' } as NodeJS.ProcessEnv });
    const result = await decideEmbeddingProvider({ embeddings: 'voyage' }, deps);
    expect(result.provider).toBe('voyage');
    expect(result.apiKey).toBe('pa-from-env');
  });

  it('--non-interactive + cloud + no key in env or flag → throws clearly', async () => {
    const deps = makeDeps();
    await expect(
      decideEmbeddingProvider({ embeddings: 'openai', nonInteractive: true }, deps)
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('explicit flag wins over env var', async () => {
    const deps = makeDeps({ env: { OPENAI_API_KEY: 'env-key' } as NodeJS.ProcessEnv });
    const result = await decideEmbeddingProvider(
      { embeddings: 'openai', embeddingApiKey: 'flag-key' },
      deps
    );
    expect(result.apiKey).toBe('flag-key');
  });

  it('interactive prompts when no flag and not non-interactive', async () => {
    const promptProvider = vi.fn<() => Promise<EmbeddingProvider>>().mockResolvedValue('openai');
    const promptKey = vi.fn().mockResolvedValue('prompted-key');
    const deps = makeDeps({
      promptEmbeddingProvider: promptProvider,
      promptEmbeddingApiKey: promptKey,
    });
    const result = await decideEmbeddingProvider({}, deps);
    expect(promptProvider).toHaveBeenCalled();
    expect(promptKey).toHaveBeenCalledWith('openai');
    expect(result.provider).toBe('openai');
    expect(result.apiKey).toBe('prompted-key');
  });
});

// ── mergeDotenv ─────────────────────────────────────────────────────────────

describe('mergeDotenv', () => {
  it('writes new keys when the file is empty', () => {
    expect(mergeDotenv('', { OPENAI_API_KEY: 'sk-x' })).toBe('OPENAI_API_KEY=sk-x\n');
  });

  it('preserves user-added entries and updates managed ones in place', () => {
    const existing = `HTTP_PROXY=http://proxy:3128
QDRANT_API_KEY=old-key
# my comment
CUSTOM_VAR=hello
`;
    const merged = mergeDotenv(existing, {
      QDRANT_API_KEY: 'new-key',
      OPENAI_API_KEY: 'sk-new',
    });
    expect(merged).toBe(
      `HTTP_PROXY=http://proxy:3128
QDRANT_API_KEY=new-key
# my comment
CUSTOM_VAR=hello
OPENAI_API_KEY=sk-new
`
    );
  });

  it('preserves comments and blank lines unchanged', () => {
    const existing = `# top comment

QDRANT_API_KEY=old
# trailing
`;
    const merged = mergeDotenv(existing, { QDRANT_API_KEY: 'new' });
    expect(merged).toBe(`# top comment

QDRANT_API_KEY=new
# trailing
`);
  });

  it('appends keys not present in the existing file', () => {
    const existing = `HTTP_PROXY=http://proxy:3128\n`;
    const merged = mergeDotenv(existing, { VOYAGE_API_KEY: 'pa-x' });
    expect(merged).toBe(`HTTP_PROXY=http://proxy:3128\nVOYAGE_API_KEY=pa-x\n`);
  });

  it('does not duplicate trailing newlines on re-runs', () => {
    const round1 = mergeDotenv('', { QDRANT_API_KEY: 'a' });
    const round2 = mergeDotenv(round1, { QDRANT_API_KEY: 'b' });
    const round3 = mergeDotenv(round2, { QDRANT_API_KEY: 'c' });
    expect(round3).toBe('QDRANT_API_KEY=c\n');
  });

  it('ignores lines that do not look like KEY=value assignments', () => {
    const existing = `not-a-kv-line
QDRANT_API_KEY=old
`;
    const merged = mergeDotenv(existing, { QDRANT_API_KEY: 'new' });
    expect(merged).toBe(`not-a-kv-line\nQDRANT_API_KEY=new\n`);
  });
});

// ── upsertMcpServer (legacy helper, still in use) ──────────────────────────

describe('upsertMcpServer', () => {
  it('creates a fresh file when missing', () => {
    const writes: Record<string, string> = {};
    const deps = {
      readFileSync: () => '',
      writeFileSync: (p: string, d: string) => {
        writes[p] = d;
      },
      existsSync: () => false,
      mkdirSync: () => undefined,
    };
    const r = upsertMcpServer('/tmp/x.json', 'paparats', { url: 'http://x' }, deps);
    expect(r).toBe('added');
    const parsed = JSON.parse(writes['/tmp/x.json']!);
    expect(parsed.mcpServers.paparats.url).toBe('http://x');
  });

  it('returns unchanged when url matches', () => {
    const initial = JSON.stringify({ mcpServers: { paparats: { url: 'http://x' } } });
    const deps = {
      readFileSync: () => initial,
      writeFileSync: () => undefined,
      existsSync: () => true,
      mkdirSync: () => undefined,
    };
    const r = upsertMcpServer('/tmp/x.json', 'paparats', { url: 'http://x' }, deps);
    expect(r).toBe('unchanged');
  });
});

// ── ensureLocalEmbed: launcher (launchd on macOS, detached spawn elsewhere) ──

function makeEmbedDeps(overrides: Partial<EmbedSetupDeps> = {}): EmbedSetupDeps {
  return {
    // binaries already present → brewInstall is a no-op
    commandExists: vi.fn().mockReturnValue(true),
    // healthy immediately so the poll loop exits on the first tick
    isEmbedServerRunning: vi.fn().mockResolvedValue(true),
    downloadFile: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    // GGUFs already downloaded → no network
    existsSync: vi.fn().mockReturnValue(true),
    unlinkSync: vi.fn(),
    execSync: vi.fn().mockReturnValue('/opt/homebrew/bin/llama-swap\n'),
    spawnDetached: vi.fn(),
    platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ensureLocalEmbed launcher', () => {
  it('installs and bootstraps a LaunchAgent on macOS (no detached spawn)', async () => {
    const deps = makeEmbedDeps({ platform: vi.fn().mockReturnValue('darwin') });
    await ensureLocalEmbed(deps, []);

    const execCalls = (deps.execSync as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    const writeCalls = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );

    // plist written to ~/Library/LaunchAgents
    expect(writeCalls.some((p) => p.includes('LaunchAgents/com.paparats.embed.plist'))).toBe(true);
    // resolved the binary path and bootstrapped the agent
    expect(execCalls).toContain('command -v llama-swap');
    expect(execCalls.some((c) => c.startsWith('launchctl bootstrap '))).toBe(true);
    // never falls back to a detached spawn on macOS
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it('boots out a stale agent before bootstrapping (reload)', async () => {
    const deps = makeEmbedDeps();
    await ensureLocalEmbed(deps, []);
    const execCalls = (deps.execSync as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    const bootoutIdx = execCalls.findIndex((c) => c.startsWith('launchctl bootout '));
    const bootstrapIdx = execCalls.findIndex((c) => c.startsWith('launchctl bootstrap '));
    expect(bootoutIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThan(bootoutIdx);
  });

  it('embeds the resolved llama-swap path into the plist', async () => {
    const written: Record<string, string> = {};
    const deps = makeEmbedDeps({
      execSync: vi.fn((cmd: string) =>
        String(cmd) === 'command -v llama-swap' ? '/custom/bin/llama-swap\n' : ''
      ),
      writeFileSync: vi.fn((p: string, data: string) => {
        written[p] = data;
      }),
    });
    await ensureLocalEmbed(deps, []);
    const plist = Object.entries(written).find(([p]) =>
      p.endsWith('com.paparats.embed.plist')
    )?.[1];
    expect(plist).toContain('<string>/custom/bin/llama-swap</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    // PATH must include the binary's dir so launchd's minimal PATH can still
    // find `llama-server`, which the llama-swap config spawns by bare name.
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toMatch(/<string>\/custom\/bin:[^<]*<\/string>/);
  });

  it('uses a detached spawn on non-macOS (no launchctl)', async () => {
    const deps = makeEmbedDeps({
      platform: vi.fn().mockReturnValue('linux'),
      isEmbedServerRunning: vi
        .fn()
        .mockResolvedValueOnce(false) // pre-check: not running
        .mockResolvedValue(true), // health poll: up
    });
    await ensureLocalEmbed(deps, []);

    expect(deps.spawnDetached).toHaveBeenCalledWith('llama-swap', [
      '--config',
      expect.stringContaining('llama-swap.yaml'),
      '--listen',
      '127.0.0.1:11434',
    ]);
    const execCalls = (deps.execSync as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    expect(execCalls.some((c) => c.includes('launchctl'))).toBe(false);
  });

  it('throws if the server never becomes healthy', async () => {
    const deps = makeEmbedDeps({
      platform: vi.fn().mockReturnValue('linux'),
      isEmbedServerRunning: vi.fn().mockResolvedValue(false),
    });
    await expect(ensureLocalEmbed(deps, [])).rejects.toThrow(/Failed to start llama-swap/);
  });

  it('falls back to a Homebrew path when `command -v llama-swap` is not on PATH', async () => {
    const written: Record<string, string> = {};
    const deps = makeEmbedDeps({
      // `command -v llama-swap` throws (brew bin dir not on this process PATH);
      // launchctl calls succeed.
      execSync: vi.fn((cmd: string) => {
        if (String(cmd) === 'command -v llama-swap') throw new Error('not found');
        return '';
      }),
      // binary present in a standard Homebrew location
      existsSync: vi.fn((p: string) => p === '/opt/homebrew/bin/llama-swap' || true),
      writeFileSync: vi.fn((p: string, data: string) => {
        written[p] = data;
      }),
    });
    await ensureLocalEmbed(deps, []);
    const plist = Object.entries(written).find(([p]) =>
      p.endsWith('com.paparats.embed.plist')
    )?.[1];
    expect(plist).toContain('<string>/opt/homebrew/bin/llama-swap</string>');
  });

  it('throws a clear error when llama-swap is nowhere to be found', async () => {
    const deps = makeEmbedDeps({
      execSync: vi.fn((cmd: string) => {
        if (String(cmd) === 'command -v llama-swap') throw new Error('not found');
        return '';
      }),
      // neither the GGUFs nor the binary exist — but brewInstall is skipped
      // because commandExists returns true, so we reach the launcher and fail
      // resolving the binary path.
      existsSync: vi.fn((p: string) => p.endsWith('.gguf')),
    });
    await expect(ensureLocalEmbed(deps, [])).rejects.toThrow(/binary not found on PATH/);
  });
});
