import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
import { updateCommand } from './commands/update.js';
import { indexCommand } from './commands/index-cmd.js';
import { searchCommand } from './commands/search.js';
import { statusCommand } from './commands/status.js';
import { watchCommand } from './commands/watch.js';
import { doctorCommand } from './commands/doctor.js';
import { groupsCommand } from './commands/groups.js';

const program = new Command();

program.name('paparats').description('Semantic code search for your workspace').version('0.1.0');

program.addCommand(initCommand);
program.addCommand(installCommand);
program.addCommand(updateCommand);
program.addCommand(indexCommand);
program.addCommand(searchCommand);
program.addCommand(statusCommand);
program.addCommand(watchCommand);
program.addCommand(doctorCommand);
program.addCommand(groupsCommand);

program.parse();
