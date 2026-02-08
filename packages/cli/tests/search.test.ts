import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runSearch,
  validateSearchResponse,
  type SearchResponseData,
} from '../src/commands/search.js';

const mockSearch = (res: { status: number; data: unknown }) => ({
  search: vi.fn().mockResolvedValue(res),
});

function createMockSpinner() {
  return {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  };
}

describe('search', () => {
  const validData: SearchResponseData = {
    results: [
      {
        project: 'my-project',
        file: '/path/to/file.ts',
        language: 'typescript',
        startLine: 10,
        endLine: 15,
        content: 'const x = 1;\nconst y = 2;',
        score: 0.95,
      },
    ],
    total: 1,
    metrics: {
      tokensReturned: 50,
      estimatedFullFileTokens: 200,
      tokensSaved: 150,
      savingsPercent: 75,
    },
  };

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

  describe('validateSearchResponse', () => {
    it('returns true for valid response', () => {
      expect(validateSearchResponse(validData)).toBe(true);
    });

    it('returns false for null', () => {
      expect(validateSearchResponse(null)).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(validateSearchResponse('string')).toBe(false);
      expect(validateSearchResponse(123)).toBe(false);
    });

    it('returns false when results is missing', () => {
      const bad = { ...validData, results: undefined };
      expect(validateSearchResponse(bad)).toBe(false);
    });

    it('returns false when results is not array', () => {
      const bad = { ...validData, results: 'not-array' };
      expect(validateSearchResponse(bad)).toBe(false);
    });

    it('returns false when total is missing', () => {
      const bad = { ...validData, total: undefined };
      expect(validateSearchResponse(bad)).toBe(false);
    });

    it('returns false when total is not number', () => {
      const bad = { ...validData, total: '1' };
      expect(validateSearchResponse(bad)).toBe(false);
    });

    it('returns false when metrics is missing', () => {
      const bad = { ...validData, metrics: undefined };
      expect(validateSearchResponse(bad)).toBe(false);
    });

    it('returns false when metrics is null', () => {
      const bad = { ...validData, metrics: null };
      expect(validateSearchResponse(bad)).toBe(false);
    });
  });

  describe('runSearch', () => {
    it('outputs JSON when --json', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();
      const readConfig = vi.fn().mockReturnValue({ config: { group: 'my-group' } });

      await runSearch(client, 'foo', { json: true, group: 'my-group' }, { readConfig, spinner });

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(validData, null, 2));
      expect(client.search).toHaveBeenCalledWith(
        'my-group',
        'foo',
        expect.objectContaining({ project: undefined, limit: 5 })
      );
    });

    it('shows results with line numbers', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runSearch(client, 'foo', { group: 'my-group' }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 results for "foo"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[my-project]'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('  10 │'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('const x = 1;'));
    });

    it('passes project undefined when project is "all"', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runSearch(client, 'foo', { group: 'my-group', project: 'all' }, { spinner });

      expect(client.search).toHaveBeenCalledWith(
        'my-group',
        'foo',
        expect.objectContaining({ project: undefined })
      );
    });

    it('passes project when not "all"', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runSearch(client, 'foo', { group: 'my-group', project: 'my-project' }, { spinner });

      expect(client.search).toHaveBeenCalledWith(
        'my-group',
        'foo',
        expect.objectContaining({ project: 'my-project' })
      );
    });

    it('shows "no results" when empty', async () => {
      const client = mockSearch({
        status: 200,
        data: { ...validData, results: [], total: 0 },
      });
      const spinner = createMockSpinner();

      await runSearch(client, 'foo', { group: 'my-group' }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No results found'));
    });

    it('exits 1 on non-200 status', async () => {
      const client = mockSearch({ status: 500, data: { error: 'Server error' } });
      const spinner = createMockSpinner();

      await expect(runSearch(client, 'foo', { group: 'my-group' }, { spinner })).rejects.toThrow(
        'EXIT:1'
      );

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Server error'));
    });

    it('outputs JSON error on non-200 when --json', async () => {
      const client = mockSearch({ status: 500, data: { error: 'Server error' } });
      const spinner = createMockSpinner();

      await expect(
        runSearch(client, 'foo', { json: true, group: 'my-group' }, { spinner })
      ).rejects.toThrow('EXIT:1');

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'Server error' }));
    });

    it('exits 1 on invalid response shape', async () => {
      const client = mockSearch({ status: 200, data: { foo: 'bar' } });
      const spinner = createMockSpinner();

      await expect(runSearch(client, 'foo', { group: 'my-group' }, { spinner })).rejects.toThrow(
        'EXIT:1'
      );

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid search response'));
    });

    it('exits 1 and outputs error on config failure when group not provided', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();
      const readConfig = vi.fn().mockImplementation(() => {
        throw new Error('Config not found');
      });

      await expect(runSearch(client, 'foo', {}, { readConfig, spinner })).rejects.toThrow('EXIT:1');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Config not found'));
    });

    it('shows verbose output when --verbose', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runSearch(client, 'foo', { group: 'my-group', verbose: true }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Search parameters:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Group: my-group'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Detailed metrics:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Tokens returned:'));
    });

    it('shows token savings when metrics.tokensSaved > 0', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runSearch(client, 'foo', { group: 'my-group' }, { spinner });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Token savings:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('150 tokens saved'));
    });

    it('uses readConfig when group not in opts', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();
      const readConfig = vi.fn().mockReturnValue({ config: { group: 'config-group' } });

      await runSearch(client, 'foo', {}, { readConfig, spinner });

      expect(readConfig).toHaveBeenCalled();
      expect(client.search).toHaveBeenCalledWith('config-group', 'foo', expect.any(Object));
    });

    it('passes limit and timeout to client', async () => {
      const client = mockSearch({ status: 200, data: validData });
      const spinner = createMockSpinner();

      await runSearch(client, 'foo', { group: 'my-group', limit: 10, timeout: 5000 }, { spinner });

      expect(client.search).toHaveBeenCalledWith(
        'my-group',
        'foo',
        expect.objectContaining({ limit: 10, timeout: 5000 })
      );
    });
  });
});
