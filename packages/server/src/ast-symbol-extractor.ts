import { Query } from 'web-tree-sitter';
import type { Node, Tree, Language } from 'web-tree-sitter';
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
function resolveKind(node: Node): ChunkKind {
  let current: Node | null = node.parent;
  // Walk up at most 3 levels to find a recognized node type
  for (let depth = 0; current && depth < 3; depth++) {
    const kind = NODE_TYPE_TO_KIND[current.type];
    if (kind) return kind;
    current = current.parent;
  }
  return 'unknown';
}

/**
 * Node types whose interior is "inside a function body" — anything declared
 * deeper than these is local scope and must NOT be reported as dead code.
 * A symbol is local iff walking up from its declaration we hit one of these
 * before we hit a top-level container.
 */
const FUNCTION_BODY_NODES = new Set([
  // TS/JS
  'function_declaration',
  'function_expression',
  'arrow_function',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
  // Python
  'function_definition',
  'lambda',
  // Go
  'func_literal',
  // 'function_declaration' already covered (Go uses same type)
  // 'method_declaration' — methods on receivers, top-level in Go
  // Rust — function_item is top-level definition; closures are 'closure_expression'
  'closure_expression',
  // Ruby
  'method',
  'singleton_method',
  'lambda',
  'do_block',
  'block',
  // Java — methods can declare locals; method_declaration body is the boundary
  'method_declaration',
  'constructor_declaration',
  // C/C++ — function_definition declares a function, locals live inside its body
  // 'function_definition' already covered
  // C#
  // 'method_declaration' already covered
  'constructor_declaration_csharp',
  'local_function_statement',
]);

/**
 * Returns true iff the captured identifier represents a module-level (or
 * class-level — methods on top-level classes count) declaration.
 *
 * Algorithm: walk up from the identifier. If we encounter a function-body
 * node BEFORE reaching the file root, it's local. The walk skips over the
 * declaration the identifier is the name of (function_declaration's name is
 * an identifier child of function_declaration itself — that's the symbol's
 * own home, not its enclosing scope).
 */
function isTopLevelDeclaration(identifierNode: Node): boolean {
  // The identifier's first ancestor is its own declaration. We need to look
  // ABOVE that. Walk up to find the declaration node, then keep walking from
  // there to the root, checking each ancestor for "is a function body".
  let decl: Node | null = identifierNode.parent;
  for (let depth = 0; decl && depth < 4; depth++) {
    if (NODE_TYPE_TO_KIND[decl.type]) break;
    decl = decl.parent;
  }
  if (!decl) return false;

  // Walk above the declaration. If any ancestor is a function-body node,
  // the symbol lives in that function's scope (local). Otherwise it's
  // module-level (or inside a top-level class/namespace, which is fine —
  // method_definition itself is the declaration we want to keep).
  //
  // Special case: the declaration node IS sometimes `method_definition` (a
  // method on a class). That's the symbol's home, not its scope — keep it.
  let ancestor: Node | null = decl.parent;
  while (ancestor) {
    if (FUNCTION_BODY_NODES.has(ancestor.type)) return false;
    ancestor = ancestor.parent;
  }
  return true;
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
  tree: Tree,
  language: Language,
  chunks: Array<{ startLine: number; endLine: number }>,
  lang: string
): SymbolExtractionResult[] {
  const querySet = LANGUAGE_QUERIES[lang];
  if (!querySet) {
    return chunks.map(() => ({ defines_symbols: [], uses_symbols: [], defined_symbols: [] }));
  }

  let defQuery: Query | null = null;
  let useQuery: Query | null = null;

  try {
    try {
      defQuery = new Query(language, querySet.definitions);
    } catch {
      // Query compilation failed — skip definitions
    }

    try {
      useQuery = new Query(language, querySet.usages);
    } catch {
      // Query compilation failed — skip usages
    }

    // Collect all captures once, sorted by row (tree-sitter returns them in order)
    const defCaptures = defQuery ? defQuery.captures(tree.rootNode) : [];
    const useCaptures = useQuery ? useQuery.captures(tree.rootNode) : [];

    // Two-pointer approach: captures and chunks are both sorted by line number,
    // so we advance pointers instead of scanning all captures for every chunk.
    const results: SymbolExtractionResult[] = [];
    let defIdx = 0;
    let useIdx = 0;

    for (const chunk of chunks) {
      const defines = new Map<string, ChunkKind>();
      const uses = new Set<string>();

      // Advance defIdx past captures before this chunk
      while (
        defIdx < defCaptures.length &&
        defCaptures[defIdx]!.node.startPosition.row < chunk.startLine
      ) {
        defIdx++;
      }
      // Collect def captures within this chunk. Module-level only — locals
      // (vars/functions inside a function body, callback args, hook closures,
      // etc.) are not addressable from other files and reporting them as
      // "dead code" is just scope-blindness. Their dead-or-alive status is
      // determined by the enclosing function, not by cross-file references.
      for (let d = defIdx; d < defCaptures.length; d++) {
        const row = defCaptures[d]!.node.startPosition.row;
        if (row > chunk.endLine) break;
        const captureNode = defCaptures[d]!.node;
        const text = captureNode.text;
        if (isNoise(text) || defines.has(text)) continue;
        if (!isTopLevelDeclaration(captureNode)) continue;
        defines.set(text, resolveKind(captureNode));
      }

      // Advance useIdx past captures before this chunk
      while (
        useIdx < useCaptures.length &&
        useCaptures[useIdx]!.node.startPosition.row < chunk.startLine
      ) {
        useIdx++;
      }
      // Collect use captures within this chunk
      for (let u = useIdx; u < useCaptures.length; u++) {
        const row = useCaptures[u]!.node.startPosition.row;
        if (row > chunk.endLine) break;
        const text = useCaptures[u]!.node.text;
        if (!isNoise(text)) {
          uses.add(text);
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

      results.push({
        defines_symbols: defined_symbols.map((d) => d.name),
        uses_symbols: Array.from(uses),
        defined_symbols,
      });
    }

    return results;
  } finally {
    defQuery?.delete();
    useQuery?.delete();
  }
}
