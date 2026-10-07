import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeInstallState, writePrivateFile } from '../src/projects-yml.js';

const mode = (p: string) => fs.statSync(p).mode & 0o777;

// POSIX permission bits only; Windows has no equivalent to assert on.
describe.skipIf(process.platform === 'win32')('writePrivateFile', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-private-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('creates the file 0600 and a missing parent directory 0700', () => {
    const file = path.join(base, 'home', '.env');
    writePrivateFile(file, 'QDRANT_API_KEY=secret\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('QDRANT_API_KEY=secret\n');
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
  });

  it('tightens a file an older version left world-readable', () => {
    const file = path.join(base, '.env');
    fs.writeFileSync(file, 'OLD=1\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writePrivateFile(file, 'NEW=1\n');
    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('NEW=1\n');
  });

  it('writes install.json (which can carry the Qdrant key) owner-only', () => {
    const home = path.join(base, 'paparats');
    writeInstallState({ embedMode: 'docker', qdrantApiKey: 'secret' }, home);
    expect(mode(path.join(home, 'install.json'))).toBe(0o600);
    expect(mode(home)).toBe(0o700);
  });
});
