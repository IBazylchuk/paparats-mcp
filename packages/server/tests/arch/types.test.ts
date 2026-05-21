import { describe, it, expectTypeOf } from 'vitest';
import type {
  ArchKind,
  ArchComponent,
  ArchDecision,
  ArchLesson,
  ArchContextResult,
} from '../../src/arch/types.js';

describe('arch types', () => {
  it('ArchKind has exactly three values', () => {
    expectTypeOf<ArchKind>().toEqualTypeOf<'component' | 'decision' | 'lesson'>();
  });

  it('ArchComponent has required fields', () => {
    const c: ArchComponent = {
      id: 'uuid',
      kind: 'component',
      name: 'x',
      summary: 'y',
      files: [],
      neighbours: [],
      anchors: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expectTypeOf(c.kind).toEqualTypeOf<'component'>();
  });

  it('ArchDecision has status union and supersedes link', () => {
    const d: ArchDecision = {
      id: 'uuid',
      kind: 'decision',
      title: 't',
      context: 'c',
      decision: 'd',
      consequences: 'q',
      status: 'accepted',
      supersedes: null,
      scope: 'global',
      createdAt: 0,
      updatedAt: 0,
    };
    expectTypeOf(d.status).toEqualTypeOf<'proposed' | 'accepted' | 'superseded' | 'deprecated'>();
  });

  it('ArchLesson has scope union and severity', () => {
    const l: ArchLesson = {
      id: 'uuid',
      kind: 'lesson',
      summary: 's',
      scope: 'global',
      evidence: null,
      severity: 'info',
      status: 'accepted',
      createdAt: 0,
      updatedAt: 0,
    };
    expectTypeOf(l.severity).toEqualTypeOf<'info' | 'warning' | 'critical'>();
  });

  it('ArchContextResult separates components, decisions, lessons', () => {
    const r: ArchContextResult = {
      components: [],
      decisions: [],
      lessons: [],
      empty: true,
      hint: null,
    };
    expectTypeOf(r.empty).toEqualTypeOf<boolean>();
  });
});
