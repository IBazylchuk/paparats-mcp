import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BLOCK_BEGIN,
  BLOCK_END,
  detectProjectName,
  removeBlock,
  renderInstructionsBlock,
  runInstructions,
  upsertBlock,
} from '../src/commands/instructions.js';

let tmp: string;
let repo: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-instructions-'));
  repo = path.join(tmp, 'billing');
  home = path.join(tmp, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');
const write = (f: string, s: string) => fs.writeFileSync(path.join(repo, f), s);

describe('renderInstructionsBlock', () => {
  it('names the project and the tools, between the markers', () => {
    const block = renderInstructionsBlock('billing');
    expect(block.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
    expect(block).toContain('project: "billing"');
    for (const tool of ['search_code', 'get_chunk', 'find_usages', 'change_impact', 'grep']) {
      expect(block).toContain(tool);
    }
  });
});

describe('upsertBlock / removeBlock', () => {
  const block = `${BLOCK_BEGIN}\nnew\n${BLOCK_END}`;

  it('appends after one blank line, keeping the existing text', () => {
    expect(upsertBlock('# Repo\n\nRules.\n\n\n', block)).toBe(`# Repo\n\nRules.\n\n${block}\n`);
    expect(upsertBlock('', block)).toBe(`${block}\n`);
  });

  it('replaces an existing block in place', () => {
    const before = `# Repo\n\n${BLOCK_BEGIN}\nold\n${BLOCK_END}\n\n## After\n`;
    expect(upsertBlock(before, block)).toBe(`# Repo\n\n${block}\n\n## After\n`);
  });

  it('refuses a begin marker without an end marker', () => {
    expect(() => upsertBlock(`${BLOCK_BEGIN}\nmine\n`, block)).toThrow(/without/);
    expect(() => removeBlock(`${BLOCK_BEGIN}\nmine\n`)).toThrow(/without/);
  });

  it('removes the block and the blank lines it added', () => {
    const withBlock = upsertBlock('# Repo\n\nRules.\n', block);
    expect(removeBlock(withBlock)).toBe('# Repo\n\nRules.\n');
    expect(removeBlock(`# A\n\n${block}\n\n# B\n`)).toBe('# A\n\n# B\n');
    expect(removeBlock('# Repo\n')).toBeNull();
  });
});

describe('detectProjectName', () => {
  it('uses the projects.yml name for a registered path', () => {
    fs.writeFileSync(
      path.join(home, 'projects.yml'),
      `repos:\n  - path: ${repo}\n    name: payments\n`
    );
    expect(detectProjectName(repo, home)).toBe('payments');
  });

  it('falls back to the directory basename', () => {
    expect(detectProjectName(repo, home)).toBe('billing');
  });
});

describe('runInstructions', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates AGENTS.md when the repository has no instruction file', () => {
    const res = runInstructions(repo, { paparatsHome: home });
    expect(res.files).toEqual([{ file: 'AGENTS.md', change: 'created' }]);
    expect(read('AGENTS.md')).toBe(renderInstructionsBlock('billing') + '\n');
  });

  it('writes every existing instruction file and is idempotent', () => {
    write('CLAUDE.md', '# Claude\n');
    write('AGENTS.md', '# Agents\n');
    expect(runInstructions(repo, { paparatsHome: home }).files).toEqual([
      { file: 'CLAUDE.md', change: 'updated' },
      { file: 'AGENTS.md', change: 'updated' },
    ]);
    const once = read('CLAUDE.md');
    expect(runInstructions(repo, { paparatsHome: home }).files.map((f) => f.change)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect(read('CLAUDE.md')).toBe(once);
    expect(once.startsWith('# Claude\n\n' + BLOCK_BEGIN)).toBe(true);
  });

  it('writes only the files asked for, with the project given', () => {
    write('AGENTS.md', '# Agents\n');
    const res = runInstructions(repo, {
      paparatsHome: home,
      file: ['CLAUDE.md'],
      project: 'payments',
    });
    expect(res.files).toEqual([{ file: 'CLAUDE.md', change: 'created' }]);
    expect(read('CLAUDE.md')).toContain('project: "payments"');
    expect(read('AGENTS.md')).toBe('# Agents\n');
  });

  it('removes the block and leaves files without one alone', () => {
    write('CLAUDE.md', '# Claude\n');
    write('AGENTS.md', '# Agents\n');
    runInstructions(repo, { paparatsHome: home, file: ['CLAUDE.md'] });
    const res = runInstructions(repo, { paparatsHome: home, remove: true });
    expect(res.files).toEqual([
      { file: 'CLAUDE.md', change: 'removed' },
      { file: 'AGENTS.md', change: 'absent' },
    ]);
    expect(read('CLAUDE.md')).toBe('# Claude\n');
  });

  it('creates nothing when removing from a repository without instruction files', () => {
    expect(runInstructions(repo, { paparatsHome: home, remove: true }).files).toEqual([]);
    expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
  });

  it('prints without writing', () => {
    const res = runInstructions(repo, { paparatsHome: home, print: true });
    expect(res.files).toEqual([]);
    expect(fs.readdirSync(repo)).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(renderInstructionsBlock('billing'));
  });

  it('rejects a missing directory', () => {
    expect(() => runInstructions(path.join(tmp, 'nope'), { paparatsHome: home })).toThrow(
      /Not a directory/
    );
  });
});
