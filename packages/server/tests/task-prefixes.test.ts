import { describe, it, expect } from 'vitest';
import { detectQueryType, prefixQuery, prefixPassage, modelFamily } from '../src/task-prefixes.js';

describe('detectQueryType', () => {
  it('detects code queries (function keyword)', () => {
    expect(detectQueryType('function handleAuth() {')).toBe('code2code');
  });

  it('detects code queries (const declaration)', () => {
    expect(detectQueryType('const router = express.Router()')).toBe('code2code');
  });

  it('detects code queries (import statement)', () => {
    expect(detectQueryType('import { useState } from "react"')).toBe('code2code');
  });

  it('detects code queries (arrow function)', () => {
    expect(detectQueryType('users.map(u => u.name)')).toBe('code2code');
  });

  it('detects code queries (def keyword for Python/Ruby)', () => {
    expect(detectQueryType('def authenticate(user, password)')).toBe('code2code');
  });

  it('detects code queries (require)', () => {
    expect(detectQueryType("const fs = require('fs')")).toBe('code2code');
  });

  it('detects question queries (how)', () => {
    expect(detectQueryType('how does authentication work')).toBe('techqa');
  });

  it('detects question queries (what)', () => {
    expect(detectQueryType('what is the middleware chain')).toBe('techqa');
  });

  it('detects question queries (why)', () => {
    expect(detectQueryType('why does the test fail')).toBe('techqa');
  });

  it('detects question queries (question mark)', () => {
    expect(detectQueryType('database connection pooling?')).toBe('techqa');
  });

  it('defaults to nl2code for simple search terms', () => {
    expect(detectQueryType('authentication middleware')).toBe('nl2code');
  });

  it('defaults to nl2code for identifier-style queries', () => {
    expect(detectQueryType('handleUserAuth')).toBe('nl2code');
  });

  it('defaults to nl2code for file path queries', () => {
    expect(detectQueryType('src/auth/middleware.ts')).toBe('nl2code');
  });
});

describe('modelFamily', () => {
  it('maps bge-code-v1 to bge-code', () => {
    expect(modelFamily('bge-code-v1')).toBe('bge-code');
  });

  it('maps Qwen3-Embedding models to qwen (case-insensitive)', () => {
    expect(modelFamily('qwen3-embedding-0.6b')).toBe('qwen');
    expect(modelFamily('Qwen3-Embedding-0.6B')).toBe('qwen');
  });

  it('maps unknown / provider-native models to none', () => {
    expect(modelFamily('bge-m3')).toBe('none');
    expect(modelFamily('text-embedding-3-small')).toBe('none');
    expect(modelFamily('jina-code-embeddings')).toBe('none');
  });
});

describe('prefixQuery', () => {
  it('returns the query unchanged for the none family', () => {
    expect(prefixQuery('authentication middleware', 'none')).toBe('authentication middleware');
    // default family is 'none'
    expect(prefixQuery('authentication middleware')).toBe('authentication middleware');
  });

  it('wraps in the bge-code <instruct>/<query> template with a detected task', () => {
    const result = prefixQuery('authentication middleware', 'bge-code');
    expect(result.startsWith('<instruct>')).toBe(true);
    expect(result).toContain('\n<query>authentication middleware');
    // nl2code task wording — verbatim from the bge-code-v1 model card (CosQA)
    expect(result).toContain(
      'Given a web search query, retrieve relevant code that can help answer the query.'
    );
  });

  it('wraps in the qwen Instruct/Query template with the single qwen instruction', () => {
    const result = prefixQuery('function handleAuth() {', 'qwen');
    expect(result.startsWith('Instruct: ')).toBe(true);
    expect(result).toContain('\nQuery:function handleAuth() {');
    // Qwen3-Embedding has one retrieval instruction for all query types (no period).
    expect(result).toContain(
      'Given a web search query, retrieve relevant passages that answer the query'
    );
  });

  it('uses the bge-code code2code instruction for code-shaped queries', () => {
    const result = prefixQuery('function handleAuth() {', 'bge-code');
    // code2code — verbatim from the bge-code-v1 card (CodeTrans-DL)
    expect(result).toContain('retrieve code that is semantically equivalent to the input code.');
  });

  it('picks the bge-code techqa (StackOverFlow-QA) instruction for questions', () => {
    const result = prefixQuery('how does authentication work', 'bge-code');
    // techqa — verbatim from the bge-code-v1 card (StackOverFlow-QA), NOT the qwen string
    expect(result).toContain(
      'retrieve relevant answers that also consist of a mix of text and code snippets'
    );
    expect(result.endsWith('how does authentication work')).toBe(true);
  });
});

describe('prefixPassage', () => {
  it('returns documents unprefixed for instruction-tuned families', () => {
    // asymmetric retrieval: documents carry no instruction
    expect(prefixPassage('const x = 1;', 'bge-code')).toBe('const x = 1;');
    expect(prefixPassage('const x = 1;', 'qwen')).toBe('const x = 1;');
    expect(prefixPassage('const x = 1;', 'none')).toBe('const x = 1;');
    expect(prefixPassage('const x = 1;')).toBe('const x = 1;');
  });
});
