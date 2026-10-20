/**
 * The privacy check run on writes bound for a station vault: outgoing content
 * is held when it links to a note in a personal vault or reproduces a run of
 * its text verbatim. Pure — callers supply the outgoing strings and the
 * personal sources.
 */

import { createHmac } from 'crypto';

/** Consecutive normalised tokens that count as a verbatim reproduction. */
export const CHUNK_TOKENS = 12;

/** Most verbatim matches reported; every link match is reported. */
export const MAX_VERBATIM_MATCHES = 5;

/**
 * Lines dropped before tokenising, on both sides, because they recur
 * identically across unrelated text. Each pattern matches the whole line, so
 * personal text can't ride along on it: a git trailer with a name of at most
 * five words (`Co-Authored-By: Name <email>`), and the Claude Code PR footer.
 */
const BOILERPLATE_LINE_RES = [
  /^\s*[A-Za-z][A-Za-z-]*-by:\s+(?:[^\s<>]+\s+){1,5}<[^<>\s]+@[^<>\s]+>\s*$/i,
  /^\s*(?:🤖\s*)?Generated with (?:\[Claude Code\]\(https:\/\/claude\.com\/claude-code\)|Claude Code)\s*$/,
];

/** A heading or task-list item: a block of one line that runs never cross. */
const SEPARATE_LINE_RE = /^\s*(?:#{1,6}\s|(?:[-*+]|\d+[.)])\s+\[[ xX]\])/;

/** Zero-width and other default-ignorable characters, which would split words. */
const IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu;

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const NOTE_URI_RE = /note:\/\/([^\s)\]>"'`]+)/g;
/** A slug-like token with at least one `/`, e.g. `finances/budget`. */
const PATH_RE = /[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+/g;

/**
 * Text as comparable tokens: boilerplate lines dropped, default-ignorable
 * characters (zero-width space, soft hyphen) removed, Unicode NFKC, lowercased,
 * split on every run of characters that are not letters or digits. Markdown
 * syntax, punctuation and whitespace differences therefore don't defeat a match.
 */
export function normalizeTokens(text: string): string[] {
  return tokenBlocks(text).flat();
}

function tokenize(text: string): string[] {
  return text.replace(IGNORABLE_RE, '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * `normalizeTokens` split into the stretches a verbatim run may span. Blank
 * lines, headings and task-list items (`- [ ]`) separate stretches, and each
 * heading or task item stands alone; prose, list items, table rows, quotes and
 * code run on across lines. So a copied list of short facts still forms one
 * run, while templates built from headings and checkboxes don't add up to one.
 */
export function tokenBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current);
    current = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (BOILERPLATE_LINE_RES.some((re) => re.test(line))) continue;
    const separate = SEPARATE_LINE_RE.test(line);
    if (line.trim() === '' || separate) flush();
    current.push(...tokenize(line));
    if (separate) flush();
  }
  flush();
  return blocks;
}

/** A slug in comparable form: trimmed, trailing punctuation and `.md` dropped, lowercased. */
function normalizeSlug(slug: string): string {
  return slug.trim().replace(/[.,;:!?]+$/, '').replace(/\.md$/i, '').toLowerCase();
}

/**
 * Slugs `text` points at, in comparable form: wiki-link targets, `note://`
 * URIs, and path-like tokens.
 */
export function referencedSlugs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(WIKI_LINK_RE)) out.add(normalizeSlug(m[1]));
  for (const m of text.matchAll(NOTE_URI_RE)) {
    try {
      out.add(normalizeSlug(decodeURIComponent(m[1])));
    } catch {
      out.add(normalizeSlug(m[1]));
    }
  }
  for (const m of text.matchAll(PATH_RE)) out.add(normalizeSlug(m[0]));
  return out;
}

/** Every string inside `value`, object keys included, depth-first. */
export function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...collectStrings(v)]);
  }
  return [];
}

/**
 * What a write would send: free text, slugs it names outright (e.g. `related`),
 * and, for a note write, the slug it is written to.
 */
export interface Outgoing {
  texts: string[];
  links: string[];
  path?: string;
}

/** One personal note, or a personal vault's context file. */
export interface PersonalSource {
  vault: string;
  slug: string;
  /** How the source is named in a match; defaults to the slug. */
  label?: string;
  text: string;
}

export type PrivacyMatch =
  | { kind: 'link'; vault: string; slug: string }
  | { kind: 'path'; vault: string; slug: string }
  | { kind: 'verbatim'; vault: string; source: string; excerpt: string };

function linksOf(outgoing: Outgoing): Set<string> {
  const out = new Set(outgoing.links.map(normalizeSlug));
  for (const t of outgoing.texts) for (const s of referencedSlugs(t)) out.add(s);
  return out;
}

function windowsOf(texts: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of texts) {
    for (const tokens of tokenBlocks(t)) {
      for (let i = 0; i + CHUNK_TOKENS <= tokens.length; i++) {
        const window = tokens.slice(i, i + CHUNK_TOKENS);
        out.set(window.join(' '), window);
      }
    }
  }
  return out;
}

/** The first run of `windows` found in `text`, as its joined key. */
function firstMatch(text: string, windows: Map<string, string[]>, firstTokens: Set<string>): string | undefined {
  for (const tokens of tokenBlocks(text)) {
    for (let i = 0; i + CHUNK_TOKENS <= tokens.length; i++) {
      if (!firstTokens.has(tokens[i])) continue;
      const key = tokens.slice(i, i + CHUNK_TOKENS).join(' ');
      if (windows.has(key)) return key;
    }
  }
  return undefined;
}

/**
 * Matches between `outgoing` and the personal `sources`. Links and chunks
 * already present in `previous` (the stored version of the same note) are not
 * reported again, so existing content doesn't re-trigger every edit.
 */
export function checkOutgoing(outgoing: Outgoing, sources: PersonalSource[], previous?: Outgoing): PrivacyMatch[] {
  const matches: PrivacyMatch[] = [];

  // Slugs compare case-insensitively; a match reports the personal note's own spelling.
  const personalSlugs = new Map<string, PersonalSource>();
  for (const s of sources) {
    const key = normalizeSlug(s.slug);
    if (!personalSlugs.has(key)) personalSlugs.set(key, s);
  }
  if (outgoing.path !== undefined) {
    const key = normalizeSlug(outgoing.path);
    const source = personalSlugs.get(key);
    const priorPath = previous?.path !== undefined ? normalizeSlug(previous.path) : undefined;
    if (source && priorPath !== key) matches.push({ kind: 'path', vault: source.vault, slug: source.slug });
  }
  const priorLinks = previous ? linksOf(previous) : new Set<string>();
  for (const slug of linksOf(outgoing)) {
    const source = personalSlugs.get(slug);
    if (source && !priorLinks.has(slug)) matches.push({ kind: 'link', vault: source.vault, slug: source.slug });
  }

  const windows = windowsOf(outgoing.texts);
  if (previous) for (const key of windowsOf(previous.texts).keys()) windows.delete(key);
  if (windows.size === 0) return matches;
  const firstTokens = new Set([...windows.values()].map((w) => w[0]));

  let verbatim = 0;
  for (const source of sources) {
    if (verbatim >= MAX_VERBATIM_MATCHES) break;
    const excerpt = firstMatch(source.text, windows, firstTokens);
    if (excerpt !== undefined) {
      matches.push({ kind: 'verbatim', vault: source.vault, source: source.label ?? source.slug, excerpt });
      verbatim++;
    }
  }
  return matches;
}

/**
 * A token naming exactly this content, so an approval can't carry over to
 * different content. Keyed with `secret`, so only the process holding it, which
 * issues the token in a held result, can produce a valid one.
 */
export function holdToken(content: unknown, secret: Buffer): string {
  return `hold-${createHmac('sha256', secret).update(JSON.stringify(content)).digest('hex').slice(0, 16)}`;
}

export function describeMatch(m: PrivacyMatch): string {
  switch (m.kind) {
    case 'link':
      return `link to personal note "${m.slug}" (vault "${m.vault}")`;
    case 'path':
      return `station path matches personal note "${m.slug}" (vault "${m.vault}")`;
    case 'verbatim':
      return `verbatim text from "${m.source}" (vault "${m.vault}"): "${m.excerpt}"`;
  }
}
