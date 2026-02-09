import { execSync } from 'child_process';
import path from 'path';

export interface LspConfig {
  extensions: string[];
  command: string[];
  installCmd: string;
  installCheck: string;
  displayName: string;
}

export const LSP_CONFIGS: Record<string, LspConfig> = {
  typescript: {
    extensions: ['ts', 'tsx', 'js', 'jsx'],
    command: ['typescript-language-server', '--stdio'],
    installCmd: 'npm install -g typescript-language-server typescript',
    installCheck: 'typescript-language-server',
    displayName: 'TypeScript Language Server',
  },
  javascript: {
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    command: ['typescript-language-server', '--stdio'],
    installCmd: 'npm install -g typescript-language-server typescript',
    installCheck: 'typescript-language-server',
    displayName: 'TypeScript Language Server',
  },
  python: {
    extensions: ['py'],
    command: ['pylsp'],
    installCmd: 'pip install python-lsp-server',
    installCheck: 'pylsp',
    displayName: 'Python LSP Server (pylsp)',
  },
  go: {
    extensions: ['go'],
    command: ['gopls'],
    installCmd: 'go install golang.org/x/tools/gopls@latest',
    installCheck: 'gopls',
    displayName: 'gopls',
  },
  rust: {
    extensions: ['rs'],
    command: ['rust-analyzer'],
    installCmd: 'rustup component add rust-analyzer',
    installCheck: 'rust-analyzer',
    displayName: 'rust-analyzer',
  },
  java: {
    extensions: ['java'],
    command: ['jdtls'],
    installCmd: 'npm install -g java-language-server',
    installCheck: 'jdtls',
    displayName: 'Eclipse JDT Language Server',
  },
  ruby: {
    extensions: ['rb', 'rake', 'rbs'],
    command: ['solargraph', 'stdio'],
    installCmd: 'gem install solargraph',
    installCheck: 'solargraph',
    displayName: 'Solargraph',
  },
  csharp: {
    extensions: ['cs'],
    command: ['omnisharp'],
    installCmd: 'dotnet tool install -g omnisharp',
    installCheck: 'omnisharp',
    displayName: 'OmniSharp',
  },
  cclsp: {
    extensions: [],
    command: ['cclsp'],
    installCmd: 'npm install -g cclsp',
    installCheck: 'cclsp',
    displayName: 'cclsp',
  },
};

export interface LspInstallerDeps {
  commandExists?: (cmd: string) => boolean;
  execInstall?: (cmd: string) => void;
}

function defaultCommandExists(cmd: string): boolean {
  try {
    const command = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(command, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function checkLspInstalled(language: string, deps?: LspInstallerDeps): boolean {
  const config = LSP_CONFIGS[language];
  if (!config) return false;
  const cmdExists = deps?.commandExists ?? defaultCommandExists;
  return cmdExists(config.installCheck);
}

export function installLspServer(language: string, deps?: LspInstallerDeps): void {
  const config = LSP_CONFIGS[language];
  if (!config) {
    throw new Error(`No LSP config for language: ${language}`);
  }
  const exec =
    deps?.execInstall ?? ((cmd: string) => execSync(cmd, { stdio: 'inherit', timeout: 120_000 }));
  exec(config.installCmd);
}

/** Server config per cclsp spec: https://github.com/ktnyt/cclsp/blob/main/README.md */
export interface CclspServerConfig {
  extensions: string[];
  command: string[];
  rootDir?: string;
}

export interface CclspConfig {
  servers: CclspServerConfig[];
}

export function buildCclspConfig(languages: string[]): CclspConfig {
  const servers: CclspServerConfig[] = [];
  const seenCommandKey = new Set<string>();

  for (const lang of languages) {
    const config = LSP_CONFIGS[lang];
    if (!config) continue;

    const cmdKey = config.command.join(' ');
    if (seenCommandKey.has(cmdKey)) {
      const existing = servers.find((s) => s.command.join(' ') === cmdKey);
      if (existing) {
        for (const ext of config.extensions) {
          if (!existing.extensions.includes(ext)) existing.extensions.push(ext);
        }
      }
      continue;
    }
    seenCommandKey.add(cmdKey);

    servers.push({
      extensions: [...config.extensions],
      command: config.command,
      rootDir: '.',
    });
  }

  return { servers };
}

/** Relative path for CCLSP_CONFIG_PATH — portable, safe for git. */
export const CCLSP_CONFIG_RELATIVE = './cclsp.json';

export function getCclspConfigPath(projectDir: string): string {
  return path.join(projectDir, 'cclsp.json');
}
