import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runIndex,
  validateIndexResponse,
  printDryRun,
  type IndexResponse,
} from '../src/commands/index-cmd.js';

const validData: IndexResponse = {
  group: 'my-group',
  project: 'my-project',
  chunks: 42,
};

function createMockIndexClient(res: { status: number; data: unknown }) {
  return {
    health: vi.fn().mockResolvedValue({ status: 200 }),
    index: vi.fn().mockResolvedValue(res),
  };
}

function createMockSpinner() {
  return {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  };
}

describe('index-cmd', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('validateIndexResponse', () => {
    it('returns true for valid response', () => {
      expect(validateIndexResponse(validData)).toBe(true);
    });

    it('returns true for response with optional fields', () => {
      expect(validateIndexResponse({ ...validData, skipped: 5, errors: ['err1'] })).toBe(true);
    });

    it('returns false for null', () => {
      expect(validateIndexResponse(null)).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(validateIndexResponse('string')).toBe(false);
      expect(validateIndexResponse(123)).toBe(false);
    });

    it('returns false when group is missing', () => {
      const bad = { ...validData, group: undefined };
      expect(validateIndexResponse(bad)).toBe(false);
    });

    it('returns false when project is missing', () => {
      const bad = { ...validData, project: undefined };
      expect(validateIndexResponse(bad)).toBe(false);
    });

    it('returns false when chunks is missing', () => {
      const bad = { ...validData, chunks: undefined };
      expect(validateIndexResponse(bad)).toBe(false);
    });

    it('returns false when chunks is not a number', () => {
      const bad = { ...validData, chunks: '42' };
      expect(validateIndexResponse(bad)).toBe(false);
    });
  });

  describe('printDryRun', () => {
    it('prints config summary', () => {
      const config = {
        config: {
          group: 'g',
          language: 'typescript',
          indexing: { paths: ['src'], exclude: ['node_modules'] },
        },
        projectDir: '/tmp/proj',
      };
      printDryRun(config);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Dry run mode'));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Group:') && expect.stringContaining('g')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Project:') && expect.stringContaining('/tmp/proj')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Language:') && expect.stringContaining('typescript')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Paths:') && expect.stringContaining('src')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Exclude:') && expect.stringContaining('node_modules')
      );
    });

    it('handles array language', () => {
      const config = {
        config: { group: 'g', language: ['ruby', 'typescript'] },
        projectDir: '/tmp/proj',
      };
      printDryRun(config);
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Language:.*ruby.*typescript/));
    });
  });

  describe('runIndex', () => {
    it('outputs success message on successful index', async () => {
      const client = createMockIndexClient({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runIndex(client, '/tmp/proj', 'my-group', {}, { spinner });

      expect(spinner.succeed).toHaveBeenCalledWith(expect.stringContaining('my-project'));
      expect(spinner.succeed).toHaveBeenCalledWith(expect.stringContaining('my-group'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/42 chunks indexed/));
    });

    it('outputs JSON when --json', async () => {
      const client = createMockIndexClient({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runIndex(client, '/tmp/proj', 'my-group', { json: true }, { spinner });

      expect(logSpy).toHaveBeenCalled();
      const jsonOutput = logSpy.mock.calls[0]?.[0];
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed.group).toBe('my-group');
      expect(parsed.project).toBe('my-project');
      expect(parsed.chunks).toBe(42);
      expect(parsed.elapsed).toBeDefined();
      expect(parsed.timestamp).toBeDefined();
    });

    it('calls index with timeout and force when provided', async () => {
      const client = createMockIndexClient({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runIndex(client, '/tmp/proj', 'g', { timeout: 120_000, force: true }, { spinner });

      expect(client.index).toHaveBeenCalledWith('/tmp/proj', {
        timeout: 120_000,
        signal: undefined,
        force: true,
      });
    });

    it('exits 1 on non-200 status', async () => {
      const client = createMockIndexClient({
        status: 500,
        data: { error: 'Server error' },
      });
      const spinner = createMockSpinner();

      await expect(runIndex(client, '/tmp/proj', 'g', {}, { spinner })).rejects.toThrow('EXIT:1');

      expect(spinner.fail).toHaveBeenCalledWith(expect.stringContaining('Indexing failed'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Server error'));
    });

    it('exits 1 on invalid response shape', async () => {
      const client = createMockIndexClient({
        status: 200,
        data: { foo: 'bar' },
      });
      const spinner = createMockSpinner();

      await expect(runIndex(client, '/tmp/proj', 'g', {}, { spinner })).rejects.toThrow('EXIT:1');

      expect(spinner.fail).toHaveBeenCalledWith(expect.stringContaining('Invalid response'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Expected:'));
    });

    it('outputs JSON error on failure when --json', async () => {
      const client = createMockIndexClient({
        status: 500,
        data: { error: 'Server error' },
      });
      const spinner = createMockSpinner();

      await expect(runIndex(client, '/tmp/proj', 'g', { json: true }, { spinner })).rejects.toThrow(
        'EXIT:1'
      );

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Server error' }));
    });

    it('exits 1 on network failure', async () => {
      const client = {
        health: vi.fn().mockResolvedValue({ status: 200 }),
        index: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      const spinner = createMockSpinner();

      await expect(runIndex(client, '/tmp/proj', 'g', {}, { spinner })).rejects.toThrow('EXIT:1');

      expect(spinner.fail).toHaveBeenCalledWith('Indexing failed');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Connection refused'));
    });

    it('exits 130 on abort', async () => {
      const client = {
        health: vi.fn().mockResolvedValue({ status: 200 }),
        index: vi.fn().mockRejectedValue(new Error('Request aborted')),
      };
      const spinner = createMockSpinner();

      await expect(runIndex(client, '/tmp/proj', 'g', {}, { spinner })).rejects.toThrow('EXIT:130');

      expect(spinner.fail).toHaveBeenCalledWith('Indexing cancelled');
    });

    it('shows verbose output when skipped and errors present', async () => {
      const dataWithExtra: IndexResponse = {
        ...validData,
        skipped: 3,
        errors: ['file1.ts: parse error'],
      };
      const client = createMockIndexClient({ status: 200, data: dataWithExtra });
      const spinner = createMockSpinner();

      await runIndex(client, '/tmp/proj', 'g', { verbose: true }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/3 files skipped/));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/1 errors encountered/));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/file1.ts: parse error/));
    });

    it('uses null spinner in JSON mode', async () => {
      const client = createMockIndexClient({ status: 200, data: validData });

      await runIndex(client, '/tmp/proj', 'g', { json: true }, { spinner: null });

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/"group":\s*"my-group"/));
    });
  });
});
