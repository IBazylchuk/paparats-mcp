import { describe, expect, it } from 'vitest';
import { describeQdrantError } from '../src/qdrant-errors.js';

function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function sysError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

describe('describeQdrantError', () => {
  it('names the connection failure behind a bare "fetch failed"', () => {
    const message = describeQdrantError(fetchFailed(sysError('ECONNREFUSED')));
    expect(message).toBe(
      'Cannot reach Qdrant (ECONNREFUSED). Check that Qdrant is running and QDRANT_URL points at it.'
    );
  });

  it('reads the first failure of an AggregateError cause', () => {
    const cause = new AggregateError([sysError('ETIMEDOUT'), sysError('ENETUNREACH')], '');
    expect(describeQdrantError(fetchFailed(cause))).toContain('(ETIMEDOUT)');
  });

  it('recognises undici error codes', () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    expect(describeQdrantError(fetchFailed(cause))).toContain('(UND_ERR_CONNECT_TIMEOUT)');
  });

  it('keeps the message of any other error', () => {
    expect(describeQdrantError(new Error('Bad Request'))).toBe('Bad Request');
    expect(describeQdrantError(fetchFailed(new Error('no code')))).toBe('fetch failed');
    expect(describeQdrantError('plain string')).toBe('plain string');
  });
});
