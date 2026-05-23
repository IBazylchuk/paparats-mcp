import { describe, it, expect } from 'vitest';
import {
  prompts,
  buildWorkflowArgsSchema,
  interpolateWorkflowMessage,
} from '../src/prompts/index.js';
import { CODING_PROMPTS, SUPPORT_PROMPTS } from '../src/mcp-handler.js';

describe('workflow prompts', () => {
  it('loads all workflows from prompts.json', () => {
    const names = Object.keys(prompts.workflows).sort();
    expect(names).toEqual([
      'assess_change_impact',
      'audit_architecture',
      'find_implementation',
      'init_arch_memory',
      'onboard_to_project',
      'prepare_release_notes',
      'record_lesson_from_correction',
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

  // Arch workflows that write (init_arch_memory, record_lesson_from_correction)
  // live in coding mode — support is read-only. audit_architecture only reads,
  // so it stays in both. Tests below pin that invariant by inspecting both the
  // mode-routing list in mcp-handler.ts and the instructions in prompts.json:
  // any change to who writes arch memory should land here too.
  it('arch write-workflows are routed to coding mode only', () => {
    expect(CODING_PROMPTS).toContain('init_arch_memory');
    expect(CODING_PROMPTS).toContain('record_lesson_from_correction');
    expect(SUPPORT_PROMPTS).not.toContain('init_arch_memory');
    expect(SUPPORT_PROMPTS).not.toContain('record_lesson_from_correction');
    // audit_architecture is read-only — must remain in both.
    expect(CODING_PROMPTS).toContain('audit_architecture');
    expect(SUPPORT_PROMPTS).toContain('audit_architecture');
  });

  it('arch write-workflows are only referenced by codingInstructions', () => {
    const coding = prompts.codingInstructions;
    const support = prompts.supportInstructions;
    for (const tool of ['arch_record_component', 'arch_record_decision', 'arch_record_lesson']) {
      expect(coding, `${tool} should be mentioned in codingInstructions`).toContain(tool);
      expect(support, `${tool} must not appear in supportInstructions`).not.toContain(tool);
    }
    // arch_context is read-only — must remain in both.
    expect(coding).toContain('arch_context');
    expect(support).toContain('arch_context');
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
