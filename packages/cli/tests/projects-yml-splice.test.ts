import { describe, it, expect } from 'vitest';
import { renderExcludeHintComment, spliceHintAfterEntry } from '../src/projects-yml.js';

describe('renderExcludeHintComment', () => {
  it('renders a commented block for ruby with all defaults annotated', () => {
    const out = renderExcludeHintComment('ruby', '    ');
    expect(out).not.toBeNull();
    expect(out).toMatch(/^ {4}# indexing:\n/);
    expect(out).toMatch(/# {3}exclude_extra:.*additive.*ruby defaults/);
    expect(out).toMatch(/# {5}- vendor {4}# \(already excluded by default for ruby\)/);
  });

  it('returns null for generic', () => {
    expect(renderExcludeHintComment('generic', '    ')).toBeNull();
  });

  it('returns null for an unknown language (no defaults to show)', () => {
    expect(renderExcludeHintComment('cobol', '    ')).toBeNull();
  });
});

describe('spliceHintAfterEntry', () => {
  const hint = '    # indexing:\n    #   exclude_extra: []\n';

  it('splices after the target entry and before the next entry', () => {
    const yaml = ['repos:', '  - path: /a', '  - path: /b', '  - path: /c', ''].join('\n');
    const out = spliceHintAfterEntry(yaml, 1, hint);
    expect(out).toBe(
      [
        'repos:',
        '  - path: /a',
        '  - path: /b',
        '    # indexing:',
        '    #   exclude_extra: []',
        '  - path: /c',
        '',
      ].join('\n')
    );
  });

  it('splices at EOF when the target entry is the last one', () => {
    const yaml = ['repos:', '  - path: /a', '  - path: /b', ''].join('\n');
    const out = spliceHintAfterEntry(yaml, 1, hint);
    expect(out).toBe(
      [
        'repos:',
        '  - path: /a',
        '  - path: /b',
        '    # indexing:',
        '    #   exclude_extra: []',
        '',
      ].join('\n')
    );
  });

  it('stays inside the repos: block when a trailing top-level key follows', () => {
    // Today's writer emits repos: last, so this case can't occur. But the
    // helper is exported — protect against a future serialiser putting
    // another top-level key after repos:.
    const yaml = ['repos:', '  - path: /a', '  - path: /b', 'trailing:', '  k: v', ''].join('\n');
    const out = spliceHintAfterEntry(yaml, 1, hint);
    expect(out).toBe(
      [
        'repos:',
        '  - path: /a',
        '  - path: /b',
        '    # indexing:',
        '    #   exclude_extra: []',
        'trailing:',
        '  k: v',
        '',
      ].join('\n')
    );
  });

  it('does not miscount nested list items as new entries', () => {
    // A pre-existing entry already has a deeper `- vendor` inside exclude:.
    // The walk must skip those (4-space indent) and only count `  - ` rows.
    const yaml = [
      'repos:',
      '  - path: /a',
      '    indexing:',
      '      exclude:',
      '        - vendor',
      '        - tmp',
      '  - path: /b',
      '',
    ].join('\n');
    const out = spliceHintAfterEntry(yaml, 1, hint);
    expect(out).toContain('  - path: /b\n    # indexing:');
  });

  it('returns input unchanged when entryIndex is out of range', () => {
    const yaml = ['repos:', '  - path: /a', ''].join('\n');
    expect(spliceHintAfterEntry(yaml, 5, hint)).toBe(yaml);
  });

  it('returns input unchanged when there is no repos: key', () => {
    const yaml = 'defaults:\n  group: g\n';
    expect(spliceHintAfterEntry(yaml, 0, hint)).toBe(yaml);
  });

  it('returns input unchanged when hint is empty', () => {
    const yaml = ['repos:', '  - path: /a', ''].join('\n');
    expect(spliceHintAfterEntry(yaml, 0, '')).toBe(yaml);
  });
});
