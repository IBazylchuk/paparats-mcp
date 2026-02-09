import { describe, it, expect } from 'vitest';
import {
  detectQueryType,
  prefixQuery,
  prefixPassage,
  getQueryPrefix,
  getPassagePrefix,
} from '../src/task-prefixes.js';

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

describe('prefixQuery', () => {
  it('adds nl2code prefix for search terms', () => {
    const result = prefixQuery('authentication middleware');
    expect(result).toContain('Find the most relevant code snippet');
    expect(result.endsWith('authentication middleware')).toBe(true);
  });

  it('adds code2code prefix for code input', () => {
    const result = prefixQuery('function handleAuth() {');
    expect(result).toContain('Find an equivalent code snippet');
    expect(result.endsWith('function handleAuth() {')).toBe(true);
  });

  it('adds techqa prefix for questions', () => {
    const result = prefixQuery('how does authentication work');
    expect(result).toContain('Find the most relevant technical answer');
    expect(result.endsWith('how does authentication work')).toBe(true);
  });
});

describe('prefixPassage', () => {
  it('adds passage prefix to code chunk', () => {
    const result = prefixPassage('const x = 1;');
    expect(result).toContain('Candidate code snippet:');
    expect(result.endsWith('const x = 1;')).toBe(true);
  });
});

describe('getQueryPrefix / getPassagePrefix', () => {
  it('returns non-empty query prefix for all types', () => {
    expect(getQueryPrefix('nl2code').length).toBeGreaterThan(0);
    expect(getQueryPrefix('code2code').length).toBeGreaterThan(0);
    expect(getQueryPrefix('techqa').length).toBeGreaterThan(0);
  });

  it('returns non-empty passage prefix', () => {
    expect(getPassagePrefix().length).toBeGreaterThan(0);
  });
});
