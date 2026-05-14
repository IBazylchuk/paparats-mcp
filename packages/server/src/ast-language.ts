/**
 * Choose the tree-sitter language identifier given the project's logical
 * language (from LANGUAGE_PROFILES) and the file's relative path.
 *
 * `.tsx` and `.jsx` files need the `tsx` grammar — without it, JSX tags parse
 * as bogus type expressions and identifier usages inside JSX (`<Foo prop={x}/>`,
 * `{value}`) are lost. detectLanguageByPath returns 'typescript' for .tsx so we
 * keep LANGUAGE_PROFILES happy and switch grammars here at the AST boundary.
 */
export function resolveAstLanguage(language: string, relPath: string): string {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
    return 'tsx';
  }
  return language;
}
