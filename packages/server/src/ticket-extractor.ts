export interface ExtractedTicket {
  key: string;
  source: 'jira' | 'github' | 'custom';
}

// Jira: PROJECT-123
const JIRA_PATTERN = /\b([A-Z]{2,}-\d+)\b/g;

// GitHub: #123 (space/start-of-string anchored to avoid false positives)
const GITHUB_ISSUE_PATTERN = /(?:^|\s)#(\d+)\b/g;

// GitHub cross-repo: org/repo#123
const GITHUB_CROSS_REPO_PATTERN = /\b([\w.-]+\/[\w.-]+#\d+)\b/g;

/**
 * Validate custom regex patterns at config time.
 * Throws if any pattern is not a valid regex.
 */
export function validateTicketPatterns(patterns: string[]): void {
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, 'g');
    } catch (err) {
      throw new Error(`Invalid ticket pattern "${pattern}": ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
}

/**
 * Extract ticket references from a commit message.
 * Built-in: Jira (ABC-123), GitHub (#123, org/repo#123).
 * Custom patterns from .paparats.yml are also supported.
 */
export function extractTickets(message: string, customPatterns?: string[]): ExtractedTicket[] {
  const seen = new Set<string>();
  const tickets: ExtractedTicket[] = [];

  function add(key: string, source: ExtractedTicket['source']): void {
    if (seen.has(key)) return;
    seen.add(key);
    tickets.push({ key, source });
  }

  // Jira
  for (const match of message.matchAll(JIRA_PATTERN)) {
    add(match[1]!, source('jira'));
  }

  // GitHub #N
  for (const match of message.matchAll(GITHUB_ISSUE_PATTERN)) {
    add(`#${match[1]!}`, source('github'));
  }

  // GitHub cross-repo
  for (const match of message.matchAll(GITHUB_CROSS_REPO_PATTERN)) {
    add(match[1]!, source('github'));
  }

  // Custom patterns
  if (customPatterns) {
    for (const pattern of customPatterns) {
      try {
        const re = new RegExp(pattern, 'g');
        for (const match of message.matchAll(re)) {
          const key = match[1] ?? match[0];
          if (key) {
            add(key, source('custom'));
          }
        }
      } catch {
        // Skip invalid patterns at runtime (should be caught by validateTicketPatterns at config time)
      }
    }
  }

  return tickets;
}

function source(s: ExtractedTicket['source']): ExtractedTicket['source'] {
  return s;
}
