import { Command } from 'commander';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { input, select, confirm, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  CONFIG_FILE,
  SUPPORTED_LANGUAGES,
  detectLanguage,
  writeConfig,
  type PaparatsConfig,
  type SupportedLanguage,
} from '../config.js';
import { upsertMcpServer } from './install.js';
import {
  LSP_CONFIGS,
  buildCclspConfig,
  CCLSP_CONFIG_RELATIVE,
  checkLspInstalled,
  installLspServer,
  getCclspConfigPath,
  type LspInstallerDeps,
} from '../lsp-installers.js';
import ora from 'ora';

/**
 * Language-specific default exclude patterns (bare format).
 * Best practices and language-specific build/cache artifacts.
 */
const LANGUAGE_EXCLUDE_DEFAULTS: Record<string, string[]> = {
  ruby: [
    'vendor',
    'tmp',
    'log',
    'spec',
    'test',
    'node_modules',
    '.bundle',
    'coverage',
    'public/packs',
    'public/assets',
    'storage',
    '.byebug_history',
    'sig',
    'sorbet',
    '**/*.rbi',
  ],
  typescript: [
    'node_modules',
    'dist',
    '.next',
    'coverage',
    'build',
    '.turbo',
    'out',
    '.cache',
    '.vercel',
    '.swc',
    '*.tsbuildinfo',
  ],
  javascript: [
    'node_modules',
    'dist',
    'coverage',
    'build',
    '.cache',
    '.parcel-cache',
    'out',
    '.nuxt',
    '.output',
  ],
  python: [
    'venv',
    '__pycache__',
    '.venv',
    '.mypy_cache',
    '*.egg-info',
    '.pytest_cache',
    '.tox',
    '.coverage',
    'htmlcov',
    'dist',
    'build',
    '.ruff_cache',
    '.pytype',
  ],
  go: ['vendor', 'bin', '.idea', '*.test', '*.out'],
  rust: ['target', 'Cargo.lock', '**/*.rs.bk', '.cargo'],
  java: [
    'build',
    '.gradle',
    'target',
    'bin',
    '.idea',
    '.classpath',
    '.project',
    '.settings',
    '*.class',
    '*.jar',
    '*.war',
  ],
  terraform: [
    '.terraform',
    '*.tfstate',
    '*.tfstate.backup',
    '.terraform.lock.hcl',
    'crash.log',
    'override.tf',
    'override.tf.json',
  ],
  c: ['build', 'cmake-build-*', '*.o', '*.so', '*.a', '*.exe', '*.out', 'compile_commands.json'],
  cpp: [
    'build',
    'cmake-build-*',
    '*.o',
    '*.so',
    '*.a',
    '*.exe',
    '*.out',
    'compile_commands.json',
    '.ccls-cache',
    '.clangd',
  ],
  csharp: ['bin', 'obj', '.vs', '*.user', '*.suo', 'packages', '.vscode', '*.cache'],
  php: [
    'vendor',
    'node_modules',
    '.phpunit.cache',
    'storage/framework/cache',
    'storage/logs',
    'bootstrap/cache',
    '.env',
  ],
  elixir: ['_build', 'deps', '.elixir_ls', 'cover', 'doc', '*.beam', '.fetch'],
  scala: ['target', '.bsp', '.metals', '.bloop', 'project/target', 'project/project'],
  kotlin: ['build', '.gradle', '.idea', '*.iml', 'out', 'bin'],
  swift: ['.build', '.swiftpm', 'DerivedData', '*.xcodeproj', '*.xcworkspace', 'Pods'],
};

const COMMON_EXCLUDE = ['.git'];

function getDefaultExcludeForLanguages(languages: string[]): string[] {
  const merged = new Set<string>(COMMON_EXCLUDE);
  for (const lang of languages) {
    const excludes = LANGUAGE_EXCLUDE_DEFAULTS[lang] ?? LANGUAGE_EXCLUDE_DEFAULTS.typescript ?? [];
    excludes.forEach((e) => merged.add(e));
  }
  return Array.from(merged);
}

export function validateGroupName(value: string): true | string {
  const trimmed = value.trim();
  if (!trimmed) return 'Group name is required';
  if (!/^[a-z0-9-_]+$/i.test(trimmed)) {
    return 'Group name can only contain letters, numbers, dashes, and underscores';
  }
  return true;
}

export function appendToGitignore(gitignorePath: string): void {
  const content = fs.readFileSync(gitignorePath, 'utf8');
  const needsLeadingNewline = content.length > 0 && !content.endsWith('\n');
  const entry = needsLeadingNewline ? `\n${CONFIG_FILE}\n` : `${CONFIG_FILE}\n`;
  fs.appendFileSync(gitignorePath, entry);
}

export interface InitOptions {
  force?: boolean;
  group?: string;
  language?: string;
  nonInteractive?: boolean;
  skipCclsp?: boolean;
}

export interface InitDeps {
  promptGroup?: (defaultGroup: string) => Promise<string>;
  promptLanguage?: (detected: SupportedLanguage | null) => Promise<string | string[]>;
  promptAddPaths?: () => Promise<boolean>;
  promptPaths?: (dirs: string[]) => Promise<string[] | undefined>;
  promptAddExclude?: () => Promise<boolean>;
  promptConfigureEmbeddings?: () => Promise<boolean>;
  promptEmbeddingsProvider?: () => Promise<'ollama' | 'openai'>;
  promptEmbeddingsModel?: (provider: string) => Promise<string>;
  promptGitignore?: () => Promise<boolean>;
  promptSetupCclsp?: () => Promise<boolean>;
  lspDeps?: LspInstallerDeps;
}

export async function runInit(
  projectDir: string,
  opts: InitOptions,
  deps?: InitDeps
): Promise<void> {
  const configPath = path.join(projectDir, CONFIG_FILE);

  if (fs.existsSync(configPath)) {
    if (!opts.force) {
      throw new Error(`${CONFIG_FILE} already exists. Use --force to overwrite.`);
    }
    console.log(chalk.yellow(`Warning: ${CONFIG_FILE} exists and will be overwritten`));
  }

  const skipPrompts = opts.nonInteractive ?? false;
  const defaultGroup = path.basename(projectDir);

  console.log(chalk.bold('\npaparats init\n'));

  let group: string;
  if (opts.group) {
    const validation = validateGroupName(opts.group);
    if (validation !== true) throw new Error(validation);
    group = opts.group.trim();
  } else if (skipPrompts) {
    group = defaultGroup;
  } else if (deps?.promptGroup) {
    group = await deps.promptGroup(defaultGroup);
  } else {
    group = await input({
      message: 'Group name (projects in the same group share a search index):',
      default: defaultGroup,
      validate: validateGroupName,
    });
  }

  const detected = detectLanguage(projectDir);

  let language: string | string[];
  if (opts.language) {
    const lang = opts.language;
    if (!SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) {
      throw new Error(
        `Unsupported language '${lang}'. Supported: ${SUPPORTED_LANGUAGES.join(', ')}`
      );
    }
    language = lang;
  } else if (skipPrompts) {
    language = detected ?? 'typescript';
  } else if (deps?.promptLanguage) {
    language = await deps.promptLanguage(detected);
  } else {
    const multi = await confirm({
      message: 'Is this a multi-language project?',
      default: false,
    });
    if (multi) {
      language = await checkbox({
        message: 'Select all languages:',
        choices: SUPPORTED_LANGUAGES.map((l) => ({ name: l, value: l })),
        validate: (choices: readonly unknown[]) =>
          choices.length > 0 ? true : 'Select at least one language',
      });
    } else {
      language = await select({
        message: 'Primary language:',
        choices: SUPPORTED_LANGUAGES.map((l) => ({
          name: l === detected ? `${l} (detected)` : l,
          value: l,
        })),
        default: detected ?? 'typescript',
      });
    }
  }

  let paths: string[] | undefined;
  let dirs: string[] = [];

  if (!skipPrompts) {
    try {
      dirs = fs
        .readdirSync(projectDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => d.name);
    } catch {
      console.error(chalk.yellow('Warning: Could not read directory contents'));
    }

    const addPaths =
      dirs.length > 0 &&
      (deps?.promptAddPaths
        ? await deps.promptAddPaths()
        : await confirm({
            message: 'Specify custom paths to index? (default: entire project)',
            default: false,
          }));

    if (addPaths && dirs.length > 0) {
      if (deps?.promptPaths) {
        paths = await deps.promptPaths(dirs);
      } else {
        const selected = await checkbox({
          message: 'Select directories to index:',
          choices: dirs.map((d) => ({ name: d, value: d + '/' })),
        });
        paths = selected.length > 0 ? selected : undefined;
      }
    }
  }

  const languagesForExclude = Array.isArray(language) ? language : [language];
  const defaultExclude = getDefaultExcludeForLanguages(languagesForExclude);

  let exclude: string[] | undefined;
  if (skipPrompts) {
    exclude = defaultExclude;
  } else if (deps?.promptAddExclude) {
    const add = await deps.promptAddExclude();
    exclude = add ? defaultExclude : undefined;
  } else {
    const addExclude = await confirm({
      message: 'Add common exclusions for your language(s)?',
      default: true,
    });
    exclude = addExclude ? defaultExclude : undefined;
  }

  let embeddings: PaparatsConfig['embeddings'] | undefined;
  if (!skipPrompts) {
    const configureEmbeddings =
      deps?.promptConfigureEmbeddings ??
      (() =>
        confirm({
          message: 'Configure embeddings provider?',
          default: false,
        }));

    const shouldConfigure = await configureEmbeddings();

    if (shouldConfigure) {
      const provider = (
        deps?.promptEmbeddingsProvider
          ? await deps.promptEmbeddingsProvider()
          : await select({
              message: 'Embeddings provider:',
              choices: [
                { name: 'Ollama (local, free)', value: 'ollama' },
                { name: 'OpenAI (cloud, paid)', value: 'openai' },
              ],
              default: 'ollama',
            })
      ) as 'ollama' | 'openai';

      const defaultModel =
        provider === 'ollama' ? 'jina-code-embeddings' : 'text-embedding-3-small';
      const model = deps?.promptEmbeddingsModel
        ? await deps.promptEmbeddingsModel(provider)
        : await input({
            message: 'Model name:',
            default: defaultModel,
          });

      embeddings = { provider, model };
    }
  }

  const indexing: PaparatsConfig['indexing'] = {
    ...(paths ? { paths } : {}),
    ...(exclude ? { exclude } : {}),
  };

  const config: PaparatsConfig = {
    group,
    language,
    ...(Object.keys(indexing).length > 0 ? { indexing } : {}),
    ...(embeddings ? { embeddings } : {}),
  };

  writeConfig(projectDir, config);
  console.log(chalk.green(`\n✓ Created ${CONFIG_FILE}`));

  // Auto-configure Claude Code MCP
  const mcpJsonPath = path.join(projectDir, '.mcp.json');
  const mcpResult = upsertMcpServer(mcpJsonPath, 'paparats', {
    type: 'http',
    url: 'http://localhost:9876/mcp',
  });
  if (mcpResult === 'unchanged') {
    console.log(chalk.green('✓ .mcp.json already configured'));
  } else {
    console.log(chalk.green('✓ Added paparats to .mcp.json'));
  }

  // CCLSP setup
  if (!opts.skipCclsp) {
    const languages = Array.isArray(language) ? language : [language];
    const supportedLspLanguages = languages.filter((l) => LSP_CONFIGS[l]);

    if (supportedLspLanguages.length > 0) {
      let setupCclsp: boolean;
      if (skipPrompts) {
        setupCclsp = true;
      } else if (deps?.promptSetupCclsp) {
        setupCclsp = await deps.promptSetupCclsp();
      } else {
        setupCclsp = await confirm({
          message: 'Set up CCLSP for precise code navigation (go-to-definition, find-references)?',
          default: true,
        });
      }

      if (setupCclsp) {
        for (const lang of supportedLspLanguages) {
          const lspConfig = LSP_CONFIGS[lang];
          if (!lspConfig) continue;

          const installed = checkLspInstalled(lang, deps?.lspDeps);
          if (installed) {
            console.log(chalk.green(`✓ ${lspConfig.displayName} already installed`));
          } else {
            const spinner = ora(`Installing ${lspConfig.displayName}...`).start();
            try {
              installLspServer(lang, deps?.lspDeps);
              spinner.succeed(`Installed ${lspConfig.displayName}`);
            } catch {
              spinner.warn(
                `Failed to install ${lspConfig.displayName} — install manually: ${lspConfig.installCmd}`
              );
            }
          }
        }

        const cclspConfig = buildCclspConfig(supportedLspLanguages);
        const cclspConfigPath = getCclspConfigPath(projectDir);
        fs.writeFileSync(cclspConfigPath, JSON.stringify(cclspConfig, null, 2) + '\n');
        console.log(chalk.green('✓ Created cclsp.json'));

        const cclspInstalled = checkLspInstalled('cclsp', deps?.lspDeps);
        if (!cclspInstalled) {
          const spinner = ora('Installing cclsp...').start();
          try {
            (
              deps?.lspDeps?.execInstall ??
              ((cmd: string) => execSync(cmd, { stdio: 'inherit', timeout: 120_000 }))
            )('npm install -g cclsp');
            spinner.succeed('Installed cclsp');
          } catch {
            spinner.warn('Failed to install cclsp — install manually: npm install -g cclsp');
          }
        } else {
          console.log(chalk.green('✓ cclsp already installed'));
        }

        const cclspMcpResult = upsertMcpServer(mcpJsonPath, 'cclsp', {
          command: 'cclsp',
          env: {
            CCLSP_CONFIG_PATH: CCLSP_CONFIG_RELATIVE,
          },
        });
        if (cclspMcpResult === 'unchanged') {
          console.log(chalk.green('✓ CCLSP already configured in .mcp.json'));
        } else {
          console.log(chalk.green('✓ Added CCLSP to .mcp.json'));
        }
      }
    }
  }

  if (!skipPrompts) {
    const gitignorePath = path.join(projectDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (!content.includes(CONFIG_FILE)) {
        const addToGitignore = deps?.promptGitignore
          ? await deps.promptGitignore()
          : await confirm({
              message: `Add ${CONFIG_FILE} to .gitignore?`,
              default: false,
            });
        if (addToGitignore) {
          appendToGitignore(gitignorePath);
          console.log(chalk.green(`✓ Added to .gitignore`));
        }
      }
    }
  }

  if (!skipPrompts) {
    console.log(chalk.dim(`\nExample config:`));
    console.log(chalk.dim(`  group: ${group}`));
    console.log(
      chalk.dim(`  language: ${Array.isArray(language) ? language.join(', ') : language}`)
    );
  }

  console.log(chalk.dim(`\nNext: run ${chalk.bold('paparats install')} to set up Docker & Ollama`));
}

export const initCommand = new Command('init')
  .description('Create .paparats.yml in the current directory')
  .option('--force', 'Overwrite existing config')
  .option('--group <name>', 'Group name (skip prompt)')
  .option('--language <lang>', 'Primary language (skip prompt)')
  .option('--non-interactive', 'Use defaults without prompts')
  .option('--skip-cclsp', 'Skip CCLSP language server setup')
  .action(async (opts: InitOptions) => {
    try {
      await runInit(process.cwd(), opts);
    } catch (err) {
      const error = err as Error;
      if (error.name === 'ExitPromptError') {
        console.log(chalk.yellow('\nInit cancelled by user'));
        process.exit(130);
      }
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });
