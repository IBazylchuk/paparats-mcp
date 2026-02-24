import type Parser from 'web-tree-sitter';
import { LANGUAGE_QUERIES } from './ast-queries.js';
import type { ChunkKind } from './types.js';

export interface DefinedSymbol {
  name: string;
  kind: ChunkKind;
}

export interface SymbolExtractionResult {
  defines_symbols: string[];
  uses_symbols: string[];
  defined_symbols: DefinedSymbol[];
}

/** Map tree-sitter parent node type → ChunkKind */
const NODE_TYPE_TO_KIND: Record<string, ChunkKind> = {
  // TypeScript / JavaScript
  function_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  lexical_declaration: 'variable',
  variable_declarator: 'variable',
  method_definition: 'method',
  // Python
  function_definition: 'function',
  class_definition: 'class',
  assignment: 'variable',
  // Go
  // function_declaration: already mapped
  method_declaration: 'method',
  type_spec: 'type',
  // Rust
  function_item: 'function',
  struct_item: 'class',
  enum_item: 'enum',
  trait_item: 'interface',
  impl_item: 'class',
  type_item: 'type',
  const_item: 'constant',
  // Java
  // class_declaration: already mapped
  // interface_declaration: already mapped
  // method_declaration: already mapped (Go takes precedence, same value 'method')
  // Ruby
  class: 'class',
  module: 'module',
  method: 'method',
  // C/C++
  // function_definition: already mapped (Python takes precedence, same value 'function')
  struct_specifier: 'class',
  enum_specifier: 'enum',
  class_specifier: 'class',
  // C#
  struct_declaration: 'class',
};

/** Keywords and noise tokens to filter out of symbol lists */
const NOISE_KEYWORDS = new Set([
  'this',
  'self',
  'null',
  'nil',
  'None',
  'true',
  'false',
  'undefined',
  'void',
  'int',
  'float',
  'double',
  'bool',
  'boolean',
  'string',
  'String',
  'number',
  'char',
  'byte',
  'long',
  'short',
  'var',
  'let',
  'const',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'delete',
  'throw',
  'try',
  'catch',
  'finally',
  'class',
  'struct',
  'enum',
  'interface',
  'type',
  'import',
  'export',
  'from',
  'as',
  'async',
  'await',
  'yield',
  'static',
  'public',
  'private',
  'protected',
  'override',
  'abstract',
  'final',
  'virtual',
  'super',
  'extends',
  'implements',
  'package',
  'module',
  'require',
  'fn',
  'func',
  'def',
  'lambda',
  'println',
  'printf',
  'print',
  'fmt',
  'log',
  'console',
  'main',
  'init',
  'err',
  'error',
  'ok',
  'Ok',
  'Err',
  'Some',
  'Object',
  'Array',
  'Map',
  'Set',
  'List',
  'Dict',
  'Tuple',
]);

function isNoise(symbol: string): boolean {
  return symbol.length < 2 || NOISE_KEYWORDS.has(symbol);
}

/**
 * Resolve ChunkKind from a tree-sitter capture node by walking up to find a known parent type.
 */
function resolveKind(node: Parser.SyntaxNode): ChunkKind {
  let current: Parser.SyntaxNode | null = node.parent;
  // Walk up at most 3 levels to find a recognized node type
  for (let depth = 0; current && depth < 3; depth++) {
    const kind = NODE_TYPE_TO_KIND[current.type];
    if (kind) return kind;
    current = current.parent;
  }
  return 'unknown';
}

/**
 * Extract defines_symbols, uses_symbols, and defined_symbols (with kind) for each chunk
 * from a parsed AST tree.
 *
 * @param tree - Parsed tree-sitter tree
 * @param language - tree-sitter Language object (for creating queries)
 * @param chunks - Array of chunk ranges (0-indexed startLine/endLine)
 * @param lang - Language identifier (e.g. 'typescript', 'python')
 * @returns Array of SymbolExtractionResult parallel to chunks
 */
export function extractSymbolsForChunks(
  tree: Parser.Tree,
  language: Parser.Language,
  chunks: Array<{ startLine: number; endLine: number }>,
  lang: string
): SymbolExtractionResult[] {
  const querySet = LANGUAGE_QUERIES[lang];
  if (!querySet) {
    return chunks.map(() => ({ defines_symbols: [], uses_symbols: [], defined_symbols: [] }));
  }

  let defQuery: Parser.Query | null = null;
  let useQuery: Parser.Query | null = null;

  try {
    try {
      defQuery = language.query(querySet.definitions);
    } catch {
      // Query compilation failed — skip definitions
    }

    try {
      useQuery = language.query(querySet.usages);
    } catch {
      // Query compilation failed — skip usages
    }

    // Collect all captures once (faster than per-chunk queries)
    const defCaptures = defQuery ? defQuery.captures(tree.rootNode) : [];
    const useCaptures = useQuery ? useQuery.captures(tree.rootNode) : [];

    return chunks.map((chunk) => {
      const defines = new Map<string, ChunkKind>();
      const uses = new Set<string>();

      for (const capture of defCaptures) {
        const row = capture.node.startPosition.row;
        if (row >= chunk.startLine && row <= chunk.endLine) {
          const text = capture.node.text;
          if (!isNoise(text) && !defines.has(text)) {
            defines.set(text, resolveKind(capture.node));
          }
        }
      }

      for (const capture of useCaptures) {
        const row = capture.node.startPosition.row;
        if (row >= chunk.startLine && row <= chunk.endLine) {
          const text = capture.node.text;
          if (!isNoise(text)) {
            uses.add(text);
          }
        }
      }

      // Remove self-references: if a symbol is both defined and used in the same chunk,
      // remove it from uses (it's likely a recursive call or type annotation on its own definition)
      for (const sym of defines.keys()) {
        uses.delete(sym);
      }

      const defined_symbols: DefinedSymbol[] = Array.from(defines.entries()).map(
        ([name, kind]) => ({
          name,
          kind,
        })
      );

      return {
        defines_symbols: defined_symbols.map((d) => d.name),
        uses_symbols: Array.from(uses),
        defined_symbols,
      };
    });
  } finally {
    defQuery?.delete();
    useQuery?.delete();
  }
}
