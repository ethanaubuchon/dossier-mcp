import { FENCED_CODE_BLOCK_RE } from './todos.js';

/**
 * Result of {@link appendToSection}. A discriminated union so callers translate
 * expected failures (missing / ambiguous heading) into structured responses
 * without try/catch — only genuinely unexpected states throw.
 */
export type AppendResult =
  | { ok: true; body: string }
  | { ok: false; reason: 'missing'; headings: string[] }
  | { ok: false; reason: 'ambiguous'; count: number };

/**
 * Result of {@link editBody}. A discriminated union so callers translate the
 * expected failures (no match / non-unique match) into structured responses;
 * only genuinely unexpected states throw.
 */
export type EditResult =
  | { ok: true; body: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'no_change' }
  | { ok: false; reason: 'not_unique'; count: number };

// ATX heading: 1–6 `#`, a space, the text, and an optional CommonMark closing
// `#` sequence which we strip. The lazy body + `\s*#*\s*$` tail drops a trailing
// run of `#` (e.g. `## Log ##` → `Log`) without eating a mid-text `#`.
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Mask fenced code blocks with same-length blank runs, preserving newlines so
 * line indices stay aligned with the original body. This lets us detect ATX
 * headings without matching `##` that lives inside a ``` fence.
 *
 * Known limitation (inherited from todos.ts's `FENCED_CODE_BLOCK_RE`): only
 * closed backtick fences are masked — an unterminated fence or a `~~~` fence is
 * not, so a `##` inside one could be seen as a heading. Accepted per the scope
 * doc's Risks; real vault notes don't hit it in practice.
 */
function maskFences(body: string): string {
  return body.replace(FENCED_CODE_BLOCK_RE, (block) => block.replace(/[^\n]/g, ' '));
}

interface HeadingHit {
  line: number;
  level: number;
  text: string;
}

function findHeadings(maskedLines: string[]): HeadingHit[] {
  const hits: HeadingHit[] = [];
  for (let i = 0; i < maskedLines.length; i++) {
    const m = HEADING_RE.exec(maskedLines[i]);
    if (m) hits.push({ line: i, level: m[1].length, text: m[2].trim() });
  }
  return hits;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

/**
 * Append `content` under the section named by `heading` in a markdown `body`.
 *
 * - Heading match is level-agnostic but case-sensitive on the exact trimmed
 *   text; the matched heading's level defines the section boundary.
 * - Content is inserted at the end of the section (before the next heading of
 *   the same-or-higher level, or EOF), with trailing blank lines normalized to
 *   a single blank line before the appended block.
 * - `createIfMissing` creates a new `## heading` section at EOF when the heading
 *   is absent; otherwise a missing heading is reported with the note's existing
 *   headings so the caller can self-correct.
 * - More than one matching heading is ambiguous and reported, not guessed.
 *
 * Pure: no I/O. The caller owns reading/writing the note.
 */
export function appendToSection(
  body: string,
  heading: string,
  content: string,
  createIfMissing: boolean,
): AppendResult {
  const target = heading.trim();
  const lines = body.split('\n');
  const maskedLines = maskFences(body).split('\n');
  const headings = findHeadings(maskedLines);
  const matches = headings.filter((h) => h.text === target);
  // Trailing blank lines in `content` would collide with the blank separator we
  // insert, so normalize them away up front.
  const contentLines = trimTrailingBlankLines(content.split('\n'));

  if (matches.length === 0) {
    if (!createIfMissing) {
      return { ok: false, reason: 'missing', headings: headings.map((h) => h.text) };
    }
    const base = trimTrailingBlankLines(lines);
    const rebuilt = base.length
      ? [...base, '', `## ${target}`, '', ...contentLines]
      : [`## ${target}`, '', ...contentLines];
    return { ok: true, body: rebuilt.join('\n') };
  }

  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous', count: matches.length };
  }

  const match = matches[0];
  // Section boundary: first later heading of same-or-higher level, else EOF.
  let boundary = lines.length;
  for (const h of headings) {
    if (h.line > match.line && h.level <= match.level) {
      boundary = h.line;
      break;
    }
  }

  const head = lines.slice(0, match.line + 1);
  const section = trimTrailingBlankLines(lines.slice(match.line + 1, boundary));
  const rest = lines.slice(boundary);

  const rebuilt = [...head, ...section, '', ...contentLines];
  if (rest.length) rebuilt.push('', ...rest);
  // Uniformly drop any trailing blank lines (e.g. the file's final newline
  // carried in via `rest`) so mid-body and EOF appends return the same shape.
  return { ok: true, body: trimTrailingBlankLines(rebuilt).join('\n') };
}

/**
 * Replace an exact substring `oldString` with `newString` in a markdown `body`,
 * mirroring the Edit-tool pattern: literal (non-regex) matching with a
 * uniqueness requirement so an ambiguous edit fails loudly instead of silently
 * changing the wrong occurrence.
 *
 * - No match → reported, not a no-op.
 * - `newString` equal to `oldString` (a no-op edit) → reported, so a caller's
 *   mistake isn't masked by a success + spurious `updated` stamp.
 * - More than one match with `replaceAll=false` → reported with the count, not
 *   guessed. With `replaceAll=true`, every occurrence is replaced.
 * - Whitespace is significant and no surrounding text is reflowed — the edit is
 *   surgical. `newString` may be empty (deletion).
 *
 * Pure: no I/O. The caller owns reading/writing the note.
 */
export function editBody(
  body: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditResult {
  if (oldString === '') return { ok: false, reason: 'not_found' };
  const count = body.split(oldString).length - 1;
  if (count === 0) return { ok: false, reason: 'not_found' };
  if (newString === oldString) return { ok: false, reason: 'no_change' };
  if (count > 1 && !replaceAll) return { ok: false, reason: 'not_unique', count };
  return { ok: true, body: body.split(oldString).join(newString) };
}
