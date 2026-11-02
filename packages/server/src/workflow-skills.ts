import { SkillsExtension, memorySkillFiles } from '@modelcontextprotocol/server/ext/skills';
import { interpolateWorkflowMessage, prompts, type WorkflowPrompt } from './prompts/index.js';

/** The Agent Skills format allows lowercase letters, digits and hyphens in a name. */
export function workflowSkillName(workflow: string): string {
  return workflow.replaceAll('_', '-');
}

/**
 * A workflow prompt as a `SKILL.md`. A prompt gets its arguments from the user up
 * front, a skill finds them in the task, so its required arguments stay as `<name>`.
 */
export function workflowSkillText(name: string, workflow: WorkflowPrompt): string {
  const required = Object.entries(workflow.args).filter(([, arg]) => arg.required);
  const inputs = Object.entries(workflow.args).map(
    ([arg, { description, required: needed }]) =>
      `- \`${arg}\`${needed ? '' : ' (optional)'}: ${description}`
  );
  const body = interpolateWorkflowMessage(
    workflow.message,
    Object.fromEntries(required.map(([arg]) => [arg, `<${arg}>`]))
  );
  return [
    '---',
    `name: ${workflowSkillName(name)}`,
    // A JSON string is a valid YAML double-quoted scalar.
    `description: ${JSON.stringify(workflow.description)}`,
    '---',
    '',
    `# ${workflow.title}`,
    '',
    'Inputs:',
    ...inputs,
    '',
    body,
    '',
  ].join('\n');
}

/** The named workflow prompts as a skills catalog, for `io.modelcontextprotocol/skills`. */
export async function loadWorkflowSkills(names: readonly string[]) {
  const files: Record<string, string> = {};
  for (const name of names) {
    const workflow = prompts.workflows[name];
    if (workflow) {
      files[`${workflowSkillName(name)}/SKILL.md`] = workflowSkillText(name, workflow);
    }
  }
  return SkillsExtension.load(memorySkillFiles(files));
}
