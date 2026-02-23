import { describe, it, expect } from 'vitest';
import { extractSymbol } from '../src/symbol-extractor.js';

describe('extractSymbol', () => {
  // ── TypeScript / JavaScript ────────────────────────────────────────────

  it('extracts function declaration', () => {
    const result = extractSymbol(
      'function processPayment(amount: number) {\n  // ...\n}',
      'typescript'
    );
    expect(result).toEqual({ name: 'processPayment', kind: 'function' });
  });

  it('extracts async function declaration', () => {
    const result = extractSymbol('async function fetchData() {\n  // ...\n}', 'typescript');
    expect(result).toEqual({ name: 'fetchData', kind: 'function' });
  });

  it('extracts exported function', () => {
    const result = extractSymbol(
      'export function getSupportedLanguages(): string[] {',
      'typescript'
    );
    expect(result).toEqual({ name: 'getSupportedLanguages', kind: 'function' });
  });

  it('extracts arrow function assigned to const', () => {
    const result = extractSymbol('const validate = (input: string) => {', 'typescript');
    expect(result).toEqual({ name: 'validate', kind: 'function' });
  });

  it('extracts async arrow function', () => {
    const result = extractSymbol('export const fetchUser = async (id: string) => {', 'typescript');
    expect(result).toEqual({ name: 'fetchUser', kind: 'function' });
  });

  it('extracts class declaration', () => {
    const result = extractSymbol('export class Indexer {\n  constructor() {}', 'typescript');
    expect(result).toEqual({ name: 'Indexer', kind: 'class' });
  });

  it('extracts abstract class', () => {
    const result = extractSymbol('export abstract class BaseProvider {', 'typescript');
    expect(result).toEqual({ name: 'BaseProvider', kind: 'class' });
  });

  it('extracts interface', () => {
    const result = extractSymbol(
      'export interface SearchResult {\n  project: string;',
      'typescript'
    );
    expect(result).toEqual({ name: 'SearchResult', kind: 'interface' });
  });

  it('extracts type alias', () => {
    const result = extractSymbol('export type ChunkKind = "function" | "class";', 'typescript');
    expect(result).toEqual({ name: 'ChunkKind', kind: 'type' });
  });

  it('extracts enum', () => {
    const result = extractSymbol('enum Status {\n  Active,\n  Inactive\n}', 'typescript');
    expect(result).toEqual({ name: 'Status', kind: 'enum' });
  });

  it('extracts const assignment', () => {
    const result = extractSymbol('export const MAX_RETRIES = 3;', 'typescript');
    expect(result).toEqual({ name: 'MAX_RETRIES', kind: 'constant' });
  });

  it('extracts let variable', () => {
    const result = extractSymbol('let counter = 0;', 'typescript');
    expect(result).toEqual({ name: 'counter', kind: 'variable' });
  });

  it('extracts method (indented)', () => {
    const result = extractSymbol('  async search(query: string) {\n    // ...\n  }', 'typescript');
    expect(result).toEqual({ name: 'search', kind: 'method' });
  });

  it('extracts Express route', () => {
    const result = extractSymbol("app.get('/api/search', async (req, res) => {", 'typescript');
    expect(result).toEqual({ name: '/api/search', kind: 'route' });
  });

  // ── Python ─────────────────────────────────────────────────────────────

  it('extracts Python class', () => {
    const result = extractSymbol('class UserService:\n    def __init__(self):', 'python');
    expect(result).toEqual({ name: 'UserService', kind: 'class' });
  });

  it('extracts Python function', () => {
    const result = extractSymbol('def process_data(data):\n    pass', 'python');
    expect(result).toEqual({ name: 'process_data', kind: 'function' });
  });

  it('extracts Python async function', () => {
    const result = extractSymbol('async def fetch_user(user_id):', 'python');
    expect(result).toEqual({ name: 'fetch_user', kind: 'function' });
  });

  // ── Go ─────────────────────────────────────────────────────────────────

  it('extracts Go struct', () => {
    const result = extractSymbol('type Config struct {\n\tPort int', 'go');
    expect(result).toEqual({ name: 'Config', kind: 'class' });
  });

  it('extracts Go interface', () => {
    const result = extractSymbol(
      'type Reader interface {\n\tRead(p []byte) (n int, err error)',
      'go'
    );
    expect(result).toEqual({ name: 'Reader', kind: 'interface' });
  });

  it('extracts Go function', () => {
    const result = extractSymbol('func NewServer(port int) *Server {', 'go');
    expect(result).toEqual({ name: 'NewServer', kind: 'function' });
  });

  it('extracts Go method', () => {
    const result = extractSymbol('func (s *Server) Start() error {', 'go');
    expect(result).toEqual({ name: 'Start', kind: 'method' });
  });

  // ── Rust ───────────────────────────────────────────────────────────────

  it('extracts Rust struct', () => {
    const result = extractSymbol('pub struct Config {\n    pub port: u16,', 'rust');
    expect(result).toEqual({ name: 'Config', kind: 'class' });
  });

  it('extracts Rust enum', () => {
    const result = extractSymbol('pub enum Status {\n    Active,\n    Inactive,', 'rust');
    expect(result).toEqual({ name: 'Status', kind: 'enum' });
  });

  it('extracts Rust trait', () => {
    const result = extractSymbol('pub trait Handler {\n    fn handle(&self);', 'rust');
    expect(result).toEqual({ name: 'Handler', kind: 'interface' });
  });

  it('extracts Rust function', () => {
    const result = extractSymbol('pub async fn process(data: &[u8]) -> Result<()> {', 'rust');
    expect(result).toEqual({ name: 'process', kind: 'function' });
  });

  it('extracts Rust impl', () => {
    const result = extractSymbol('impl Server {\n    fn new() -> Self {', 'rust');
    expect(result).toEqual({ name: 'Server', kind: 'class' });
  });

  // ── Java ───────────────────────────────────────────────────────────────

  it('extracts Java class', () => {
    const result = extractSymbol(
      'public class UserController {\n    private final UserService service;',
      'java'
    );
    expect(result).toEqual({ name: 'UserController', kind: 'class' });
  });

  it('extracts Java interface', () => {
    const result = extractSymbol(
      'public interface Repository {\n    List<User> findAll();',
      'java'
    );
    expect(result).toEqual({ name: 'Repository', kind: 'interface' });
  });

  it('extracts Java enum', () => {
    const result = extractSymbol('public enum Status {\n    ACTIVE, INACTIVE', 'java');
    expect(result).toEqual({ name: 'Status', kind: 'enum' });
  });

  // ── Ruby ───────────────────────────────────────────────────────────────

  it('extracts Ruby class', () => {
    const result = extractSymbol('class UserService\n  def initialize', 'ruby');
    expect(result).toEqual({ name: 'UserService', kind: 'class' });
  });

  it('extracts Ruby module', () => {
    const result = extractSymbol('module Authentication\n  def self.verify', 'ruby');
    expect(result).toEqual({ name: 'Authentication', kind: 'module' });
  });

  it('extracts Ruby method', () => {
    const result = extractSymbol('  def process_payment(amount)\n    # ...', 'ruby');
    expect(result).toEqual({ name: 'process_payment', kind: 'method' });
  });

  // ── C/C++ ──────────────────────────────────────────────────────────────

  it('extracts C++ class', () => {
    const result = extractSymbol('class Server {\npublic:', 'cpp');
    expect(result).toEqual({ name: 'Server', kind: 'class' });
  });

  it('extracts C++ namespace', () => {
    const result = extractSymbol('namespace http {\n', 'cpp');
    expect(result).toEqual({ name: 'http', kind: 'module' });
  });

  it('extracts C #define', () => {
    const result = extractSymbol('#define MAX_BUFFER_SIZE 1024', 'c');
    expect(result).toEqual({ name: 'MAX_BUFFER_SIZE', kind: 'constant' });
  });

  // ── C# ─────────────────────────────────────────────────────────────────

  it('extracts C# class', () => {
    const result = extractSymbol('public class UserService\n{', 'csharp');
    expect(result).toEqual({ name: 'UserService', kind: 'class' });
  });

  it('extracts C# interface', () => {
    const result = extractSymbol('public interface IRepository\n{', 'csharp');
    expect(result).toEqual({ name: 'IRepository', kind: 'interface' });
  });

  // ── Terraform ──────────────────────────────────────────────────────────

  it('extracts Terraform resource', () => {
    const result = extractSymbol('resource "aws_instance" "web" {\n  ami = "abc"', 'terraform');
    expect(result).toEqual({ name: 'web', kind: 'resource' });
  });

  it('extracts Terraform module', () => {
    const result = extractSymbol('module "vpc" {\n  source = "./modules/vpc"', 'terraform');
    expect(result).toEqual({ name: 'vpc', kind: 'module' });
  });

  it('extracts Terraform variable', () => {
    const result = extractSymbol('variable "region" {\n  type = string', 'terraform');
    expect(result).toEqual({ name: 'region', kind: 'variable' });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('returns null for unknown language', () => {
    const result = extractSymbol('something here', 'cobol');
    expect(result).toBeNull();
  });

  it('returns null for plain text chunk', () => {
    const result = extractSymbol(
      '// Just a comment\n// with some text\nconst result = doSomething();',
      'typescript'
    );
    // Should match const on line 3 (within SCAN_LINES of 5)
    expect(result).toEqual({ name: 'result', kind: 'constant' });
  });

  it('returns null when no symbol found in first 5 lines', () => {
    const result = extractSymbol(
      '// Line 1\n// Line 2\n// Line 3\n// Line 4\n// Line 5\nfunction late() {}',
      'typescript'
    );
    expect(result).toBeNull();
  });

  it('scans up to 5 lines', () => {
    const result = extractSymbol(
      '// Comment\n// Comment\n// Comment\n// Comment\nfunction found() {}',
      'typescript'
    );
    expect(result).toEqual({ name: 'found', kind: 'function' });
  });
});
