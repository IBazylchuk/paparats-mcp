/**
 * MCP prompts — loaded from JSON for easy editing and deduplication.
 * Edit packages/server/src/prompts/prompts.json to change tool descriptions and system instructions.
 */

import promptsJson from './prompts.json' with { type: 'json' };

export interface Prompts {
  serverInstructions: string;
  common: { searchFirst: string };
  tools: {
    search_code: { description: string };
    health_check: { description: string };
    reindex: { description: string };
    get_chunk: { description: string };
    get_chunk_meta: { description: string };
    search_changes: { description: string };
    find_usages: { description: string };
    list_related_chunks: { description: string };
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
}

function validatePrompts(data: unknown): Prompts {
  if (!data || typeof data !== 'object') {
    throw new Error('Prompts must be an object');
  }
  const p = data as Record<string, unknown>;
  if (typeof p.serverInstructions !== 'string') {
    throw new Error('prompts.serverInstructions must be a string');
  }
  if (!p.common || typeof p.common !== 'object') {
    throw new Error('prompts.common must be an object');
  }
  const common = p.common as Record<string, unknown>;
  if (typeof common.searchFirst !== 'string') {
    throw new Error('prompts.common.searchFirst must be a string');
  }
  if (!p.tools || typeof p.tools !== 'object') {
    throw new Error('prompts.tools must be an object');
  }
  const tools = p.tools as Record<string, unknown>;
  for (const name of [
    'search_code',
    'health_check',
    'reindex',
    'get_chunk',
    'get_chunk_meta',
    'search_changes',
    'find_usages',
    'list_related_chunks',
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
  return data as Prompts;
}

export const prompts: Prompts = validatePrompts(promptsJson);

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
