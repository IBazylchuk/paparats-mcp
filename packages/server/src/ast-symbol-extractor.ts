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
 * Tree-sitter node types that introduce a "function-like scope" — anything
 * declared inside one of these (apart from the declaration the node itself
 * names) is local and must not appear in defines_symbols. Local symbols
 * aren't addressable from other chunks and leaking them poisons cross-chunk
 * reference analysis.
 *
 * Class / module / interface / namespace / impl / struct bodies are
 * intentionally NOT in any of these sets: methods declared inside them are
 * top-level in our model and stay in the graph.
 *
 * Per-language because different grammars reuse the same node names for
 * unrelated concepts. Python's `block` is the body of any compound
 * statement (class OR function); Ruby's `block` is a brace-syntax call
 * argument. Mixing the two breaks methods on Python classes.
 */
const FUNCTION_LIKE_SCOPE_NODES_PER_LANG: Record<string, Set<string>> = {
  typescript: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function',
    'generator_function_declaration',
    'method_definition',
  ]),
  tsx: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function',
    'generator_function_declaration',
    'method_definition',
  ]),
  javascript: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function',
    'generator_function_declaration',
    'method_definition',
  ]),
  python: new Set(['function_definition', 'lambda']),
  go: new Set(['function_declaration', 'func_literal', 'method_declaration']),
  rust: new Set(['function_item', 'closure_expression']),
  ruby: new Set(['method', 'singleton_method', 'do_block', 'block']),
  java: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
  c: new Set(['function_definition']),
  cpp: new Set(['function_definition', 'lambda_expression']),
  csharp: new Set([
    'method_declaration',
    'constructor_declaration',
    'local_function_statement',
    'lambda_expression',
    'anonymous_method_expression',
  ]),
};

/**
 * Returns true iff the captured identifier represents a module-level or
 * class-member declaration (and so may legitimately participate in the
 * cross-chunk symbol graph). Returns false for symbols introduced inside a
 * function body, lambda, or block — those are local-scope and not visible
 * to other chunks.
 *
 * Algorithm:
 *   1. Walk up from the identifier. The first function-like-scope ancestor
 *      we encounter is the symbol's OWN home (e.g. the `function_definition`
 *      that the identifier names). Skip past it.
 *   2. Continue walking. If we encounter a SECOND function-like-scope
 *      ancestor before reaching the file root, this declaration lives
 *      inside another function — i.e. it's a local. Return false.
 *   3. Otherwise return true.
 *
 * Edge case: variable declarations (e.g. TS `lexical_declaration`,
 * Python `assignment`) are not themselves function-like scopes, so step 1
 * doesn't consume anything for them — the very first function-like
 * ancestor already disqualifies them.
 */
function isTopLevelDeclaration(identifierNode: Node, scopeNodes: Set<string>): boolean {
  let ancestor: Node | null = identifierNode.parent;
  let seenSelfScope = false;
  // For declarations whose own type is a function-like scope (functions,
  // methods, lambdas, …) we need to consume that one before we start
  // counting enclosing scopes. Detect this by looking up the identifier's
  // ancestor chain for a NODE_TYPE_TO_KIND match — if that match is
  // function-like, the first function-like-scope hit is the symbol's home.
  let decl: Node | null = identifierNode.parent;
  for (let depth = 0; decl && depth < 4; depth++) {
    if (NODE_TYPE_TO_KIND[decl.type]) break;
    decl = decl.parent;
  }
  const declIsFunctionLike = decl !== null && scopeNodes.has(decl.type);

  while (ancestor) {
    if (scopeNodes.has(ancestor.type)) {
      if (declIsFunctionLike && !seenSelfScope) {
        seenSelfScope = true;
      } else {
        return false;
      }
    }
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
  // Empty set = no scope filtering (legitimate for languages we haven't
  // mapped yet — better to over-emit than to silently drop top-level decls).
  const scopeNodes = FUNCTION_LIKE_SCOPE_NODES_PER_LANG[lang] ?? new Set<string>();

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
        if (!isTopLevelDeclaration(captureNode, scopeNodes)) continue;
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
