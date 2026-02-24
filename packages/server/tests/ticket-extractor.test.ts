import { describe, it, expect } from 'vitest';
import { extractTickets, validateTicketPatterns } from '../src/ticket-extractor.js';

describe('extractTickets', () => {
  it('extracts single Jira ticket', () => {
    const tickets = extractTickets('fix: resolve login issue PROJ-123');
    expect(tickets).toEqual([{ key: 'PROJ-123', source: 'jira' }]);
  });

  it('extracts multiple Jira tickets', () => {
    const tickets = extractTickets('feat: PROJ-123 and PROJ-456 improvements');
    expect(tickets).toHaveLength(2);
    expect(tickets.map((t) => t.key)).toContain('PROJ-123');
    expect(tickets.map((t) => t.key)).toContain('PROJ-456');
  });

  it('extracts GitHub issue #N', () => {
    const tickets = extractTickets('fix: resolve login issue #42');
    expect(tickets).toEqual([{ key: '#42', source: 'github' }]);
  });

  it('extracts GitHub issue at start of message', () => {
    const tickets = extractTickets('#42 fix login');
    expect(tickets).toEqual([{ key: '#42', source: 'github' }]);
  });

  it('extracts GitHub cross-repo reference', () => {
    const tickets = extractTickets('see org/repo#99 for details');
    expect(tickets).toEqual([{ key: 'org/repo#99', source: 'github' }]);
  });

  it('extracts mixed Jira and GitHub tickets', () => {
    const tickets = extractTickets('PROJ-123: fix #42 see also org/repo#7');
    expect(tickets).toHaveLength(3);
    const keys = tickets.map((t) => t.key);
    expect(keys).toContain('PROJ-123');
    expect(keys).toContain('#42');
    expect(keys).toContain('org/repo#7');
  });

  it('deduplicates tickets', () => {
    const tickets = extractTickets('PROJ-123 and PROJ-123 again');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.key).toBe('PROJ-123');
  });

  it('does not match hex colors as Jira tickets', () => {
    const tickets = extractTickets('color: #FF0000');
    // #FF0000 should not match — FF0000 requires uppercase 2+ letter prefix followed by digits
    // Our Jira pattern is [A-Z]{2,}-\d+ which won't match FF0000 (no dash)
    const jiraTickets = tickets.filter((t) => t.source === 'jira');
    expect(jiraTickets).toHaveLength(0);
  });

  it('returns empty for message with no tickets', () => {
    const tickets = extractTickets('chore: update dependencies');
    expect(tickets).toEqual([]);
  });

  it('extracts tickets with custom patterns', () => {
    const tickets = extractTickets('fix: resolve TASK_42 issue', ['TASK_(\\d+)']);
    const custom = tickets.filter((t) => t.source === 'custom');
    expect(custom).toHaveLength(1);
    expect(custom[0]!.key).toBe('42');
  });

  it('custom pattern with full match when no capture group', () => {
    const tickets = extractTickets('fix: resolve bug/42 issue', ['bug/\\d+']);
    const custom = tickets.filter((t) => t.source === 'custom');
    expect(custom).toHaveLength(1);
    expect(custom[0]!.key).toBe('bug/42');
  });

  it('handles Jira ticket at minimum length (2 letter prefix)', () => {
    const tickets = extractTickets('AB-1 is the smallest');
    expect(tickets).toEqual([{ key: 'AB-1', source: 'jira' }]);
  });

  it('does not match single letter prefix as Jira', () => {
    const tickets = extractTickets('A-123 is not Jira');
    const jira = tickets.filter((t) => t.source === 'jira');
    expect(jira).toHaveLength(0);
  });
});

describe('validateTicketPatterns', () => {
  it('accepts valid regex patterns', () => {
    expect(() => validateTicketPatterns(['TASK_\\d+', 'BUG-\\d+'])).not.toThrow();
  });

  it('throws for invalid regex', () => {
    expect(() => validateTicketPatterns(['[invalid'])).toThrow('Invalid ticket pattern');
  });

  it('accepts empty array', () => {
    expect(() => validateTicketPatterns([])).not.toThrow();
  });
});
