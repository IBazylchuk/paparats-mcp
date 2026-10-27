import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { PAPARATS_HOME, readProjectsFile, resolveProjectName } from '../projects-yml.js';

/** The block is everything between these lines, markers included; reruns replace it in place. */
export const BLOCK_BEGIN = '<!-- paparats:begin -->';
export const BLOCK_END = '<!-- paparats:end -->';

/** Files agents read for repository instructions, checked in this order. */
export const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** Created when the repository has none of {@link INSTRUCTION_FILES}. */
const DEFAULT_FILE = 'AGENTS.md';

/**
 * The text an agent working in the repository reads: when the index beats grep,
 * when grep beats the index, and which tool answers which question. Short on
 * purpose — it sits in every session's context.
 */
export function renderInstructionsBlock(project: string): string {
  return [
    BLOCK_BEGIN,
    '## Code search (paparats)',
    '',
    `This repository is indexed by the paparats MCP server as project \`${project}\`. Pass \`project: "${project}"\` to stay in it, or \`"all"\` to search every indexed repository.`,
    '',
    '- **`search_code` first** when you know what code does but not what it is called ("where are retries handled", "how is the session token checked"). Include identifiers you already know: chunks that define them rank higher.',
    '- **grep / ripgrep** for exact text: an error message, a config key, every occurrence of a name before a rename. Also for files changed in the last few minutes, which may not be indexed yet.',
    '- Below 33% score a result is a guess: fall back to grep or reading the file.',
    '- `get_chunk` reads around a hit by its `chunk_id`, instead of opening the whole file.',
    '- `find_usages` lists callers and callees of a chunk. Before changing a signature, renaming or deleting, run `change_impact` on the chunk: it lists callers a few steps out and the tests that reach it.',
    '- The call graph links code by name, so dynamic calls (reflection, string dispatch, routes, config) are not in it. Confirm with grep before deleting something that looks unused.',
    BLOCK_END,
  ].join('\n');
}

/**
 * `content` with the paparats block inserted or replaced. An existing block is
 * swapped in place; otherwise the block is appended after one blank line. A
 * begin marker without an end marker is refused rather than guessed at: the
 * text after it may be the user's.
 */
export function upsertBlock(content: string, block: string): string {
  const begin = content.indexOf(BLOCK_BEGIN);
  if (begin !== -1) {
    const end = content.indexOf(BLOCK_END, begin);
    if (end === -1) {
      throw new Error(`found ${BLOCK_BEGIN} without ${BLOCK_END}; fix the file by hand`);
    }
    return content.slice(0, begin) + block + content.slice(end + BLOCK_END.length);
  }
  if (content.trim() === '') return block + '\n';
  return content.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

/** `content` without the paparats block, or null when it has none. */
export function removeBlock(content: string): string | null {
  const begin = content.indexOf(BLOCK_BEGIN);
  if (begin === -1) return null;
  const end = content.indexOf(BLOCK_END, begin);
  if (end === -1) {
    throw new Error(`found ${BLOCK_BEGIN} without ${BLOCK_END}; fix the file by hand`);
  }
  const before = content.slice(0, begin).replace(/\s*$/, '');
  const after = content.slice(end + BLOCK_END.length).replace(/^\s*/, '');
  if (before === '') return after;
  return after === '' ? before + '\n' : before + '\n\n' + after;
}

/**
 * The project name the server knows this directory by: the name of its
 * projects.yml entry when it has one (a `name:` override wins), otherwise the
 * directory basename — the same rule the server applies.
 */
export function detectProjectName(dir: string, home: string = PAPARATS_HOME): string {
  try {
    const entry = readProjectsFile(home).repos.find(
      (r) => r.path !== undefined && path.resolve(r.path) === dir
    );
    if (entry) return resolveProjectName(entry);
  } catch {
    // An unreadable projects.yml only costs the override; the basename still works.
  }
  return path.basename(dir);
}

export interface InstructionsOptions {
  /** Target file(s), relative to the directory. Default: the existing ones, else AGENTS.md. */
  file?: string[];
  project?: string;
  remove?: boolean;
  /** Print the block instead of writing it. */
  print?: boolean;
  paparatsHome?: string;
}

export type InstructionsChange = 'created' | 'updated' | 'unchanged' | 'removed' | 'absent';

export interface InstructionsResult {
  project: string;
  files: Array<{ file: string; change: InstructionsChange }>;
}

export function runInstructions(
  dirArg: string | undefined,
  opts: InstructionsOptions = {}
): InstructionsResult {
  const dir = path.resolve(dirArg ?? process.cwd());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }
  const project = opts.project?.trim() || detectProjectName(dir, opts.paparatsHome);
  const block = renderInstructionsBlock(project);

  if (opts.print) {
    console.log(block);
    return { project, files: [] };
  }

  let targets = opts.file && opts.file.length > 0 ? opts.file : null;
  if (!targets) {
    const existing = INSTRUCTION_FILES.filter((f) => fs.existsSync(path.join(dir, f)));
    targets = existing.length > 0 ? existing : opts.remove ? [] : [DEFAULT_FILE];
  }

  const files: InstructionsResult['files'] = [];
  for (const file of targets) {
    const full = path.resolve(dir, file);
    const exists = fs.existsSync(full);
    const before = exists ? fs.readFileSync(full, 'utf8') : '';

    if (opts.remove) {
      const after = exists ? removeBlock(before) : null;
      if (after === null) {
        files.push({ file, change: 'absent' });
        continue;
      }
      fs.writeFileSync(full, after);
      files.push({ file, change: 'removed' });
      continue;
    }

    const after = upsertBlock(before, block);
    if (after === before) {
      files.push({ file, change: 'unchanged' });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, after);
    files.push({ file, change: exists ? 'updated' : 'created' });
  }
  return { project, files };
}

const CHANGE_TEXT: Record<InstructionsChange, string> = {
  created: 'created with the paparats block',
  updated: 'paparats block written',
  unchanged: 'paparats block already up to date',
  removed: 'paparats block removed',
  absent: 'no paparats block',
};

export const instructionsCommand = new Command('instructions')
  .description(
    'Write a short "when to use paparats, when to use grep" block into the CLAUDE.md / AGENTS.md of a repository'
  )
  .argument('[dir]', 'Repository directory (default: current directory)')
  .option(
    '--file <name>',
    'File to write, relative to the directory; repeat for several. Default: the existing CLAUDE.md and AGENTS.md, or a new AGENTS.md',
    (value: string, prev: string[] = []) => [...prev, value]
  )
  .option('--project <name>', 'Project name the server indexes this repository as')
  .option('--remove', 'Remove the block instead of writing it')
  .option('--print', 'Print the block and write nothing')
  .action((dir: string | undefined, opts: InstructionsOptions) => {
    try {
      const result = runInstructions(dir, opts);
      for (const { file, change } of result.files) {
        console.log(
          change === 'absent'
            ? chalk.dim(`${file}: ${CHANGE_TEXT[change]}`)
            : chalk.green(`✓ ${file}: ${CHANGE_TEXT[change]}`)
        );
      }
      if (!opts.print && !opts.remove) {
        console.log(chalk.dim(`  Project: ${result.project} (override with --project)`));
        if (result.files.every((f) => f.file !== 'CLAUDE.md')) {
          console.log(
            chalk.dim(
              '  Claude Code reads CLAUDE.md: add a line `@AGENTS.md` to it, or rerun with --file CLAUDE.md'
            )
          );
        }
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
