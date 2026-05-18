import { describe, it, expect, vi } from 'vitest';
import {
  detectLegacyInstall,
  decideOllamaMode,
  decideEmbeddingProvider,
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

// ── decideOllamaMode ───────────────────────────────────────────────────────

function makeDeps(overrides: Partial<Parameters<typeof decideOllamaMode>[1]> = {}) {
  return {
    commandExists: vi.fn().mockReturnValue(false),
    getDockerComposeCommand: vi.fn(),
    ollamaModelExists: vi.fn().mockReturnValue(false),
    isOllamaRunning: vi.fn().mockResolvedValue(false),
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

describe('decideOllamaMode', () => {
  it('returns external when --ollama-url is set', async () => {
    const deps = makeDeps();
    const result = await decideOllamaMode({ ollamaUrl: 'http://10.0.0.5:11434' }, deps);
    expect(result.mode).toBe('external');
    expect(result.ollamaUrl).toBe('http://10.0.0.5:11434');
    expect(result.setupHostOllama).toBe(false);
  });

  it('macOS + ollama on PATH → native, no prompt', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      commandExists: vi.fn().mockImplementation((cmd: string) => cmd === 'ollama'),
    });
    const result = await decideOllamaMode({}, deps);
    expect(result.mode).toBe('native');
    expect(result.setupHostOllama).toBe(true);
  });

  it('macOS + no ollama + --non-interactive → throws with hint', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      commandExists: vi.fn().mockReturnValue(false),
    });
    const opts: InstallOptions = { nonInteractive: true };
    await expect(decideOllamaMode(opts, deps)).rejects.toThrow(/brew install ollama/);
  });

  it('macOS + no ollama + user picks brew → installs and returns native', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      commandExists: vi.fn().mockImplementation((cmd: string) => cmd === 'brew'),
      promptOllamaChoiceMacOs: vi.fn().mockResolvedValue('brew' as const),
    });
    const result = await decideOllamaMode({}, deps);
    expect(result.mode).toBe('native');
    expect(deps.execSync).toHaveBeenCalledWith('brew install ollama', expect.any(Object));
  });

  it('macOS + no ollama + user picks remote → returns external with prompted url', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      promptOllamaChoiceMacOs: vi.fn().mockResolvedValue('remote' as const),
      promptRemoteOllamaUrl: vi.fn().mockResolvedValue('http://my.host:11434'),
    });
    const result = await decideOllamaMode({}, deps);
    expect(result.mode).toBe('external');
    expect(result.ollamaUrl).toBe('http://my.host:11434');
  });

  it('macOS + no ollama + user picks docker → returns docker mode', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      promptOllamaChoiceMacOs: vi.fn().mockResolvedValue('docker' as const),
    });
    const result = await decideOllamaMode({}, deps);
    expect(result.mode).toBe('docker');
  });

  it('Linux default → docker without prompts', async () => {
    const deps = makeDeps({ platform: vi.fn().mockReturnValue('linux' as NodeJS.Platform) });
    const result = await decideOllamaMode({}, deps);
    expect(result.mode).toBe('docker');
    expect(result.setupHostOllama).toBe(false);
  });

  it('--ollama-mode docker forces docker', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('darwin' as NodeJS.Platform),
      commandExists: vi.fn().mockImplementation((cmd: string) => cmd === 'ollama'),
    });
    const result = await decideOllamaMode({ ollamaMode: 'docker' }, deps);
    expect(result.mode).toBe('docker');
  });

  it('--ollama-mode native forces native (setupHostOllama=true)', async () => {
    const deps = makeDeps({
      platform: vi.fn().mockReturnValue('linux' as NodeJS.Platform),
    });
    const result = await decideOllamaMode({ ollamaMode: 'native' }, deps);
    expect(result.mode).toBe('native');
    expect(result.setupHostOllama).toBe(true);
  });
});

// ── decideEmbeddingProvider ────────────────────────────────────────────────

describe('decideEmbeddingProvider', () => {
  it('returns ollama with no API key when --embeddings ollama', async () => {
    const deps = makeDeps();
    const result = await decideEmbeddingProvider({ embeddings: 'ollama' }, deps);
    expect(result.provider).toBe('ollama');
    expect(result.apiKey).toBeUndefined();
  });

  it('returns ollama by default in --non-interactive without --embeddings', async () => {
    const deps = makeDeps();
    const result = await decideEmbeddingProvider({ nonInteractive: true }, deps);
    expect(result.provider).toBe('ollama');
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
