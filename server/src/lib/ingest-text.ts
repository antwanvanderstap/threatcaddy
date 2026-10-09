/** Single-line field (title, source, ids): trimmed, every control character removed. */
export function sanitizeLine(s: unknown, maxLen: number): string {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.trim().replace(/[\x00-\x1f\x7f]/g, '').substring(0, maxLen);
}

/**
 * Multi-line text (descriptions): line breaks and tabs survive, so markdown
 * from a connector keeps its structure; other control characters are removed
 * and CRLF/CR become LF.
 */
export function sanitizeText(s: unknown, maxLen: number): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim()
    .substring(0, maxLen);
}
