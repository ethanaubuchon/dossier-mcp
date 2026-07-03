import { FENCED_CODE_BLOCK_RE } from './todos.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mask fenced code blocks with same-length blank runs (newlines preserved) so a
// `[[link]]` inside a ``` fence isn't rewritten, while match indices stay aligned
// with the original body. Same approach as sections.ts; inherits todos.ts's
// closed-backtick-fence-only limitation (unterminated / `~~~` fences not masked).
function maskFences(body: string): string {
  return body.replace(FENCED_CODE_BLOCK_RE, (block) => block.replace(/[^\n]/g, ' '));
}

/**
 * Rewrite inline `[[oldSlug]]` wiki-links in a markdown `body` to `[[newSlug]]`,
 * preserving any `#heading` and/or `|alias` suffix. The `]]` anchor makes the
 * target an exact-slug match, so `[[oldSlug-extra]]` is left alone. Links inside
 * fenced code blocks are not touched.
 *
 * Pure: no I/O. Returns the new body and whether anything changed.
 */
export function updateWikiLinks(
  body: string,
  oldSlug: string,
  newSlug: string,
): { content: string; changed: boolean } {
  if (oldSlug === newSlug) return { content: body, changed: false };

  const masked = maskFences(body);
  const re = new RegExp(`\\[\\[${escapeRegExp(oldSlug)}((?:#[^\\]|]*)?(?:\\|[^\\]]*)?)\\]\\]`, 'g');

  let result = '';
  let last = 0;
  let changed = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    result += body.slice(last, m.index) + `[[${newSlug}${m[1]}]]`;
    last = m.index + m[0].length;
    changed = true;
  }
  result += body.slice(last);
  return { content: result, changed };
}
