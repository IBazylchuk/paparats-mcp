import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { localUrls, parseDotenv } from '../src/local-urls.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-urls-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('localUrls', () => {
  it('defaults to the ports the compose publishes', () => {
    expect(localUrls({}, home)).toEqual({
      server: 'http://localhost:9876',
      indexer: 'http://localhost:9877',
      qdrant: 'http://localhost:6333',
    });
  });

  it('follows ports changed in ~/.paparats/.env, as the compose does', () => {
    fs.writeFileSync(
      path.join(home, '.env'),
      '# ports\nPAPARATS_PORT=19876\nINDEXER_PORT="19877"\n'
    );
    const urls = localUrls({}, home);
    expect(urls.server).toBe('http://localhost:19876');
    expect(urls.indexer).toBe('http://localhost:19877');
    expect(urls.qdrant).toBe('http://localhost:6333');
  });

  it('takes whole URLs from the environment over the file', () => {
    fs.writeFileSync(path.join(home, '.env'), 'PAPARATS_PORT=19876\n');
    const urls = localUrls(
      { PAPARATS_SERVER_URL: 'http://paparats:9876', QDRANT_PORT: '16333' },
      home
    );
    expect(urls.server).toBe('http://paparats:9876');
    expect(urls.qdrant).toBe('http://localhost:16333');
  });
});

describe('parseDotenv', () => {
  it('reads KEY=value lines and unquotes values', () => {
    expect(parseDotenv("A=1\n# B=2\n\nC='three'\nnot a line\n")).toEqual({ A: '1', C: 'three' });
  });
});
