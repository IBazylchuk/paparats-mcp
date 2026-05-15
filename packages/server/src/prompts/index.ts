/**
 * MCP prompts — loaded from JSON for easy editing and deduplication.
 * Edit packages/server/src/prompts/prompts.json to change tool descriptions and system instructions.
 */

import { z } from 'zod';
import promptsJson from './prompts.json' with { type: 'json' };

export interface WorkflowPromptArg {
  description: string;
  required: boolean;
}

export interface WorkflowPrompt {
  title: string;
  description: string;
  args: Record<string, WorkflowPromptArg>;
  message: string;
}

export interface Prompts {
  codingInstructions: string;
  supportInstructions: string;
  common: { searchFirst: string; noResults: string };
  tools: {
    search_code: { description: string };
    health_check: { description: string };
    delete_project: { description: string };
    get_chunk: { description: string };
    get_chunk_meta: { description: string };
    search_changes: { description: string };
    find_usages: { description: string };
    explain_feature: { description: string };
    recent_changes: { description: string };
    impact_analysis: { description: string };
    list_projects: { description: string };
  };
  resources: {
    projectOverview: {
      searchCapabilitiesTitle: string;
      searchCapabilitiesBody: string;
      exampleQueries: string[];
      scoreInterpretation: string;
      searchFirstNote: string;
    };
  };
  workflows: Record<string, WorkflowPrompt>;
}

function validatePrompts(data: unknown): Prompts {
  if (!data || typeof data !== 'object') {
    throw new Error('Prompts must be an object');
  }
  const p = data as Record<string, unknown>;
  if (typeof p.codingInstructions !== 'string') {
    throw new Error('prompts.codingInstructions must be a string');
  }
  if (typeof p.supportInstructions !== 'string') {
    throw new Error('prompts.supportInstructions must be a string');
  }
  if (!p.common || typeof p.common !== 'object') {
    throw new Error('prompts.common must be an object');
  }
  const common = p.common as Record<string, unknown>;
  if (typeof common.searchFirst !== 'string') {
    throw new Error('prompts.common.searchFirst must be a string');
  }
  if (typeof common.noResults !== 'string') {
    throw new Error('prompts.common.noResults must be a string');
  }
  if (!p.tools || typeof p.tools !== 'object') {
    throw new Error('prompts.tools must be an object');
  }
  const tools = p.tools as Record<string, unknown>;
  for (const name of [
    'search_code',
    'health_check',
    'delete_project',
    'get_chunk',
    'get_chunk_meta',
    'search_changes',
    'find_usages',
    'explain_feature',
    'recent_changes',
    'impact_analysis',
    'list_projects',
  ]) {
    const t = tools[name];
    if (!t || typeof t !== 'object') {
      throw new Error(`prompts.tools.${name} must be an object`);
    }
    const desc = (t as Record<string, unknown>).description;
    if (typeof desc !== 'string') {
      throw new Error(`prompts.tools.${name}.description must be a string`);
    }
  }
  const resources = p.resources;
  if (!resources || typeof resources !== 'object') {
    throw new Error('prompts.resources must be an object');
  }
  const ro = (resources as Record<string, unknown>).projectOverview;
  if (!ro || typeof ro !== 'object') {
    throw new Error('prompts.resources.projectOverview must exist');
  }
  const projectOverview = ro as Record<string, unknown>;
  if (
    typeof projectOverview.searchCapabilitiesTitle !== 'string' ||
    typeof projectOverview.searchCapabilitiesBody !== 'string' ||
    !Array.isArray(projectOverview.exampleQueries) ||
    typeof projectOverview.scoreInterpretation !== 'string' ||
    typeof projectOverview.searchFirstNote !== 'string'
  ) {
    throw new Error('prompts.resources.projectOverview has invalid structure');
  }
  const workflows = p.workflows;
  if (!workflows || typeof workflows !== 'object') {
    throw new Error('prompts.workflows must be an object');
  }
  for (const [name, raw] of Object.entries(workflows as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`prompts.workflows.${name} must be an object`);
    }
    const wf = raw as Record<string, unknown>;
    if (typeof wf.title !== 'string') {
      throw new Error(`prompts.workflows.${name}.title must be a string`);
    }
    if (typeof wf.description !== 'string') {
      throw new Error(`prompts.workflows.${name}.description must be a string`);
    }
    if (typeof wf.message !== 'string') {
      throw new Error(`prompts.workflows.${name}.message must be a string`);
    }
    if (!wf.args || typeof wf.args !== 'object') {
      throw new Error(`prompts.workflows.${name}.args must be an object`);
    }
    for (const [argName, argRaw] of Object.entries(wf.args as Record<string, unknown>)) {
      if (!argRaw || typeof argRaw !== 'object') {
        throw new Error(`prompts.workflows.${name}.args.${argName} must be an object`);
      }
      const arg = argRaw as Record<string, unknown>;
      if (typeof arg.description !== 'string') {
        throw new Error(`prompts.workflows.${name}.args.${argName}.description must be a string`);
      }
      if (typeof arg.required !== 'boolean') {
        throw new Error(`prompts.workflows.${name}.args.${argName}.required must be a boolean`);
      }
    }
  }
  return data as Prompts;
}

export const prompts: Prompts = validatePrompts(promptsJson);

export function buildWorkflowArgsSchema(
  args: Record<string, WorkflowPromptArg>
): Record<string, z.ZodTypeAny> {
  const schema: Record<string, z.ZodTypeAny> = {};
  for (const [name, arg] of Object.entries(args)) {
    const base = z.string().describe(arg.description);
    schema[name] = arg.required ? base : base.optional();
  }
  return schema;
}

/**
 * Interpolate {{name}} and {{name|fallback}} placeholders against argument values.
 * - {{name}} → value if present and non-empty, else empty string.
 * - {{name|fallback}} → value if present and non-empty, else literal fallback text.
 */
export function interpolateWorkflowMessage(
  template: string,
  args: Record<string, string | undefined>
): string {
  return template.replace(
    /\{\{([a-zA-Z_][a-zA-Z0-9_]*)(?:\|([^}]*))?\}\}/g,
    (_match, name, fallback) => {
      const value = args[name];
      if (typeof value === 'string' && value.length > 0) return value;
      return typeof fallback === 'string' ? fallback : '';
    }
  );
}

export function buildProjectOverviewSections(): string[] {
  const projectOverview = prompts.resources.projectOverview;
  return [
    projectOverview.searchCapabilitiesTitle,
    '',
    projectOverview.searchCapabilitiesBody,
    '',
    'Example queries:',
    ...projectOverview.exampleQueries.map((q) => `- ${q}`),
    '',
    '### Score Interpretation',
    '',
    projectOverview.scoreInterpretation,
    '',
    projectOverview.searchFirstNote,
  ];
}
