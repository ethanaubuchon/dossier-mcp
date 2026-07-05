export interface NoteFrontmatter {
  title: string;
  date: string;
  tags: string[];
  related: string[];
  [key: string]: unknown;
}

export interface Note {
  slug: string;
  frontmatter: NoteFrontmatter;
  content: string;
  raw: string;
}

export interface NoteListItem {
  slug: string;
  frontmatter: NoteFrontmatter;
}

export interface SearchResult {
  slug: string;
  frontmatter: NoteFrontmatter;
  score: number;
  excerpt: string;
}

export interface Config {
  notesDir: string;
  defaultExcludeTags: string[];
}
