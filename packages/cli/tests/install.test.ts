import { describe, it, expect, vi } from 'vitest';
import {
  detectLegacyInstall,
  decideEmbedMode,
  decideEmbeddingProvider,
  mergeDotenv,
  upsertMcpServer,
  type InstallOptions,
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
    await expect(decideEmbedMode(opts, deps)).rejects.toThrow(/llama.cpp llama-swap/);
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
