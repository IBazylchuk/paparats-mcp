/**
 * Tree-sitter S-expression query patterns for extracting symbol definitions and usages.
 * Each language has `definitions` and `usages` patterns with `@definition` / `@usage` captures.
 */

export interface LanguageQuerySet {
  definitions: string;
  usages: string;
}

// ── TypeScript / JavaScript / TSX ─────────────────────────────────────────

const typescriptDefinitions = `
  (function_declaration name: (identifier) @definition)
  (class_declaration name: (type_identifier) @definition)
  (interface_declaration name: (type_identifier) @definition)
  (type_alias_declaration name: (type_identifier) @definition)
  (enum_declaration name: (identifier) @definition)
  (lexical_declaration (variable_declarator name: (identifier) @definition))
  (method_definition name: (property_identifier) @definition)
`;

const typescriptUsages = `
  (call_expression function: (identifier) @usage)
  (call_expression function: (member_expression property: (property_identifier) @usage))
  (new_expression constructor: (identifier) @usage)
  (type_identifier) @usage
`;

// ── Python ────────────────────────────────────────────────────────────────

const pythonDefinitions = `
  (function_definition name: (identifier) @definition)
  (class_definition name: (identifier) @definition)
  (assignment left: (identifier) @definition)
`;

const pythonUsages = `
  (call function: (identifier) @usage)
  (call function: (attribute attribute: (identifier) @usage))
  (import_from_statement name: (dotted_name (identifier) @usage))
`;

// ── Go ────────────────────────────────────────────────────────────────────

const goDefinitions = `
  (function_declaration name: (identifier) @definition)
  (method_declaration name: (field_identifier) @definition)
  (type_spec name: (type_identifier) @definition)
`;

const goUsages = `
  (call_expression function: (identifier) @usage)
  (call_expression function: (selector_expression field: (field_identifier) @usage))
  (type_identifier) @usage
`;

// ── Rust ──────────────────────────────────────────────────────────────────

const rustDefinitions = `
  (function_item name: (identifier) @definition)
  (struct_item name: (type_identifier) @definition)
  (enum_item name: (type_identifier) @definition)
  (trait_item name: (type_identifier) @definition)
  (impl_item trait: (type_identifier) @definition)
  (type_item name: (type_identifier) @definition)
  (const_item name: (identifier) @definition)
`;

const rustUsages = `
  (call_expression function: (identifier) @usage)
  (call_expression function: (field_expression field: (field_identifier) @usage))
  (type_identifier) @usage
  (use_declaration argument: (scoped_identifier name: (identifier) @usage))
`;

// ── Java ──────────────────────────────────────────────────────────────────

const javaDefinitions = `
  (class_declaration name: (identifier) @definition)
  (interface_declaration name: (identifier) @definition)
  (method_declaration name: (identifier) @definition)
`;

const javaUsages = `
  (method_invocation name: (identifier) @usage)
  (object_creation_expression type: (type_identifier) @usage)
  (type_identifier) @usage
`;

// ── Ruby ──────────────────────────────────────────────────────────────────

const rubyDefinitions = `
  (class name: (constant) @definition)
  (module name: (constant) @definition)
  (method name: (identifier) @definition)
`;

const rubyUsages = `
  (call method: (identifier) @usage)
  (constant) @usage
`;

// ── C ─────────────────────────────────────────────────────────────────────

const cDefinitions = `
  (function_definition declarator: (function_declarator declarator: (identifier) @definition))
  (struct_specifier name: (type_identifier) @definition)
  (enum_specifier name: (type_identifier) @definition)
`;

const cUsages = `
  (call_expression function: (identifier) @usage)
  (type_identifier) @usage
`;

// ── C++ ───────────────────────────────────────────────────────────────────

const cppDefinitions = `
  (function_definition declarator: (function_declarator declarator: (identifier) @definition))
  (class_specifier name: (type_identifier) @definition)
  (struct_specifier name: (type_identifier) @definition)
  (enum_specifier name: (type_identifier) @definition)
`;

const cppUsages = `
  (call_expression function: (identifier) @usage)
  (call_expression function: (field_expression field: (field_identifier) @usage))
  (type_identifier) @usage
`;

// ── C# ────────────────────────────────────────────────────────────────────

const csharpDefinitions = `
  (class_declaration name: (identifier) @definition)
  (interface_declaration name: (identifier) @definition)
  (method_declaration name: (identifier) @definition)
  (struct_declaration name: (identifier) @definition)
`;

const csharpUsages = `
  (invocation_expression function: (identifier) @usage)
  (invocation_expression function: (member_access_expression name: (identifier) @usage))
  (object_creation_expression type: (identifier) @usage)
  (variable_declaration type: (identifier) @usage)
`;

// ── Queries map ───────────────────────────────────────────────────────────

export const LANGUAGE_QUERIES: Record<string, LanguageQuerySet> = {
  typescript: { definitions: typescriptDefinitions, usages: typescriptUsages },
  javascript: { definitions: typescriptDefinitions, usages: typescriptUsages },
  tsx: { definitions: typescriptDefinitions, usages: typescriptUsages },
  python: { definitions: pythonDefinitions, usages: pythonUsages },
  go: { definitions: goDefinitions, usages: goUsages },
  rust: { definitions: rustDefinitions, usages: rustUsages },
  java: { definitions: javaDefinitions, usages: javaUsages },
  ruby: { definitions: rubyDefinitions, usages: rubyUsages },
  c: { definitions: cDefinitions, usages: cUsages },
  cpp: { definitions: cppDefinitions, usages: cppUsages },
  csharp: { definitions: csharpDefinitions, usages: csharpUsages },
};
