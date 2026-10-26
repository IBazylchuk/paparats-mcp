#!/usr/bin/env node
/**
 * Write examples/docker-compose/docker-compose{,.voyage}.yml from the compose
 * generator `paparats install` uses, under a header for people who start the
 * stack with plain `docker compose up`. Run after changing the generator:
 *
 *   yarn workspace @paparats/cli build && node scripts/generate-compose-examples.js
 *
 * A CLI test fails when the examples and the generator disagree.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { generateCompose } = await import(
  path.join(root, 'packages/cli/dist/docker-compose-generator.js')
);

const header = (title, note) =>
  [
    `# paparats — ${title}`,
    '#',
    `# ${note}`,
    '# Save it as docker-compose.yml next to projects.yml, then:  docker compose up -d',
    '# MCP endpoint: http://localhost:9876/mcp',
    '#   Claude Code: claude mcp add --scope user --transport http paparats http://localhost:9876/mcp',
    '# Ports, keys and options go in a .env file in the same folder (see .env.example).',
    '#',
    '# A folder on this machine: list it in projects.yml (- path: /abs/path/app) and mount it',
    '# below under paparats-indexer → volumes as  - /abs/path/app:/projects/app:ro',
    '#',
    '# Written by scripts/generate-compose-examples.js from the compose paparats install writes.',
    '',
  ].join('\n');

// Drop the generator's own two-line "managed by paparats install" header.
const body = (config) =>
  generateCompose({ ...config, paparatsHome: '.' })
    .split('\n')
    .filter((line, i) => !(i < 2 && line.startsWith('#')))
    .join('\n');

const dir = path.join(root, 'examples/docker-compose');
fs.writeFileSync(
  path.join(dir, 'docker-compose.yml'),
  header(
    'local models, nothing leaves the machine',
    'The embed service brings two models (~2.3 GB) and runs them on the CPU.'
  ) + body({ embedMode: 'docker' })
);
fs.writeFileSync(
  path.join(dir, 'docker-compose.voyage.yml'),
  header(
    'Voyage AI embeddings, no local models',
    'Needs VOYAGE_API_KEY in .env. Code is sent to Voyage AI to be embedded.'
  ) + body({ embedMode: 'docker', embeddingProvider: 'voyage' })
);
console.log(`Wrote ${dir}/docker-compose.yml and docker-compose.voyage.yml`);
