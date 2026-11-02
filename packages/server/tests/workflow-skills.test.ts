import { describe, it, expect, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { McpHandler, CODING_PROMPTS, SUPPORT_PROMPTS } from '../src/mcp-handler.js';
import { prompts } from '../src/prompts/index.js';
import { workflowSkillName, workflowSkillText } from '../src/workflow-skills.js';
import type { Indexer } from '../src/indexer.js';
import type { Searcher } from '../src/searcher.js';

function createHandler(indexer: Partial<Indexer> = {}) {
  return new McpHandler({
    searcher: {
      getProjectScope: () => null,
      invalidateGroupCache: vi.fn(),
    } as unknown as Searcher,
    indexer: indexer as Indexer,
    getProjects: () => new Map(),
    getGroupNames: () => ['g1'],
  });
}

async function connect(
  handler: McpHandler,
  mode: 'coding' | 'support',
  client = new Client({ name: 'test', version: '1.0.0' })
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await handler.connectStdio(mode, serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('workflow skills', () => {
  it.each([
    ['coding', CODING_PROMPTS],
    ['support', SUPPORT_PROMPTS],
  ] as const)('%s serves its workflows as verified skills', async (mode, names) => {
    const handler = createHandler();
    const { client, close } = await connect(handler, mode);
    try {
      const skills = new SkillsClient(client);
      const { skills: entries } = await skills.list();
      expect(entries.map((e) => e.frontmatter.name).sort()).toEqual(
        names.map(workflowSkillName).sort()
      );
      // `read` checks the size and the digest the listing published.
      for (const entry of entries) {
        const file = await skills.read(entry);
        expect(new TextDecoder().decode(file.bytes)).toContain(`name: ${entry.frontmatter.name}\n`);
      }
    } finally {
      await close();
      handler.destroy();
    }
  });

  it('keeps the other resources next to the skills', async () => {
    const handler = createHandler();
    const { client, close } = await connect(handler, 'coding');
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('context://project-overview');
      expect(uris).toContain('skill://trace-callers/SKILL.md');
    } finally {
      await close();
      handler.destroy();
    }
  });

  it('leaves no placeholder in any skill and marks required inputs', () => {
    for (const [name, workflow] of Object.entries(prompts.workflows)) {
      const text = workflowSkillText(name, workflow);
      expect(text, name).not.toMatch(/\{\{|\}\}/);
      for (const [arg, { required }] of Object.entries(workflow.args)) {
        if (required) expect(text, `${name}: ${arg}`).toContain(`<${arg}>`);
      }
    }
  });
});

describe('delete_project confirmation', () => {
  /** A client that can ask its user, with the given answer. */
  function askingClient(action: 'accept' | 'decline' | 'cancel', confirm?: boolean) {
    const client = new Client(
      { name: 'test', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler('elicitation/create', async () =>
      action === 'accept' ? { action, content: { confirm: confirm === true } } : { action }
    );
    return client;
  }

  it.each([
    ['accept', true, 1],
    ['accept', false, 0],
    ['decline', undefined, 0],
    ['cancel', undefined, 0],
  ] as const)('answer %s, confirm %s: purges %i times', async (action, confirm, purges) => {
    const purgeProject = vi.fn().mockResolvedValue(undefined);
    const handler = createHandler({ purgeProject });
    const { client, close } = await connect(handler, 'coding', askingClient(action, confirm));
    try {
      const result = await client.callTool({
        name: 'delete_project',
        arguments: { group: 'g1', project: 'billing' },
      });
      expect(purgeProject).toHaveBeenCalledTimes(purges);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain(purges ? 'Deleted project' : 'was not deleted');
    } finally {
      await close();
      handler.destroy();
    }
  });

  it('a client that cannot ask deletes as before', async () => {
    const purgeProject = vi.fn().mockResolvedValue(undefined);
    const handler = createHandler({ purgeProject });
    const { client, close } = await connect(handler, 'coding');
    try {
      await client.callTool({
        name: 'delete_project',
        arguments: { group: 'g1', project: 'billing' },
      });
      expect(purgeProject).toHaveBeenCalledTimes(1);
    } finally {
      await close();
      handler.destroy();
    }
  });
});
