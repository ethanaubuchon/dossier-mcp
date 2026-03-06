export interface NoteFrontmatter {
  title: string;
  date: string;
  tags: string[];
  related: string[];
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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
}

export interface Config {
  notesDir: string;
  apiKey: string;
  provider: 'anthropic';
  model: string;
  frontmatterTemplate: string;
}
