import matter from 'gray-matter';

/**
 * The only frontmatter languages this vault accepts. An empty string is the
 * bare `---` fence, which gray-matter resolves to YAML.
 */
const SUPPORTED_LANGUAGES = new Set(['', 'yaml', 'yml']);

/** The parsed frontmatter + body pair returned by {@link parseMatter}. */
export type ParsedMatter = matter.GrayMatterFile<string>;

const OPEN_DELIMITER = '---';

export class UnsupportedFrontmatterLanguageError extends Error {
  constructor(public readonly language: string) {
    super(
      `Unsupported frontmatter language "${language}": notes must use YAML frontmatter ` +
        `(a bare "---" fence, or "---yaml"/"---yml").`,
    );
    this.name = 'UnsupportedFrontmatterLanguageError';
  }
}

/**
 * Read the language tag off an opening frontmatter fence, e.g. `---js` -> `js`.
 * Returns null when the content has no opening fence at all, which is valid —
 * a note may be body-only.
 */
function readFenceLanguage(raw: string): string | null {
  if (!raw.startsWith(OPEN_DELIMITER)) return null;

  const firstLineEnd = raw.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? raw : raw.slice(0, firstLineEnd);

  return firstLine.slice(OPEN_DELIMITER.length).trim().toLowerCase();
}

/**
 * Parse note content into frontmatter + body, restricted to YAML.
 *
 * This wrapper exists for one reason: gray-matter's default engine set includes
 * a `javascript` engine that evaluates the frontmatter block with eval(). A note
 * fenced with `---js` would therefore execute arbitrary code inside the MCP
 * server process, and note content is not trusted input — files arrive via file
 * sync and via agent tool calls. Every call site parses through here so that a
 * non-YAML fence is refused before gray-matter can select an executing engine.
 *
 * Defense is layered: the language check below rejects the fence outright, and
 * the `engines` override means that even if gray-matter's language resolution
 * changed, the javascript engine it would reach for throws instead of running.
 *
 * @throws {UnsupportedFrontmatterLanguageError} when the fence names a non-YAML language.
 * @throws {Error} when the YAML itself is malformed (propagated from gray-matter).
 */
export function parseMatter(raw: string): ParsedMatter {
  const language = readFenceLanguage(raw);

  if (language !== null && !SUPPORTED_LANGUAGES.has(language)) {
    throw new UnsupportedFrontmatterLanguageError(language);
  }

  return matter(raw, {
    language: 'yaml',
    engines: {
      javascript: () => {
        throw new UnsupportedFrontmatterLanguageError('javascript');
      },
    },
  });
}

/**
 * Serialize frontmatter + body back into note text as YAML.
 *
 * Lives here so that every gray-matter entry point — read and write — is in
 * this module, and the YAML-only guarantee can be verified by grepping for
 * imports of 'gray-matter' rather than auditing each call site.
 */
export function stringifyMatter(content: string, frontmatter: Record<string, unknown>): string {
  return matter.stringify(content, frontmatter, { language: 'yaml' });
}
