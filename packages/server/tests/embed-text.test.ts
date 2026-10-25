import { describe, expect, it } from 'vitest';
import { chunkEmbedText } from '../src/embed-text.js';

describe('chunkEmbedText', () => {
  it('puts the path above the chunk', () => {
    expect(chunkEmbedText('app/models/billing/invoice.rb', '  def total\n  end')).toBe(
      'Filepath: app/models/billing/invoice.rb\n---\n  def total\n  end'
    );
  });
});
