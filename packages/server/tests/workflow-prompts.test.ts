import { describe, it, expect } from 'vitest';
import {
  prompts,
  buildWorkflowArgsSchema,
  interpolateWorkflowMessage,
} from '../src/prompts/index.js';

describe('workflow prompts', () => {
  it('loads all six workflows from prompts.json', () => {
    const names = Object.keys(prompts.workflows).sort();
    expect(names).toEqual([
      'assess_change_impact',
      'find_implementation',
      'onboard_to_project',
      'prepare_release_notes',
      'trace_callers',
      'triage_incident',
    ]);
  });

  it('every workflow has title, description, message, and well-formed args', () => {
    for (const [name, wf] of Object.entries(prompts.workflows)) {
      expect(wf.title, name).toBeTypeOf('string');
      expect(wf.description, name).toBeTypeOf('string');
      expect(wf.message, name).toBeTypeOf('string');
      expect(wf.args, name).toBeTypeOf('object');
      for (const arg of Object.values(wf.args)) {
        expect(arg.description).toBeTypeOf('string');
        expect(arg.required).toBeTypeOf('boolean');
      }
    }
  });
});

describe('buildWorkflowArgsSchema', () => {
  it('produces required Zod strings for required args and optional for optional', () => {
    const schema = buildWorkflowArgsSchema({
      a: { description: 'required arg', required: true },
      b: { description: 'optional arg', required: false },
    });
    expect(schema.a!.safeParse('hello').success).toBe(true);
    expect(schema.a!.safeParse(undefined).success).toBe(false);
    expect(schema.b!.safeParse('hello').success).toBe(true);
    expect(schema.b!.safeParse(undefined).success).toBe(true);
  });
});

describe('interpolateWorkflowMessage', () => {
  it('substitutes a required placeholder', () => {
    expect(interpolateWorkflowMessage('hello {{name}}', { name: 'world' })).toBe('hello world');
  });

  it('uses fallback when optional placeholder is missing', () => {
    expect(interpolateWorkflowMessage('scope: {{project|all}}', {})).toBe('scope: all');
  });

  it('uses provided value over fallback when both exist', () => {
    expect(interpolateWorkflowMessage('scope: {{project|all}}', { project: 'billing' })).toBe(
      'scope: billing'
    );
  });

  it('empty string is treated as missing and falls back', () => {
    expect(interpolateWorkflowMessage('scope: {{project|all}}', { project: '' })).toBe(
      'scope: all'
    );
  });

  it('missing required placeholder becomes empty string', () => {
    expect(interpolateWorkflowMessage('hello {{name}}!', {})).toBe('hello !');
  });

  it('handles multiple placeholders in one template', () => {
    expect(
      interpolateWorkflowMessage('{{a}} and {{b|default}} and {{c}}', { a: 'x', c: 'z' })
    ).toBe('x and default and z');
  });
});
