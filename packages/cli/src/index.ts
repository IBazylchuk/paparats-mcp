import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { installCommand } from './commands/install.js';
import { updateCommand } from './commands/update.js';
import { searchCommand } from './commands/search.js';
import { statusCommand } from './commands/status.js';
import { doctorCommand } from './commands/doctor.js';
import { groupsCommand } from './commands/groups.js';
import { addCommand, listCommand, removeCommand } from './commands/projects.js';
import { startCommand, stopCommand, restartCommand } from './commands/lifecycle.js';
import { editCommand } from './commands/edit.js';

// Read version from the package's own package.json so `paparats --version`
// stays in sync with the published npm version automatically. The compiled
// entry sits at dist/index.js, so package.json is one level up.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

const program = new Command();

program.name('paparats').description('Semantic code search for your workspace').version(version);

program.addCommand(installCommand);
program.addCommand(addCommand);
program.addCommand(listCommand);
program.addCommand(removeCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(editCommand);
program.addCommand(updateCommand);
program.addCommand(searchCommand);
program.addCommand(statusCommand);
program.addCommand(doctorCommand);
program.addCommand(groupsCommand);

program.parse();
