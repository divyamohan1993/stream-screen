/**
 * Chat text sanitization for the viewer.
 *
 * React already escapes text rendered as element children, so HTML injection is
 * not possible through the normal render path. This module is defense-in-depth:
 * it strips control characters, neutralizes angle brackets / ampersands (so the
 * text can never be interpreted as markup even if rendered via a raw sink), and
 * bounds the length to keep a hostile peer from flooding the UI.
 */

/** Maximum length of a single chat message after sanitization. */
export const MAX_CHAT_LENGTH = 2000;

// Drop control chars except tab (U+0009), newline (U+000A), carriage return
// (U+000D). Built via RegExp constructor to avoid embedding raw control bytes.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', 'g');

/**
 * Sanitize a chat string: drop non-printable control characters (except common
 * whitespace), escape HTML-significant characters, collapse to {@link MAX_CHAT_LENGTH},
 * and trim. Returns a string that is always safe to render as text.
 */
export function sanitizeChat(input: unknown): string {
  if (typeof input !== 'string') return '';
  const stripped = input.replace(CONTROL_CHARS, '');
  const escaped = stripped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped.slice(0, MAX_CHAT_LENGTH).trim();
}

/** Whether a (post-sanitization) chat string is worth sending/rendering. */
export function isSendableChat(input: unknown): boolean {
  return sanitizeChat(input).length > 0;
}
