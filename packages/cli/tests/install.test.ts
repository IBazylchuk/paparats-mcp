import { describe, it, expect, vi } from 'vitest';
import {
  detectLegacyInstall,
  decideOllamaMode,
  upsertMcpServer,
  type InstallOptions,
} from '../src/commands/install.js';

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
