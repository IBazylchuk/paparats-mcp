import { describe, it, expect, afterAll } from 'vitest';
import { createTreeSitterManager } from '../src/tree-sitter-parser.js';
import type { TreeSitterManager } from '../src/tree-sitter-parser.js';

describe('TreeSitterManager', () => {
  let manager: TreeSitterManager;

  afterAll(() => {
    manager?.close();
  });

  it('initializes and parses TypeScript', async () => {
    manager = await createTreeSitterManager();
    const result = await manager.parseFile('function foo() { return 1; }', 'typescript');
    expect(result).not.toBeNull();
    expect(result!.tree.rootNode.type).toBe('program');
    result!.tree.delete();
  });

  it('parses JavaScript', async () => {
    const result = await manager.parseFile('const x = 42;', 'javascript');
    expect(result).not.toBeNull();
    expect(result!.tree.rootNode.type).toBe('program');
    result!.tree.delete();
  });

  it('parses Python', async () => {
    const result = await manager.parseFile('def greet():\n    pass', 'python');
    expect(result).not.toBeNull();
    expect(result!.tree.rootNode.type).toBe('module');
    result!.tree.delete();
  });

  it('returns null for unsupported language (terraform)', async () => {
    const result = await manager.parseFile('resource "aws_s3" {}', 'terraform');
    expect(result).toBeNull();
  });

  it('returns null for unknown language', async () => {
    const result = await manager.parseFile('hello world', 'brainfuck');
    expect(result).toBeNull();
  });

  it('isAvailable returns correct values', () => {
    expect(manager.isAvailable('typescript')).toBe(true);
    expect(manager.isAvailable('python')).toBe(true);
    expect(manager.isAvailable('go')).toBe(true);
    expect(manager.isAvailable('rust')).toBe(true);
    expect(manager.isAvailable('java')).toBe(true);
    expect(manager.isAvailable('ruby')).toBe(true);
    expect(manager.isAvailable('c')).toBe(true);
    expect(manager.isAvailable('cpp')).toBe(true);
    expect(manager.isAvailable('csharp')).toBe(true);
    expect(manager.isAvailable('tsx')).toBe(true);
    expect(manager.isAvailable('terraform')).toBe(false);
    expect(manager.isAvailable('unknown')).toBe(false);
  });
});
