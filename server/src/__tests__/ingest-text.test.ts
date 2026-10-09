import { describe, it, expect } from 'vitest';
import { sanitizeLine, sanitizeText } from '../lib/ingest-text.js';

describe('ingest text sanitizing', () => {
  it('keeps line breaks and tabs in multi-line text', () => {
    expect(sanitizeText('  **Case:** 1\r\n**Customer:** NAG\r\tx\u0007  ', 100)).toBe('**Case:** 1\n**Customer:** NAG\n\tx');
    expect(sanitizeText(42, 10)).toBe('');
    expect(sanitizeText('abcdef', 3)).toBe('abc');
  });

  it('flattens single-line fields', () => {
    expect(sanitizeLine(' a\nb\tc\u007f ', 10)).toBe('abc');
  });
});
