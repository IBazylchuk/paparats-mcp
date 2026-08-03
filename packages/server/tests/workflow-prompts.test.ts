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

  // The arch layer is coding-only in both directions, so every arch workflow is
  // routed there. Tests below pin that invariant against both the mode-routing lists
  // in mcp-handler.ts and the instructions in prompts.json — a workflow offered to a
  // mode that lacks the underlying tools fails on its first step.
  it('routes every arch workflow to coding mode only', () => {
    for (const wf of ['init_arch_memory', 'record_lesson_from_correction', 'audit_architecture']) {
      expect(CODING_PROMPTS, `${wf} should stay in coding mode`).toContain(wf);
      expect(SUPPORT_PROMPTS, `${wf} must not be offered to support`).not.toContain(wf);
    }
  });

  it('documents the arch layer in coding mode and never mentions it to support', () => {
    // An available tool the instructions never mention is one the agent never calls —
    // and a tool the instructions mention but the mode never registers is worse: the
    // agent tries it and reports a broken server.
    const coding = prompts.codingInstructions;
    for (const tool of ['arch_context', 'arch_record_decision', 'arch_record_lesson']) {
      expect(coding, `${tool} should be mentioned in codingInstructions`).toContain(tool);
    }
    // \b so this does not trip on the `arch_` inside search_code / search_docs.
    expect(prompts.supportInstructions).not.toMatch(/\barch_/);
  });

  it('gives support a route for "why is it built this way" that is not the arch layer', () => {
    // Removing arch left the question with no destination. Without an explicit route,
    // the model fills the gap by inferring intent from search results and stating it
    // as fact — the exact failure the arch layer was supposed to prevent.
    expect(prompts.supportInstructions).toMatch(/Why is it built this way/i);
    expect(prompts.supportInstructions).toMatch(/engineer/i);
  });

  it('documents the docs and glossary layers in both modes', () => {
    // These tools shipped registered but undocumented in either instruction set, so
    // clients without our plugins had no idea when to reach for them.
    for (const key of ['codingInstructions', 'supportInstructions'] as const) {
      for (const tool of ['search_docs', 'term_search', 'term_record']) {
        expect(prompts[key], `${tool} should be mentioned in ${key}`).toContain(tool);
      }
    }
  });

  it('warns in both modes that a miss on a sparse layer is not evidence', () => {
    // The sparse layers are incomplete. Without this, an empty result gets reported as
    // "no such thing exists" — the failure that prompted this wording. Each mode is
    // checked against the layers it can actually reach: support has docs + glossary,
    // coding has those plus arch.
    expect(prompts.supportInstructions).toMatch(/not recorded yet|is not recorded/i);
    expect(prompts.codingInstructions).toMatch(/nobody wrote|not recorded yet|is not recorded/i);
  });

  it('init_arch_memory requires project — arch_record_component cannot be called without it', () => {
    // arch_record_component requires `project`. The init workflow that drives
    // those calls must therefore force the user to supply a project up front.
    const init = prompts.workflows.init_arch_memory;
    expect(init).toBeDefined();
    expect(init!.args.project).toBeDefined();
    expect(init!.args.project!.required).toBe(true);
    // The instructions must spell out the required field in the example call.
    expect(init!.message).toMatch(/project/);
    expect(init!.message).toMatch(/required/i);
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
