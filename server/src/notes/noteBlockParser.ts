/**
 * Parses <note>...</note> blocks from AI response text.
 *
 * Expected format:
 * <note>
 * title: "Note Title"
 * tags: [tag1, tag2]
 * related: [slug1, slug2]
 * ---
 * # Note Title
 * Markdown content here.
 * </note>
 */

export interface ParsedNoteBlock {
  title: string;
  tags: string[];
  related: string[];
  content: string;
  slug?: string;
}

export function parseNoteBlocks(text: string): ParsedNoteBlock[] {
  const blocks: ParsedNoteBlock[] = [];
  const regex = /<note>([\s\S]*?)<\/note>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const block = parseBlock(match[1].trim());
    if (block) blocks.push(block);
  }

  return blocks;
}

function parseBlock(raw: string): ParsedNoteBlock | null {
  // Split at the --- separator between metadata and content
  const sepIdx = raw.indexOf('\n---\n');
  if (sepIdx === -1) return null;

  const metaSection = raw.slice(0, sepIdx).trim();
  const content = raw.slice(sepIdx + 5).trim();

  if (!content) return null;

  const title = extractString(metaSection, 'title');
  if (!title) return null;

  const tags = extractArray(metaSection, 'tags');
  const related = extractArray(metaSection, 'related');

  return { title, tags, related, content };
}

function extractString(meta: string, key: string): string {
  const match = meta.match(new RegExp(`^${key}:\\s*"([^"]*)"`, 'm'));
  if (match) return match[1];
  const bareMatch = meta.match(new RegExp(`^${key}:\\s*(.+)`, 'm'));
  return bareMatch ? bareMatch[1].trim() : '';
}

function extractArray(meta: string, key: string): string[] {
  const match = meta.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}
